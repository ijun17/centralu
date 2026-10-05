import { afterEach, describe, expect, it } from 'vitest'
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@cc/protocol'
import { acquireInstanceLock } from '../packages/agent-host/src/dev-services/instance-lock.js'
import { versionMismatchMessage } from '../packages/agent-host/src/transport/server.js'
import {
  connectionLine,
  DEFAULT_SERVE_PORT,
  ensureServeState,
  hostCommand,
  hostEnv,
  launcherScript,
  ensureLauncher,
  mismatchServerVersion,
  parseServeArgs,
  readServeState,
  readyPort,
  recordServePort,
  rotateServeToken,
  SERVE_STATE_FILE,
  serveDataDir,
  // @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
} from '../packaging/npm/centralu/bin/serve.mjs'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { hostDirIn } from '../packaging/npm/centralu/bin/platform.mjs'

/**
 * `centralu serve` (#82): the host without the app, on a machine the app reaches over SSH. The
 * client runs `centralu serve --connection` there and builds its tunnel and its hello from the
 * answer, so the shape of that line and the token's handling are an interface, tested here.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'packaging/npm/centralu/bin/centralu.mjs')
const SOURCE_HOST = join(ROOT, 'packages/agent-host/src/main.ts')
const POSIX = process.platform !== 'win32'

const dirs: string[] = []
const started: ChildProcess[] = []
const tempDir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'cc-serve-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  // Only processes this file started; anything left after a failed test is ended here
  for (const c of started.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('serve arguments', () => {
  it('starts in the foreground with no port given by default', () => {
    expect(parseServeArgs([])).toEqual({ mode: 'serve', port: null })
  })

  it('takes a port as `--port n` or `--port=n`', () => {
    expect(parseServeArgs(['--port', '9000'])).toEqual({ mode: 'serve', port: 9000 })
    expect(parseServeArgs(['--port=9001'])).toEqual({ mode: 'serve', port: 9001 })
  })

  it.each([['0'], ['65536'], ['abc'], ['-1'], ['80.5']])('refuses the port %j', (raw) => {
    expect(parseServeArgs(['--port', raw]).error).toMatch(/between 1 and 65535/)
  })

  it('refuses `--port` with nothing after it', () => {
    expect(parseServeArgs(['--port']).error).toMatch(/got nothing/)
  })

  it('refuses an unknown option instead of ignoring it', () => {
    expect(parseServeArgs(['--host', '0.0.0.0']).error).toMatch(/unknown option for serve: --host/)
  })

  it('answers `--connection` and `--rotate-token` as their own commands', () => {
    expect(parseServeArgs(['--connection'])).toEqual({ mode: 'connection', port: null })
    expect(parseServeArgs(['--rotate-token'])).toEqual({ mode: 'rotate', port: null })
    expect(parseServeArgs(['--connection', '--rotate-token']).error).toMatch(/separate commands/)
  })

  it('does not let `--connection` name a port, since it reports the one serve uses', () => {
    expect(parseServeArgs(['--connection', '--port', '9000']).error).toMatch(/reports the port serve listens on/)
  })

  it('shows help for --help', () => {
    expect(parseServeArgs(['--help']).mode).toBe('help')
  })
})

describe('the data folder and the state file', () => {
  it('is ~/.centralu unless CC_DATA_DIR says otherwise', () => {
    expect(serveDataDir({}, '/home/me')).toBe(join('/home/me', '.centralu'))
    expect(serveDataDir({ CC_DATA_DIR: '/srv/cc' }, '/home/me')).toBe('/srv/cc')
  })

  it.skipIf(!POSIX)('creates the token file readable by its owner only (0600)', () => {
    const d = tempDir()
    ensureServeState(d)
    expect(statSync(join(d, SERVE_STATE_FILE)).mode & 0o777).toBe(0o600)
  })

  it.skipIf(!POSIX)('narrows a token file that became readable by others back to 0600', () => {
    const d = tempDir()
    ensureServeState(d)
    chmodSync(join(d, SERVE_STATE_FILE), 0o644)
    ensureServeState(d)
    expect(statSync(join(d, SERVE_STATE_FILE)).mode & 0o777).toBe(0o600)
  })

  it('generates the token once and keeps it across starts and port changes', () => {
    const d = tempDir()
    const first = ensureServeState(d)
    expect(first.token.length).toBeGreaterThanOrEqual(32)
    expect(first.port).toBeNull()
    recordServePort(d, 9100)
    expect(ensureServeState(d)).toEqual({ token: first.token, port: 9100 })
  })

  it('replaces the token only when asked, keeping the port', () => {
    const d = tempDir()
    const first = ensureServeState(d)
    recordServePort(d, 9200)
    const after = rotateServeToken(d)
    expect(after.token).not.toBe(first.token)
    expect(after.port).toBe(9200)
    expect(readServeState(d)).toEqual(after)
  })

  it('refuses to overwrite a state file it cannot read, since a client may hold that token', () => {
    const d = tempDir()
    writeFileSync(join(d, SERVE_STATE_FILE), 'not json')
    expect(() => ensureServeState(d)).toThrow(/not a serve state file/)
    expect(readFileSync(join(d, SERVE_STATE_FILE), 'utf8')).toBe('not json')
  })
})

describe('the connection line', () => {
  it('has exactly the fields the client reads, in one JSON object', () => {
    const line = connectionLine({ port: 17175, token: 't', version: '1.2.3', protocolVersion: 1, dataDir: '/d', hostRunning: false })
    expect(JSON.parse(line)).toEqual({ v: 1, port: 17175, token: 't', version: '1.2.3', protocolVersion: 1, dataDir: '/d', hostRunning: false })
    expect(line).not.toContain('\n')
  })

  it('has a default port below the ephemeral ranges and the host’s view origin ports', () => {
    expect(DEFAULT_SERVE_PORT).toBeLessThan(20000)
    expect(DEFAULT_SERVE_PORT).toBeGreaterThan(1024)
  })
})

describe('how the host is started', () => {
  const env = { PATH: '/usr/bin', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', CC_KEEPER: '1', CC_DEV: '1', CC_HOST_TOKEN: 'old' }

  it('passes the token in the environment, never on the command line', () => {
    const e = hostEnv(env, { token: 'secret-token', dataDir: '/d', version: '1.0.0', hostDir: '/h' })
    expect(e.CC_HOST_TOKEN).toBe('secret-token')
    const plan = hostCommand('/usr/bin/node', '/h/main.mjs', { port: 17175, dataDir: '/d', platform: 'linux' })
    expect(plan.args.join(' ')).not.toContain('secret-token')
    expect(plan.args).not.toContain('--token')
  })

  it('starts the host with no display and none of the keeper’s or dev mode’s variables', () => {
    const e = hostEnv(env, { token: 't', dataDir: '/d', version: '1.0.0', hostDir: '/h' })
    for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'CC_KEEPER', 'CC_DEV']) expect(e[k]).toBeUndefined()
    expect(e.CC_DATA_DIR).toBe('/d')
    expect(e.PATH).toBe('/usr/bin')
    expect(JSON.parse(e.CC_HOST_SOURCE)).toEqual({ version: '1.0.0', bundlePath: '/h' })
  })

  it('pins the data folder, watches this launcher, and gets its own process group on POSIX', () => {
    const plan = hostCommand('/usr/bin/node', '/h/main.mjs', { port: 9000, dataDir: '/d', platform: 'linux' })
    expect(plan.args).toEqual(['/h/main.mjs', '--port', '9000', '--db', join('/d', 'store.db'), '--watch-parent'])
    expect(plan.detached).toBe(true)
    expect(hostCommand('node', 'C:\\h\\main.mjs', { port: 9000, dataDir: 'C:\\d', platform: 'win32' }).detached).toBe(false)
  })

  it('loads TypeScript only for a source entry', () => {
    expect(hostCommand('node', '/src/main.ts', { port: 1, dataDir: '/d', platform: 'darwin' }).args.slice(0, 3)).toEqual([
      '--import',
      'tsx',
      '/src/main.ts',
    ])
  })

  it('reads the port from the ready line only', () => {
    expect(readyPort(JSON.stringify({ ready: true, port: 4242, token: 'x', db: '/d' }))).toBe(4242)
    expect(readyPort('[agent-host] Another Centralu is already using this data (pid 1).')).toBeNull()
    expect(readyPort(JSON.stringify({ swap: { keepsAgents: false } }))).toBeNull()
  })

  it('finds the bundled host in each platform package', () => {
    expect(hostDirIn('darwin', '/p/Centralu.app')).toBe('/p/Centralu.app/Contents/Resources/resources/host')
    expect(hostDirIn('linux', '/p/Centralu.AppImage')).toBe('/p/host')
    expect(hostDirIn('win32', 'C:\\p\\Centralu')).toBe('C:\\p\\Centralu\\resources\\host')
  })
})

describe('the version refusal', () => {
  it('names the host’s protocol so --connection can report it, in either wording', () => {
    expect(mismatchServerVersion(versionMismatchMessage(3, 2))).toBe(3)
    expect(mismatchServerVersion('Protocol version mismatch (server 1, client 2)')).toBe(1)
    expect(mismatchServerVersion('something else')).toBeNull()
  })
})

describe('the launcher for non-interactive SSH shells', () => {
  it.skipIf(!POSIX)('runs the CLI by absolute paths, even with quotes and spaces in them', () => {
    const d = tempDir()
    const cli = join(d, "it's a cli.mjs")
    writeFileSync(cli, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
    const file = ensureLauncher(d, { cliPath: cli })
    expect(file).toBe(join(d, 'bin', 'centralu'))
    expect(statSync(file).mode & 0o777).toBe(0o755)
    // An empty PATH stands in for the SSH shell that has neither npm's folder nor node
    const r = spawnSync('/bin/sh', [file, 'serve', '--connection'], { encoding: 'utf8', env: { PATH: '' } })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(['serve', '--connection'])
  })

  it('writes a .cmd on Windows that passes every argument through', () => {
    const cmd = launcherScript('win32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\npm\\centralu.mjs')
    expect(cmd).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\centralu.mjs" %*')
  })
})

/** A port nobody is listening on right now */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

