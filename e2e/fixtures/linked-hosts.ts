import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Store } from '../../packages/agent-host/src/dev-services/store.js'
import { freePort } from './real-host.js'

/**
 * Two hosts for the linked-hosts e2e (#82): a remote and a hub linked to it as machine `m1`
 * (`linked-host-main.ts`). Each has its own temporary data folder, `HOME` and store, so neither
 * the person's data nor their CLI logins are touched. The page reaches the hub through the TCP
 * relay on 5180 (`Relay` in real-host.ts), the address the linked vite server is built with.
 */

const root = fileURLToPath(new URL('../../', import.meta.url))

export const LINKED_TOKEN = 'e2e-linked-token'
export const LINKED_UI_ORIGIN = 'http://127.0.0.1:5179'
export const LINKED_RELAY_PORT = 5180
export const MACHINE = 'm1'

export type Side = { dir: string; db: string; home: string; project: string }

function side(name: string): Side {
  const dir = mkdtempSync(join(tmpdir(), `centralu-e2e-linked-${name}-`))
  const s = { dir, db: join(dir, 'data', 'store.db'), home: join(dir, 'home'), project: join(dir, `${name}-project`) }
  mkdirSync(join(dir, 'data'))
  mkdirSync(s.home)
  mkdirSync(s.project)
  return s
}

export type LinkedHost = { port: number; child: ChildProcess; stderr: () => string; kill(signal?: NodeJS.Signals): Promise<void> }

export async function startLinkedHost(s: Side, port: number, link?: { port: number }): Promise<LinkedHost> {
  const args = ['--import', 'tsx', 'e2e/fixtures/linked-host-main.ts', '--port', String(port), '--db', s.db, '--token', LINKED_TOKEN]
  if (link) args.push('--link', JSON.stringify({ id: MACHINE, name: 'Remote box', port: link.port, token: LINKED_TOKEN }))
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, CC_DATA_DIR: join(s.dir, 'data'), HOME: s.home, CC_HOST_ALLOWED_ORIGINS: LINKED_UI_ORIGIN, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr!.on('data', (d: Buffer) => (stderr += String(d)))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`linked host did not become ready\n${stderr}`)), 30_000)
    child.once('exit', (code) => reject(new Error(`linked host exited (${code}) before it was ready\n${stderr}`)))
    createInterface({ input: child.stdout! }).on('line', (line) => {
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
    stderr: () => stderr,
    async kill(signal: NodeJS.Signals = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill(signal)
      await exited
    },
  }
}

export type LinkedPair = { hub: LinkedHost; remote: LinkedHost; hubSide: Side; remoteSide: Side; remotePort: number; cleanup(): Promise<void> }

/** Seeds both stores, then starts the remote and the hub linked to it */
export async function startPair(): Promise<LinkedPair> {
  const hubSide = side('hub')
  const remoteSide = side('remote')
  for (const [s, id, name] of [
    [hubSide, 'p-hub', 'hub-project'],
    [remoteSide, 'p-remote', 'remote-project'],
  ] as const) {
    const store = new Store(s.db)
    try {
      store.setAppSetting('updates.auto', 'false')
      store.addProject({ id, path: s.project, name })
    } finally {
      store.close()
    }
  }
  const remotePort = await freePort()
  const remote = await startLinkedHost(remoteSide, remotePort)
  const hub = await startLinkedHost(hubSide, await freePort(), { port: remotePort })
  return {
    hub,
    remote,
    hubSide,
    remoteSide,
    remotePort,
    async cleanup() {
      await hub.kill()
      await remote.kill()
      rmSync(hubSide.dir, { recursive: true, force: true })
      rmSync(remoteSide.dir, { recursive: true, force: true })
    },
  }
}
