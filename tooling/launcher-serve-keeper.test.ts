import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@cc/protocol'
import { HostServer } from '../packages/agent-host/src/transport/server.js'
import { readCredentialFile } from '../packages/agent-host/src/lifecycle/serve-credentials.js'
import { SLOW } from './test-timing.js'
import { freePort } from './free-port.js'
import {
  askKeeperToStop,
  connectionLine,
  ensureServeState,
  keeperCommand,
  keeperExe,
  keeperInfo,
  keeperPidOf,
  processStartTime,
  readServePid,
  readServeState,
  recordServePort,
  runServe,
  SERVE_PID_FILE,
  SERVE_STATE_FILE,
  stopServedHost,
  // @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
} from '../packaging/npm/centralu/bin/serve.mjs'

/**
 * The headless keeper `centralu serve` starts on Linux in the host's place (docs/plans/remote-keeper.md §8, step 3): when
 * `serve` chooses it, what it hands it, how `--connection`, `--stop` and the sign-in hand-over reach it. The keeper and the
 * host in these tests are stand-ins: the real ones run together in `scripts/keeper-integration.mjs` (`keeper e2e (linux)`).
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_HOST = join(ROOT, 'packages/agent-host/src/main.ts')
const POSIX = process.platform !== 'win32'

const dirs: string[] = []
const started: ChildProcess[] = []
const servers: Server[] = []
const tempDir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'cc-sk-')))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const c of started.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe('which of the two serve starts (keeperExe)', () => {
  const entry = join('/r', 'host-linux-x64', 'host', 'main.mjs')
  const exe = join('/r', 'host-linux-x64', 'centralu-keeper')
  const there = (p: string) => p === exe

  it('chooses the keeper beside the host folder on Linux', () => {
    expect(keeperExe(entry, { platform: 'linux', env: {}, exists: there })).toBe(exe)
    expect(keeperExe(entry, { platform: 'linux', env: { CENTRALU_KEEPER: 'on' }, exists: there })).toBe(exe)
  })

  it('chooses the host when the file is not there, the entry is source, the system is not Linux, or CENTRALU_KEEPER is off', () => {
    expect(keeperExe(entry, { platform: 'linux', env: {}, exists: () => false })).toBeNull()
    expect(keeperExe(entry, { platform: 'linux', env: { CENTRALU_KEEPER: 'off' }, exists: there })).toBeNull()
    expect(keeperExe(entry, { platform: 'win32', env: {}, exists: there })).toBeNull()
    expect(keeperExe(entry, { platform: 'darwin', env: {}, exists: there })).toBeNull()
    expect(keeperExe(join('/r', 'host-linux-x64', 'src', 'main.ts'), { platform: 'linux', env: {}, exists: () => true })).toBeNull()
  })

  it('hands the keeper the port, the Node, the host folder and the version, and keeps it in a group of its own', () => {
    expect(keeperCommand(exe, entry, { port: 4242, dataDir: '/d', version: '1.2.3', execPath: '/n/node' })).toEqual({
      command: exe,
      args: ['--headless', '--data-dir', '/d', '--port', '4242', '--node', '/n/node', '--host-source', dirname(entry), '--app-version', '1.2.3'],
      detached: true,
    })
  })
})

describe.skipIf(!POSIX)('centralu serve with a keeper (a stand-in keeper and host, a temporary data folder)', () => {
  /**
   * A host-only package as a hub installs it: `host/main.mjs` and, when asked, `centralu-keeper`. The keeper stand-in
   * writes what it was started with to `started.json`, says it is ready on the port it was given and goes when `stop`
   * appears in the folder; the host stand-in does the same without arguments of a keeper's.
   */
  function rig(withKeeper: boolean) {
    const d = tempDir()
    const pkg = join(d, 'pkg')
    mkdirSync(join(pkg, 'host'), { recursive: true })
    const entry = join(pkg, 'host', 'main.mjs')
    writeFileSync(join(pkg, 'host', 'bundle-info.json'), JSON.stringify({ protocolVersion: PROTOCOL_VERSION }))
    const body = (who: string) => `
import { existsSync, writeFileSync } from 'node:fs'
const at = process.argv.indexOf('--port')
process.stdin.once('data', (line) => {
  const port = Number(process.argv[at + 1])
  writeFileSync(${JSON.stringify(join(d, `started-${who}.json`))}, JSON.stringify({ args: process.argv.slice(2), line: String(line).trim(), env: process.env }))
  console.error('${who} says hello on stderr')
  console.log(JSON.stringify({ ready: true, port, hostPid: process.pid, token: 'must-not-matter' }))
  const timer = setInterval(() => { if (existsSync(${JSON.stringify(join(d, 'stop'))})) { clearInterval(timer); process.exit(0) } }, 50)
})
`
    writeFileSync(entry, body('host'))
    if (withKeeper) {
      const keeper = join(pkg, 'centralu-keeper')
      writeFileSync(keeper, `#!${process.execPath}\n${body('keeper')}`)
      chmodSync(keeper, 0o755)
    }
    return { d, entry, startedBy: (who: string) => (existsSync(join(d, `started-${who}.json`)) ? JSON.parse(readFileSync(join(d, `started-${who}.json`), 'utf8')) : null) }
  }

  const waitFor = async (what: string, ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 50))
    expect(ok(), what).toBe(true)
  }

  const run = (r: ReturnType<typeof rig>, env: Record<string, string>, port: number) =>
    runServe({ env: { ...process.env, CC_DATA_DIR: r.d, ...env }, home: r.d, entry: r.entry, version: '1.2.3', cliPath: null, port, platform: 'linux', execPath: process.execPath }) as Promise<number>

  it(
    'starts the keeper instead of the host, with serve’s port, key and variables, records what it says, and stays its parent',
    async () => {
      const r = rig(true)
      const port = await freePort()
      const done = run(r, {}, port)
      await waitFor('the keeper started', () => r.startedBy('keeper') !== null)
      const k = r.startedBy('keeper')
      expect(r.startedBy('host')).toBeNull()
      expect(k.args).toEqual(['--headless', '--data-dir', r.d, '--port', String(port), '--node', process.execPath, '--host-source', dirname(r.entry), '--app-version', '1.2.3'])
      // The first line on its stdin is the key, as the host gets it: never in an argument or the environment
      const state = readServeState(r.d)
      expect(JSON.parse(k.line)).toEqual({ key: state.key })
      expect(JSON.stringify(k.args)).not.toContain(state.key)
      expect(JSON.stringify(k.env)).not.toContain(state.key)
      // What it hands every host it starts (CC_SERVE, where serve.json is, who asked for it) comes through its environment
      expect(k.env).toMatchObject({ CC_SERVE: '1', CC_DATA_DIR: r.d, CC_SERVE_STATE: join(r.d, SERVE_STATE_FILE), CC_HOST_TOKEN_ON_STDIN: '1' })
      expect(k.env.CC_KEEPER).toBeUndefined()
      // Ready: the port is recorded, and serve.pid names the keeper beside the host the keeper says it started
      await waitFor('the port recorded', () => readServeState(r.d).port === port)
      await waitFor('serve.pid names the keeper', () => readServePid(r.d)?.keeperPid != null && readServePid(r.d)?.hostPid != null)
      const pids = readServePid(r.d)
      expect(pids).toMatchObject({ pid: process.pid, port })
      expect(pids.keeperPid).toBe(pids.hostPid)
      // Its stderr is the keeper's log
      await waitFor('keeper.log', () => existsSync(join(r.d, 'keeper.log')) && readFileSync(join(r.d, 'keeper.log'), 'utf8').includes('keeper says hello'))
      // The launcher ends with the keeper, and with its exit code
      writeFileSync(join(r.d, 'stop'), '')
      expect(await done).toBe(0)
      expect(readServePid(r.d)).toBeNull()
    },
    30_000 * SLOW,
  )

  it(
    'starts the host as before with CENTRALU_KEEPER=off, or with no keeper file',
    async () => {
      for (const [withKeeper, env] of [
        [true, { CENTRALU_KEEPER: 'off' }],
        [false, {}],
      ] as const) {
        const r = rig(withKeeper)
        const done = run(r, env, await freePort())
        await waitFor('the host started', () => r.startedBy('host') !== null)
        expect(r.startedBy('keeper')).toBeNull()
        const h = r.startedBy('host')
        expect(h.args).toContain('--watch-parent')
        expect(h.args).not.toContain('--headless')
        await waitFor('serve.pid', () => readServePid(r.d)?.hostPid != null)
        expect(readServePid(r.d)?.keeperPid).toBeNull()
        writeFileSync(join(r.d, 'stop'), '')
        expect(await done).toBe(0)
      }
    },
    30_000 * SLOW,
  )
})

