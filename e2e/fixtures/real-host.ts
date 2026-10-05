import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { sessionLiveDefaults, type SessionInfo, type StoredMessage } from '@cc/protocol'
import { Store } from '../../packages/agent-host/src/dev-services/store.js'

/**
 * A real Agent Host process for the recovery e2e (#82): `main.ts` exactly as `pnpm host` runs it,
 * with everything it writes kept in a temporary folder — `--db`, `CC_DATA_DIR` and `HOME` all
 * point there, so neither the person's data folder nor their CLI logins are touched.
 *
 * The page does not talk to the host directly but through `Relay`, a TCP relay on the fixed
 * address the recovery vite server was built with (VITE_HOST_URL). That lets a test cut the
 * page's socket while the host stays up, keep the page out while the host is down, and restart the
 * host behind the same address, the way web and dev mode do.
 */

const root = fileURLToPath(new URL('../../', import.meta.url))

export const RECOVERY_TOKEN = 'e2e-recovery-token'
export const RECOVERY_UI_ORIGIN = 'http://127.0.0.1:5177'
export const RECOVERY_RELAY_PORT = 5178

export type Workspace = { dir: string; db: string; home: string; project: string; cleanup(): void }

export function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'centralu-e2e-recovery-'))
  const home = join(dir, 'home')
  const project = join(dir, 'project')
  mkdirSync(home)
  mkdirSync(project)
  mkdirSync(join(dir, 'data'))
  return { dir, db: join(dir, 'data', 'store.db'), home, project, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Writes straight into the store while no host has it open */
export function withStore(db: string, fn: (store: Store) => void): void {
  const store = new Store(db)
  try {
    fn(store)
  } finally {
    store.close()
  }
}

export function seedSession(store: Store, projectId: string, id: string, name: string): void {
  store.upsertSession({
    id,
    projectId,
    kind: 'worker',
    tool: 'claude',
    externalId: null,
    name,
    autoNamed: false,
    state: 'idle',
    lastReadSeq: 0,
    lastSeq: 0,
    createdAt: Date.now(),
    waitingSince: null,
    live: false,
    model: null,
    effort: null,
    verbosity: null,
    serviceTier: null,
    permissionPreset: 'normal',
    importedFrom: null,
    worktree: null,
    parentSessionId: null,
    scopeSessionIds: null,
    roleAppend: null,
    appId: null,
    ...sessionLiveDefaults(),
  } satisfies SessionInfo)
}

export function storedUserLine(store: Store, sessionId: string, text: string): void {
  const message: StoredMessage = { sessionId, seq: store.nextSeq(sessionId), role: 'user', kind: 'text', payload: { text }, ts: Date.now() }
  store.appendMessages([message])
}

export type RealHost = { port: number; child: ChildProcess; kill(signal?: NodeJS.Signals): Promise<void> }

export async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
  const { port } = probe.address() as { port: number }
  await new Promise<void>((r) => probe.close(() => r()))
  return port
}

export async function startHost(ws: Workspace, port: number): Promise<RealHost> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--port', String(port), '--db', ws.db, '--token', RECOVERY_TOKEN], {
    cwd: root,
    env: {
      ...process.env,
      CC_DATA_DIR: join(ws.dir, 'data'),
      HOME: ws.home,
      CC_HOST_ALLOWED_ORIGINS: RECOVERY_UI_ORIGIN,
      CI: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr!.on('data', (d: Buffer) => (stderr += String(d)))
  await new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! })
    const timer = setTimeout(() => reject(new Error(`host did not become ready\n${stderr}`)), 30_000)
    child.once('exit', (code) => reject(new Error(`host exited (${code}) before it was ready\n${stderr}`)))
    lines.on('line', (line) => {
      try {
        if ((JSON.parse(line) as { ready?: boolean }).ready) {
          clearTimeout(timer)
          resolve()
        }
      } catch {
        // Not the ready line
      }
    })
  })
  return {
    port,
    child,
    async kill(signal: NodeJS.Signals = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return
      const tree = descendants(child.pid!)
      const exited = once(child, 'exit')
      child.kill(signal)
      await exited
      await gone(tree)
    },
  }
}

