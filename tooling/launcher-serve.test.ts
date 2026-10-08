import { afterEach, describe, expect, it } from 'vitest'
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, copyFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@cc/protocol'
import { acquireInstanceLock } from '../packages/agent-host/src/dev-services/instance-lock.js'
import { versionMismatchMessage } from '../packages/agent-host/src/transport/server.js'
import {
  connectionLine,
  decodeChildSpec,
  DEFAULT_SERVE_PORT,
  detachHow,
  encodeChildSpec,
  installInfo,
  managedLauncherScript,
  parsePointer,
  parseWmiAnswer,
  remoteLayout,
  runDetach,
  SERVE_PID_FILE,
  windowsArg,
  wmiScript,
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

async function connection(dataDir: string, extra: NodeJS.ProcessEnv = {}): Promise<Record<string, unknown>> {
  const stdout = await new Promise<string>((resolve, reject) =>
    execFile(process.execPath, [CLI, 'serve', '--connection'], { cwd: ROOT, env: { ...cliEnv(dataDir), ...extra } }, (err, out) =>
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

describe('--detach and --stop arguments', () => {
  it('takes --detach with or without a port, and --stop without one', () => {
    expect(parseServeArgs(['--detach'])).toEqual({ mode: 'detach', port: null })
    expect(parseServeArgs(['--detach', '--port', '9000'])).toEqual({ mode: 'detach', port: 9000 })
    expect(parseServeArgs(['--stop'])).toEqual({ mode: 'stop', port: null })
    expect(parseServeArgs(['--stop', '--port', '9000']).error).toMatch(/takes no --port/)
    expect(parseServeArgs(['--detach', '--stop']).error).toMatch(/--detach and --stop are separate commands/)
  })

  it('carries only the data folder, the host entry and the managed mark to a detached launcher, never the token', () => {
    const spec = encodeChildSpec({ env: { CC_DATA_DIR: '/d', CC_HOST_TOKEN: 'secret', PATH: '/bin', CENTRALU_MANAGED: '1' }, log: '/d/serve.log' })
    expect(spec).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(spec, 'base64url').toString('utf8')).not.toContain('secret')
    expect(decodeChildSpec(spec)).toEqual({ log: '/d/serve.log', env: { CC_DATA_DIR: '/d', CENTRALU_MANAGED: '1' } })
    expect(parseServeArgs([`--detached-child=${spec}`])).toEqual({ mode: 'serve', port: null, child: spec })
    expect(decodeChildSpec('not base64 json')).toBeNull()
  })

  it('detaches with setsid on posix, through WMI on Windows, and through a WMI-created wsl.exe inside WSL', () => {
    expect(detachHow('linux', {}, () => true)).toBe('setsid')
    expect(detachHow('darwin', {}, () => true)).toBe('setsid')
    expect(detachHow('win32', {}, () => false)).toBe('wmi')
    expect(detachHow('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, () => true)).toBe('wsl')
    // A distro whose Windows interop is off cannot reach WMI; setsid is all there is
    expect(detachHow('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, () => false)).toBe('setsid')
  })
})

describe('starting through WMI', () => {
  it('quotes every argument for a Windows command line, and refuses what cannot be quoted', () => {
    expect(windowsArg('C:\\Program Files\\nodejs\\node.exe')).toBe('"C:\\Program Files\\nodejs\\node.exe"')
    // A trailing backslash would escape the closing quote
    expect(windowsArg('C:\\')).toBe('"C:\\\\"')
    expect(() => windowsArg('a"b')).toThrow(/cannot pass/)
  })

  it('hands WMI the command line and folder as base64, so no quote reaches PowerShell', () => {
    const commandLine = `"C:\\it's here\\node.exe" "--x=$(rm)"`
    const script = wmiScript({ commandLine, cwd: 'C:\\Users\\me' })
    expect(script).not.toContain("it's here")
    expect(script).toContain(Buffer.from(commandLine, 'utf8').toString('base64'))
    expect(script).toContain('Invoke-CimMethod -ClassName Win32_Process -MethodName Create')
  })

  it('reads a created process, a refusal code and a thrown error from what the script printed', () => {
    expect(parseWmiAnswer('CENTRALU-WMI 0 4242\r\n')).toEqual({ ok: true, pid: 4242 })
    expect(parseWmiAnswer('CENTRALU-WMI 2 \r\n')).toEqual({ ok: false, message: "WMI's Win32_Process.Create returned 2 (access denied)" })
    expect(parseWmiAnswer('CENTRALU-WMI-ERROR Access is denied.\r\n')).toEqual({ ok: false, message: 'WMI refused to create the process: Access is denied.' })
    expect(parseWmiAnswer('').ok).toBe(false)
  })

  /** runDetach with WMI stood in for, on a port nobody serves */
  async function detachWith(start: (...a: unknown[]) => Promise<unknown>) {
    const d = tempDir()
    ensureServeState(d)
    recordServePort(d, await freePort())
    const lines: string[] = []
    const code = await runDetach({
      env: { CC_DATA_DIR: d },
      home: d,
      entry: SOURCE_HOST,
      version: '1.0.0',
      cliPath: null,
      platform: 'win32',
      how: 'wmi',
      start,
      timeoutMs: 5_000,
      noStartMs: 300,
      write: (l: string) => void lines.push(l),
    })
    return { code, line: JSON.parse(lines.join('')) as { v: number; detach: { ok: boolean; reason: string; message: string } } }
  }

  it('reports a start WMI refused as wmi_blocked', async () => {
    const r = await detachWith(async () => ({ ok: false, blocked: true, message: 'Windows did not start Centralu through WMI (returned 2)' }))
    expect(r.code).toBe(1)
    expect(r.line).toMatchObject({ v: 1, detach: { ok: false, how: 'wmi', reason: 'wmi_blocked' } })
  })

  it('reports a process WMI created that never ran as wmi_blocked too, naming the rule, instead of waiting out the timeout', async () => {
    const t0 = Date.now()
    let ended = 0
    // Measured on a Windows laptop: a WMI-created wsl.exe can hang without running anything
    const r = await detachWith(async () => ({ ok: true, pid: 4242, alive: () => true, stop: async () => void ended++ }))
    expect(r.line.detach).toMatchObject({ ok: false, reason: 'wmi_blocked' })
    expect(r.line.detach.message).toMatch(/nothing started within 0 s.*attack surface reduction/s)
    expect(Date.now() - t0).toBeLessThan(4_000)
    // What it created is ended, not left waiting
    expect(ended).toBe(1)
  })
})

describe('the install field and the managed launcher (remote-hub.md §10.1)', () => {
  it('reads current and previous as two plain words, and nothing that could leave the install', () => {
    expect(parsePointer('0.1.0-beta.13 24.21.0\n')).toEqual({ version: '0.1.0-beta.13', node: '24.21.0' })
    expect(parsePointer('0.1.0 24.21.0\r\n')).toEqual({ version: '0.1.0', node: '24.21.0' })
    for (const bad of ['../x 24.21.0', '0.1.0', '0.1.0 24.21.0 extra', '0.1.0 /etc', '']) expect(parsePointer(bad)).toBeNull()
  })

  it('says whether the managed launcher ran it, what is current and previous, and which Node answered', () => {
    const d = tempDir()
    expect(installInfo(d, {}, '24.21.0')).toEqual({ managed: false, current: null, previous: null, node: '24.21.0' })
    const l = remoteLayout(d)
    mkdirSync(l.root, { recursive: true })
    writeFileSync(l.current, '0.1.0-beta.14 24.21.0\n')
    writeFileSync(l.previous, '0.1.0-beta.13 24.21.0\n')
    expect(installInfo(d, { CENTRALU_MANAGED: '1' }, '24.21.0')).toEqual({
      managed: true,
      current: { version: '0.1.0-beta.14', node: '24.21.0' },
      previous: { version: '0.1.0-beta.13', node: '24.21.0' },
      node: '24.21.0',
    })
  })

  /**
   * A managed install with two versions in it, whose `centralu.mjs` prints which one ran, its
   * arguments and the managed mark. The Node is this test's own, linked in at the pinned layout.
   */
  function managedInstall(platform: NodeJS.Platform) {
    const d = tempDir()
    const l = remoteLayout(d)
    for (const v of ['1.0.0', '1.1.0']) {
      const bin = join(l.versions, v, 'node_modules', 'centralu', 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(
        join(bin, 'centralu.mjs'),
        `console.log(JSON.stringify({ v: ${JSON.stringify(v)}, argv: process.argv.slice(2), managed: process.env.CENTRALU_MANAGED ?? null }))\n`,
      )
    }
    const nodeDir = platform === 'win32' ? join(l.node, 'v24.0.0') : join(l.node, 'v24.0.0', 'bin')
    mkdirSync(nodeDir, { recursive: true })
    const node = join(nodeDir, platform === 'win32' ? 'node.exe' : 'node')
    if (platform === 'win32') {
      try {
        linkSync(process.execPath, node)
      } catch {
        copyFileSync(process.execPath, node)
      }
    } else symlinkSync(process.execPath, node)
    mkdirSync(l.bin, { recursive: true })
    const launcher = join(l.bin, platform === 'win32' ? 'centralu.cmd' : 'centralu')
    writeFileSync(launcher, managedLauncherScript(platform), { mode: 0o755 })
    return { l, launcher }
  }

  it.skipIf(!POSIX)('runs the version current names on its Node, marked managed, and follows current when it moves', () => {
    const { l, launcher } = managedInstall(process.platform)
    writeFileSync(l.current, '1.0.0 24.0.0\n')
    const run = () => spawnSync(launcher, ['serve', '--connection'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    expect(JSON.parse(run().stdout)).toEqual({ v: '1.0.0', argv: ['serve', '--connection'], managed: '1' })
    writeFileSync(l.current, '1.1.0 24.0.0\n')
    expect(JSON.parse(run().stdout).v).toBe('1.1.0')
    writeFileSync(l.current, '../../.. 24.0.0\n')
    const refused = run()
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/no version is installed/)
  })

  it.skipIf(POSIX)('runs the version current names on its Node from a .cmd, marked managed, and refuses a path in it', () => {
    const { l, launcher } = managedInstall('win32')
    writeFileSync(l.current, '1.0.0 24.0.0\n')
    const run = () => spawnSync('cmd.exe', ['/d', '/c', launcher, 'serve', '--connection'], { encoding: 'utf8' })
    const first = run()
    expect(first.stderr).toBe('')
    expect(JSON.parse(first.stdout)).toEqual({ v: '1.0.0', argv: ['serve', '--connection'], managed: '1' })
    writeFileSync(l.current, '1.1.0 24.0.0\r\n')
    expect(JSON.parse(run().stdout).v).toBe('1.1.0')
    writeFileSync(l.current, '..\\..\\x 24.0.0\n')
    const refused = run()
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/no version is installed/)
  })

  it('leaves <data>/bin/centralu alone under the managed launcher, and keeps it otherwise', async () => {
    const managed = tempDir()
    const info = await connection(managed, { CENTRALU_MANAGED: '1' })
    expect(info.install).toMatchObject({ managed: true, node: process.versions.node })
    expect(existsSync(join(managed, 'bin'))).toBe(false)
    const npm = tempDir()
    expect((await connection(npm)).install).toMatchObject({ managed: false })
    expect(existsSync(join(npm, 'bin', POSIX ? 'centralu' : 'centralu.cmd'))).toBe(true)
  })
})

/** `centralu serve <args>` to the end, its last stdout line parsed */
async function cli(dataDir: string, args: string[]) {
  return await new Promise<{ code: number | null; line: Record<string, any>; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve', ...args], { cwd: ROOT, env: cliEnv(dataDir), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (b) => (stdout += String(b)))
    child.stderr!.on('data', (b) => (stderr += String(b)))
    child.once('error', reject)
    child.once('close', (code) => {
      try {
        resolve({ code, line: JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, any>, stderr })
      } catch {
        reject(new Error(`no JSON line on stdout (exit ${code}):\n${stdout}\n${stderr}`))
      }
    })
  })
}

/** Whether the pid names a live process */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('centralu serve --detach and --stop, end to end (a host from source, a temporary data folder)', () => {
  /** Ends what a failed test left running: only the processes this data folder's files name, which this test started */
  function cleanup(d: string) {
    for (const file of [SERVE_PID_FILE, 'host.lock']) {
      try {
        const pid = (JSON.parse(readFileSync(join(d, file), 'utf8')) as { pid: number }).pid
        if (alive(pid)) process.kill(pid, 'SIGKILL')
      } catch {
        // not there
      }
    }
  }

  it(
    'starts the host in the background and returns once it answers, then stops it in order on request',
    async () => {
      const d = tempDir()
      try {
        ensureServeState(d)
        const port = await freePort()
        const started = await cli(d, ['--detach', '--port', String(port)])
        expect(started.code).toBe(0)
        expect(started.line).toMatchObject({ v: 1, port, hostRunning: true, detach: { ok: true, how: POSIX ? 'setsid' : 'wmi', already: false } })
        const pids = JSON.parse(readFileSync(join(d, SERVE_PID_FILE), 'utf8')) as { pid: number; hostPid: number }
        expect(alive(pids.pid) && alive(pids.hostPid)).toBe(true)

        // A second --detach finds it and starts nothing
        const again = await cli(d, ['--detach'])
        expect(again.line).toMatchObject({ hostRunning: true, detach: { ok: true, already: true } })

        const stopped = await cli(d, ['--stop'])
        expect(stopped.line).toEqual({ v: 1, stop: { ok: true, wasRunning: true, how: 'asked' } })
        const log = readFileSync(join(d, 'host.log'), 'utf8')
        expect(log).toContain('[agent-host] asked to stop (centralu serve --stop)')
        expect(log).toContain('[agent-host] shutting down')
        expect(alive(pids.hostPid)).toBe(false)
        expect(existsSync(join(d, SERVE_PID_FILE))).toBe(false)
        expect((await connection(d)).hostRunning).toBe(false)
        // serve.log has the launcher's start, and not the token
        const serveLog = readFileSync(join(d, 'serve.log'), 'utf8')
        expect(serveLog).toContain('started in the background')
        expect(serveLog).not.toContain(String(started.line.token))

        expect((await cli(d, ['--stop'])).line).toMatchObject({ v: 1, stop: { ok: true, wasRunning: false } })
      } finally {
        cleanup(d)
      }
    },
    120_000,
  )

  it.skipIf(!POSIX)(
    'outlives the process group of the session that started it',
    async () => {
      const d = tempDir()
      try {
        ensureServeState(d)
        const port = await freePort()
        // A shell standing in for the ssh session: it runs --detach, then stays, as a session would
        const session = spawn('/bin/sh', ['-c', `"${process.execPath}" "${CLI}" serve --detach --port ${port}; sleep 60`], {
          cwd: ROOT,
          env: cliEnv(d),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        })
        started.push(session)
        let out = ''
        session.stdout!.on('data', (b) => (out += String(b)))
        const deadline = Date.now() + 60_000
        while (!out.includes('"hostRunning":true') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
        expect(out).toContain('"detach":{"ok":true')
        // The session ends the way sshd can end one: every process in its group, at once
        process.kill(-session.pid!, 'SIGKILL')
        await new Promise((r) => setTimeout(r, 1000))
        expect((await connection(d)).hostRunning).toBe(true)
        expect((await cli(d, ['--stop'])).line.stop).toMatchObject({ ok: true, how: 'asked' })
      } finally {
        cleanup(d)
      }
    },
    120_000,
  )
})