function cliEnv(dataDir: string): NodeJS.ProcessEnv {
  return { ...process.env, CC_DATA_DIR: dataDir, CENTRALU_HOST_ENTRY: SOURCE_HOST, CI: '1' }
}

/** `centralu serve <args>` in the background, its output collected */
function serve(dataDir: string, args: string[]) {
  const child = spawn(process.execPath, [CLI, 'serve', ...args], { cwd: ROOT, env: cliEnv(dataDir), stdio: ['ignore', 'pipe', 'pipe'] })
  started.push(child)
  const out = { stdout: '', stderr: '' }
  child.stdout!.on('data', (b) => (out.stdout += String(b)))
  child.stderr!.on('data', (b) => (out.stderr += String(b)))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const until = (pattern: RegExp) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (pattern.test(out.stderr)) {
          child.stderr!.off('data', check)
          resolve()
        }
      }
      child.stderr!.on('data', check)
      child.once('exit', () => (pattern.test(out.stderr) ? resolve() : reject(new Error(`serve exited before ${pattern}:\n${out.stderr}`))))
      check()
    })
  return { child, out, exited, until }
}

async function connection(dataDir: string): Promise<Record<string, unknown>> {
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile(process.execPath, [CLI, 'serve', '--connection'], { cwd: ROOT, env: cliEnv(dataDir) }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  )
  const lines = stdout.trim().split('\n')
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0]!) as Record<string, unknown>
}