describe('--connection reports the keeper', () => {
  it('names it on the line, additively, and not when there is none', () => {
    const base = { port: 4242, version: '1.2.3', protocolVersion: PROTOCOL_VERSION, dataDir: '/d', hostRunning: true }
    expect(JSON.parse(connectionLine({ ...base, keeper: { pid: 77, build: '1.2.3' } })).keeper).toEqual({ pid: 77, build: '1.2.3' })
    expect(JSON.parse(connectionLine(base))).not.toHaveProperty('keeper')
  })

  it.skipIf(!POSIX)('believes serve.pid’s keeper only while keeper.lock agrees and it is alive, and asks it for its build', async () => {
    const d = tempDir()
    const alive = process.pid
    writeFileSync(join(d, 'keeper.lock'), `${alive}\n`)
    expect(keeperPidOf(d, { keeperPid: alive })).toBe(alive)
    expect(keeperPidOf(d, { keeperPid: alive, hostPid: 1 })).toBe(alive)
    expect(keeperPidOf(d, { keeperPid: null })).toBeNull()
    expect(keeperPidOf(d, null)).toBeNull()
    writeFileSync(join(d, 'keeper.lock'), `${alive + 1}\n`)
    expect(keeperPidOf(d, { keeperPid: alive }), 'a stale serve.pid is not a keeper').toBeNull()
    writeFileSync(join(d, 'keeper.lock'), `${alive}\n`)
    const asked: unknown[] = []
    const ask = async (_: string, req: unknown) => (asked.push(req), { ok: true, view: { keeper: { version: '1.2.3' } } })
    expect(await keeperInfo(d, { keeperPid: alive }, ask)).toEqual({ pid: alive, build: '1.2.3' })
    expect(asked).toEqual([{ op: 'status' }])
    // Alive and silent: still reported, by pid
    expect(await keeperInfo(d, { keeperPid: alive }, async () => null)).toEqual({ pid: alive })
    expect(await keeperInfo(d, { keeperPid: null }, ask)).toBeNull()
  })
})