/*
 * What the host started is waited for too, not only the host (#368). Its probes (`claude --version`,
 * `claude auth status`, which the window asks for through `agents.detect` on load) are not ended
 * with it, and with HOME in the workspace they write `home/.claude.json` and `home/.claude/backups/`
 * a moment after the host has exited. Removing the workspace then failed with ENOTEMPTY when a write
 * landed during the removal, and when it landed after, it made the folder again: a Mac that had run
 * the e2e suite for two days held 97 `centralu-e2e-recovery-*` folders with exactly those files.
 * The probes are left to finish rather than killed: the host leaves them alone in the real app as
 * well. Taken before the signal, while they are still under the host; afterwards they have been
 * handed to init. Unix only: these specs do not run on Windows.
 */
function descendants(root: number): number[] {
  if (process.platform === 'win32') return []
  let out = ''
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000 })
  } catch {
    return []
  }
  const kids = new Map<number, number[]>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (m) kids.set(Number(m[2]), [...(kids.get(Number(m[2])) ?? []), Number(m[1])])
  }
  const found: number[] = []
  const queue = [root]
  while (queue.length > 0) {
    for (const kid of kids.get(queue.shift()!) ?? []) {
      found.push(kid)
      queue.push(kid)
    }
  }
  return found
}

/** Waits until none of `pids` is running; the probes give up on their own after 5 s, so 15 s is generous */
async function gone(pids: number[], timeoutMs = 15_000): Promise<void> {
  const running = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  const deadline = Date.now() + timeoutMs
  while (pids.some(running)) {
    if (Date.now() > deadline) throw new Error(`the host's children ${pids.filter(running).join(', ')} were still running ${timeoutMs}ms after it exited`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** One call over the host's own protocol, straight to the host (not through the relay) */
export async function hostCall(port: number, method: string, params: unknown): Promise<{ result: unknown; currentSeq: number }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  try {
    return await new Promise((resolve, reject) => {
      let currentSeq = 0
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000)
      socket.onerror = () => reject(new Error('socket error'))
      socket.onopen = () => socket.send(JSON.stringify({ kind: 'hello', token: RECOVERY_TOKEN, protocolVersion: 1 }))
      socket.onmessage = (m) => {
        const f = JSON.parse(String(m.data)) as { kind: string; id?: string; ok?: boolean; result?: unknown; currentSeq?: number; error?: { message: string } }
        if (f.kind === 'hello_ok') {
          currentSeq = f.currentSeq ?? 0
          socket.send(JSON.stringify({ kind: 'rpc', id: 'call', method, params }))
        }
        if (f.kind === 'res' && f.id === 'call') {
          clearTimeout(timer)
          if (f.ok) resolve({ result: f.result, currentSeq })
          else reject(new Error(f.error?.message ?? 'host error'))
        }
      }
    })
  } finally {
    socket.close()
  }
}

/** The TCP relay between the page and the host */
export class Relay {
  private server: Server
  private pairs = new Set<[Socket, Socket]>()
  /** While closed, a connection is refused the moment it arrives — the page cannot reach the host */
  closed = false

  constructor(private target: () => number) {
    this.server = createServer((page) => {
      if (this.closed) {
        page.destroy()
        return
      }
      const host = createConnection({ host: '127.0.0.1', port: this.target() })
      const pair: [Socket, Socket] = [page, host]
      this.pairs.add(pair)
      const end = () => {
        page.destroy()
        host.destroy()
        this.pairs.delete(pair)
      }
      page.on('error', end).on('close', end)
      host.on('error', end).on('close', end)
      page.pipe(host)
      host.pipe(page)
    })
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
  }

  /** Cuts every open connection — a dropped socket, while the host itself stays up */
  drop(): void {
    for (const [page, host] of this.pairs) {
      page.destroy()
      host.destroy()
    }
    this.pairs.clear()
  }

  async close(): Promise<void> {
    this.drop()
    await new Promise<void>((r) => this.server.close(() => r()))
  }
}