/**
 * A hello with the token, answered by hello_ok or by whatever closed the socket. Node's own
 * WebSocket (22.4+), the same client `--connection` probes with; `ws` is not a root dependency.
 */
async function hello(port: number, token: string): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  try {
    return await new Promise((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: PROTOCOL_VERSION }))
      ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)) as Record<string, unknown>)
      ws.onclose = (ev) => reject(new Error(`closed ${ev.code}`))
    })
  } finally {
    ws.close()
  }
}

describe('centralu serve, end to end (a host from source, a temporary data folder)', () => {
  it.skipIf(!POSIX)(
    'serves on 127.0.0.1 with its token, reports itself in --connection, refuses a second serve, and stops on SIGTERM',
    async () => {
      const d = tempDir()
      const before = await connection(d)
      expect(before).toMatchObject({ v: 1, port: DEFAULT_SERVE_PORT, protocolVersion: PROTOCOL_VERSION, dataDir: d, hostRunning: false })

      const port = await freePort()
      const s = serve(d, ['--port', String(port)])
      await s.until(/listening on 127\.0\.0\.1:\d+/)

      const info = await connection(d)
      expect(info).toMatchObject({ v: 1, port, token: before.token, protocolVersion: PROTOCOL_VERSION, dataDir: d, hostRunning: true })

      const ok = await hello(port, String(info.token))
      expect(ok).toMatchObject({ kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION })
      await expect(hello(port, 'not-the-token')).rejects.toThrow(/closed 4001/)

      const second = serve(d, [])
      expect(await second.exited).toBe(1)
      expect(second.out.stderr).toContain(`centralu serve is already running for ${d} on 127.0.0.1:${port}`)

      s.child.kill('SIGTERM')
      expect(await s.exited).toBe(0)
      expect(s.out.stderr).toContain('[agent-host] shutting down')
      // The ready line carries the token; serve passes it to no one
      expect(s.out.stdout).toBe('')
      expect(s.out.stderr).not.toContain(String(info.token))
      expect((await connection(d)).hostRunning).toBe(false)
    },
    90_000,
  )

  it.skipIf(!POSIX)(
    'passes Ctrl+C (SIGINT) to the host, which shuts down cleanly',
    async () => {
      const d = tempDir()
      const s = serve(d, ['--port', String(await freePort())])
      await s.until(/listening on 127\.0\.0\.1:\d+/)
      // At once, not after a pause: the host is still starting its services right after the ready
      // line, and a signal there used to end it by the kernel's default, skipping the shutdown
      s.child.kill('SIGINT')
      expect(await s.exited).toBe(0)
      expect(s.out.stderr).toContain('[agent-host] shutting down')
    },
    90_000,
  )

  it.skipIf(!POSIX)(
    'takes the host down when the launcher itself is killed, instead of leaving it unsupervised',
    async () => {
      const d = tempDir()
      const s = serve(d, ['--port', String(await freePort())])
      await s.until(/listening on 127\.0\.0\.1:\d+/)
      const hostPid = (JSON.parse(readFileSync(join(d, 'host.lock'), 'utf8')) as { pid: number }).pid
      expect(hostPid).not.toBe(s.child.pid)
      s.child.kill('SIGKILL')
      await s.exited
      // The host is not our child: poll for it to go, with a generous bound for a loaded machine
      const deadline = Date.now() + 30_000
      let alive = true
      while (alive && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        try {
          process.kill(hostPid, 0)
        } catch {
          alive = false
        }
      }
      if (alive) process.kill(hostPid, 'SIGKILL') // started by this test, so ours to end
      expect(alive).toBe(false)
    },
    90_000,
  )

  it.skipIf(!POSIX)(
    'refuses to start on a data folder another host owns, and names its pid',
    async () => {
      const d = tempDir()
      // This test process stands in for the Centralu app that owns the folder
      const held = acquireInstanceLock(join(d, 'store.db'))
      expect(held.ok).toBe(true)
      try {
        const s = serve(d, ['--port', String(await freePort())])
        expect(await s.exited).toBe(1)
        expect(s.out.stderr).toContain(`belongs to another Centralu host (pid ${process.pid})`)
      } finally {
        if (held.ok) held.release()
      }
    },
    90_000,
  )
})