describe.skipIf(!POSIX)('--stop and the sign-in hand-over ask the keeper (stop { ifIdle })', () => {
  /** A unix socket answering the keeper's control protocol: each line it is asked is kept, and `answer` is what it says */
  async function fakeKeeperSocket(dataDir: string, answer: (req: Record<string, unknown>) => Record<string, unknown>) {
    const asked: Record<string, unknown>[] = []
    const server = createServer((c) => {
      let buf = ''
      c.on('data', (b) => {
        buf += b
        if (!buf.includes('\n')) return
        const req = JSON.parse(buf.slice(0, buf.indexOf('\n'))) as Record<string, unknown>
        asked.push(req)
        c.write(`${JSON.stringify(answer(req))}\n`)
      })
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(join(dataDir, 'keeper.sock'), () => r()))
    return asked
  }

  function idle(): ChildProcess {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' })
    started.push(c)
    return c
  }

  /** A folder the way a running headless serve leaves it: serve.pid, keeper.lock, host.lock (by serve) and a host that answers the probe */
  async function keeperFolder(answer: (req: Record<string, unknown>) => Record<string, unknown>) {
    const d = tempDir()
    ensureServeState(d)
    recordServePort(d, await freePort())
    const state = readServeState(d)
    const [launcher, keeper, host] = [idle(), idle(), idle()]
    writeFileSync(join(d, SERVE_PID_FILE), JSON.stringify({ pid: launcher.pid, hostPid: host.pid, keeperPid: keeper.pid, port: state.port }))
    writeFileSync(join(d, 'keeper.lock'), `${keeper.pid}\n`)
    writeFileSync(join(d, 'host.lock'), JSON.stringify({ pid: host.pid, started: processStartTime(host.pid), at: Date.now(), by: 'serve' }))
    const calls: string[] = []
    const server: HostServer = new HostServer({
      port: state.port,
      token: String(state.key),
      fullCredentials: () => readCredentialFile(join(d, SERVE_STATE_FILE), (f) => readFileSync(f, 'utf8')).full,
      build: { commit: 'c', protocolVersion: PROTOCOL_VERSION, version: '1.0.0' },
      onRpc: async (method) => (calls.push(method), { ok: true }),
    })
    await server.listen()
    // The keeper said yes: the host goes, and the keeper and the launcher with it, as they do
    const stopping = (req: Record<string, unknown>) => {
      const a = answer(req)
      if (a.ok === true) setTimeout(() => void server.close().then(() => [host, keeper, launcher].forEach((c) => c.kill('SIGKILL'))), 20)
      return a
    }
    const asked = await fakeKeeperSocket(d, stopping)
    return { d, asked, calls, host, keeper, launcher, close: () => server.close() }
  }

  const stop = (f: { d: string }, o: { ifIdle?: boolean; forUpdate?: boolean }, signals: [number, string][] = []) =>
    stopServedHost({ dataDir: f.d, entry: SOURCE_HOST, platform: 'linux', timeoutMs: 5000, graceMs: 300, kill: (pid: number, sig: string) => void signals.push([pid, sig]), ...o }) as Promise<Record<string, unknown>>

  it(
    'with ifIdle, a keeper whose host says something runs is left running: busy, and nothing signalled or asked of the host',
    async () => {
      const f = await keeperFolder(() => ({ ok: false, busy: true, activity: { working: 1 }, calls: 0 }))
      const signals: [number, string][] = []
      try {
        expect(await stop(f, { ifIdle: true }, signals)).toMatchObject({ ok: false, wasRunning: true, busy: true })
        expect(f.asked).toEqual([{ op: 'stop', ifIdle: true }])
        expect(signals).toEqual([])
        expect(f.calls).not.toContain('host.stop')
        expect(f.host.exitCode).toBeNull()
      } finally {
        await f.close()
      }
    },
    30_000 * SLOW,
  )

  it(
    'stops through the keeper, not the host: ifIdle and forUpdate go to it as asked, and the host is never sent host.stop',
    async () => {
      const f = await keeperFolder(() => ({ ok: true }))
      const signals: [number, string][] = []
      try {
        expect(await stop(f, { ifIdle: true, forUpdate: true }, signals)).toMatchObject({ ok: true, wasRunning: true, how: 'asked' })
        expect(f.asked).toEqual([{ op: 'stop', ifIdle: true, forUpdate: true }])
        expect(f.calls).not.toContain('host.stop')
        expect(signals).toEqual([])
      } finally {
        await f.close()
      }
    },
    30_000 * SLOW,
  )

  it(
    'a keeper that does not answer is not the only way: serve.pid’s launcher is signalled, which the keeper takes as a stop',
    async () => {
      const f = await keeperFolder(() => ({ ok: false, error: 'no' }))
      const signals: [number, string][] = []
      try {
        const out = await stop(f, {}, signals)
        // The launcher is signalled (a stand-in cannot end the host, so this does not succeed), never the host first
        expect(signals[0]).toEqual([f.launcher.pid, 'SIGTERM'])
        expect(out.ok === true || out.ok === false).toBe(true)
        expect(String(out.message ?? '')).not.toBe('')
      } finally {
        await f.close()
      }
    },
    30_000 * SLOW,
  )

  it('askKeeperToStop reads the keeper’s answers', async () => {
    const d = tempDir()
    let reply: Record<string, unknown> = { ok: true }
    await fakeKeeperSocket(d, () => reply)
    expect(await askKeeperToStop(d, { ifIdle: true })).toEqual({ ok: true })
    reply = { ok: false, busy: true, activity: { terminals: 1 }, calls: 2 }
    expect(await askKeeperToStop(d, { ifIdle: true })).toEqual({ ok: false, busy: true, message: 'it has work running', activity: { terminals: 1 }, calls: 2 })
    reply = { ok: false, error: 'the host did not answer the idle check; nothing was stopped' }
    expect(await askKeeperToStop(d, {})).toEqual({ ok: false, message: 'the host did not answer the idle check; nothing was stopped' })
    expect(await askKeeperToStop(tempDir(), {})).toEqual({ ok: false, message: 'the keeper did not answer' })
  })
})
