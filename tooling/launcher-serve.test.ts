import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, copyFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@cc/protocol'
import { acquireInstanceLock } from '../packages/agent-host/src/dev-services/instance-lock.js'
import { HostServer, versionMismatchMessage } from '../packages/agent-host/src/transport/server.js'
import { CREDENTIAL_ID_RE as HOST_ID_RE, CREDENTIAL_LABEL_RE as HOST_LABEL_RE, readFullCredentials } from '../packages/agent-host/src/lifecycle/serve-credentials.js'
import { createRequire } from 'node:module'
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
  runStop,
  SERVE_PID_FILE,
  windowsArg,
  wmiScript,
  ensureServeState,
  hostCommand,
  hostEnv,
  takesTokenOnStdin,
  tokenLine,
  launcherScript,
  ensureLauncher,
  mismatchServerVersion,
  parseServeArgs,
  readServeState,
  readyPort,
  recordServePort,
  rotateServeToken,
  pairServe,
  revokeServe,
  verifierOf,
  limitedOf,
  SERVE_STATE_FILE,
  serveDataDir,
  chooseServePort,
  listensHere,
  parseNetstatListening,
  SERVE_PORT_TRIES,
  probeHost,
  askHostToStop,
  hostProvesOf,
  heldHere,
  lockHolderIsAlive,
  lockHolderPid,
  lockHolder,
  moveIntoSignIn,
  runServe,
  runWindow,
  serveFrom,
  processStartTime,
  SERVE_STOPPED_FILE,
  markStopped,
  readStopped,
  rotateServeLog,
  PAIR_LABEL_RE,
  CREDENTIAL_ID_RE,
  // @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
} from '../packaging/npm/centralu/bin/serve.mjs'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { hostDirIn } from '../packaging/npm/centralu/bin/platform.mjs'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { renameRetrying, replaceFile } from '../packaging/npm/centralu/bin/serve-util.mjs'
import { SLOW } from './test-timing.js'
import { ownProcesses } from '../packages/agent-host/src/process.test-helpers.js'

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
  // Windows can hold a node.exe the test copied and ran for a moment after the process ended (the image lock, or a
  // scanner on a new executable): retry EBUSY rather than fail the cleanup
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
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

  /** The hub's name, for the host.lock a second Centralu on the folder reads (#1223) */
  it('takes --from <hub> with serve and --detach only, and only a name that cannot break a sentence or a command line', () => {
    expect(parseServeArgs(['--detach', '--from', 'Mac-mini.local'])).toEqual({ mode: 'detach', port: null, from: 'Mac-mini.local' })
    expect(parseServeArgs(['--from=Mac'])).toEqual({ mode: 'serve', port: null, from: 'Mac' })
    expect(parseServeArgs(['--detach', '--from', 'a b']).error).toMatch(/--from needs a computer's name/)
    expect(parseServeArgs(['--detach', '--from']).error).toMatch(/got nothing/)
    expect(parseServeArgs(['--connection', '--from', 'Mac']).error).toMatch(/--from goes with/)
  })
})

describe('the data folder and the state file', () => {
  it('lists exactly the full credentials the host takes: an entry nothing would list opens nothing (#1405)', () => {
    // The two rules are one: what --pair and --revoke take is what the host's reader takes
    expect(HOST_ID_RE.source).toBe(CREDENTIAL_ID_RE.source)
    expect(HOST_LABEL_RE.source).toBe(PAIR_LABEL_RE.source)
    const d = tempDir()
    const key = 'k'.repeat(43)
    const v = verifierOf('h'.repeat(43))
    const entries = [
      { id: 'aaaaaaaa', verifier: v, created: 1 },
      { id: 'zz', label: 'hand', verifier: v, created: 1 },
      { id: 'bbbbbbbb', label: 'with space', verifier: v, created: 1 },
      { id: 'cccccccc', label: 'window', verifier: v, created: 1 },
    ]
    writeFileSync(join(d, SERVE_STATE_FILE), JSON.stringify({ v: 2, key, port: null, full: entries }))
    const listed = (readServeState(d).full as { id: string }[]).map((e) => e.id)
    expect(listed).toEqual(['cccccccc'])
    expect(readFullCredentials(join(d, SERVE_STATE_FILE), (f) => readFileSync(f, 'utf8')).map((e) => e.id)).toEqual(listed)
    // And the next write leaves the others out of the file
    pairServe(d, 'hub:laptop')
    const kept = (JSON.parse(readFileSync(join(d, SERVE_STATE_FILE), 'utf8')) as { full: { id: string }[] }).full.map((e) => e.id)
    expect(kept).not.toContain('aaaaaaaa')
    expect(kept).not.toContain('zz')
  })

  it('is ~/.centralu unless CC_DATA_DIR says otherwise', () => {
    expect(serveDataDir({}, '/home/me')).toBe(join('/home/me', '.centralu'))
    expect(serveDataDir({ CC_DATA_DIR: '/srv/cc' }, '/home/me')).toBe('/srv/cc')
  })

  // Permission bits are POSIX's. On Windows serve sets none and the file sits under the profile folder, whose ACL
  // already limits it to the person, SYSTEM and administrators.
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

  it('generates the key once and keeps it across starts and port changes, with no full credential yet (#1405)', () => {
    const d = tempDir()
    const first = ensureServeState(d)
    expect(first.key.length).toBeGreaterThanOrEqual(32)
    expect(first.port).toBeNull()
    expect(first.full).toEqual([])
    // What the launcher's own probes say hello with: the limited credential, derived from the key as the host derives it
    expect(first.token).toBe(limitedOf(first.key))
    recordServePort(d, 9100)
    expect(ensureServeState(d)).toEqual({ ...first, port: 9100 })
  })

  it('keeps a full credential only as its hash, one per label, and withdraws it when asked (#1405)', () => {
    const d = tempDir()
    const hub = pairServe(d, 'hub:mac')
    const again = pairServe(d, 'hub:mac')
    const win = pairServe(d, 'window')
    const file = readFileSync(join(d, SERVE_STATE_FILE), 'utf8')
    for (const t of [hub.token, again.token, win.token]) expect(file).not.toContain(t)
    const state = readServeState(d)!
    // Pairing again replaces the label's earlier credential
    expect(state.full.map((e: { label: string; id: string; verifier: string }) => [e.label, e.id, e.verifier])).toEqual([
      ['hub:mac', again.id, verifierOf(again.token)],
      ['window', win.id, verifierOf(win.token)],
    ])
    expect(revokeServe(d, again.id)).toBe(true)
    expect(revokeServe(d, again.id)).toBe(false)
    expect(readServeState(d).full.map((e: { label: string; id: string; verifier: string }) => e.label)).toEqual(['window'])
  })

  it('moves a version 1 file on: its token becomes a full credential no longer written down, removed by the next pairing (#1405)', () => {
    const d = tempDir()
    const legacy = 'x'.repeat(43)
    writeFileSync(join(d, SERVE_STATE_FILE), JSON.stringify({ v: 1, token: legacy, port: 9300 }))
    const moved = ensureServeState(d)
    expect(moved).toMatchObject({ v: 2, port: 9300 })
    expect(moved.full).toEqual([expect.objectContaining({ label: 'legacy', verifier: verifierOf(legacy) })])
    expect(readFileSync(join(d, SERVE_STATE_FILE), 'utf8')).not.toContain(legacy)
    // The key is new: a hello with the old token is not what derives the limited credential
    expect(moved.key).not.toBe(legacy)
    // A program's own pairing leaves it: a hub that held it and has not paired yet keeps its link
    pairServe(d, 'script')
    expect(readServeState(d).full.map((e: { label: string; id: string; verifier: string }) => e.label)).toEqual(['legacy', 'script'])
    pairServe(d, 'hub:mac')
    expect(readServeState(d).full.map((e: { label: string; id: string; verifier: string }) => e.label)).toEqual(['script', 'hub:mac'])
  })

  it('drops a version 1 token at the window pairing, so a machine no hub links to does not keep it (#1405 review)', () => {
    const d = tempDir()
    writeFileSync(join(d, SERVE_STATE_FILE), JSON.stringify({ v: 1, token: 'y'.repeat(43), port: 9300 }))
    ensureServeState(d)
    pairServe(d, 'window')
    expect(readServeState(d).full.map((e: { label: string; id: string; verifier: string }) => e.label)).toEqual(['window'])
  })

  it('replaces the key and withdraws every full credential only when asked, keeping the port', () => {
    const d = tempDir()
    const first = ensureServeState(d)
    recordServePort(d, 9200)
    pairServe(d, 'hub:mac')
    const after = rotateServeToken(d)
    expect(after.key).not.toBe(first.key)
    expect(after.token).not.toBe(first.token)
    expect(after.full).toEqual([])
    expect(after.port).toBe(9200)
    expect(readServeState(d)).toEqual(after)
  })

  it('refuses to overwrite a state file it cannot read, since a client may hold that token', () => {
    const d = tempDir()
    writeFileSync(join(d, SERVE_STATE_FILE), 'not json')
    expect(() => ensureServeState(d)).toThrow(/not a serve state file/)
    expect(readFileSync(join(d, SERVE_STATE_FILE), 'utf8')).toBe('not json')
  })

  // #1041: on Windows a rename over a file fails with EPERM while another handle has it open without sharing deletes
  // (a `--detach` reading serve.json, a virus scanner), which left the port unrecorded. Node's own handles share
  // deletes, so a second process holds it, the way a reader that does not.
  it.skipIf(POSIX)('records the port even while another program holds serve.json open (Windows)', async () => {
    const d = tempDir()
    ensureServeState(d)
    const file = join(d, SERVE_STATE_FILE)
    const holder = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `$f = [System.IO.File]::Open('${file}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 1000; $f.Dispose()`],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    )
    started.push(holder)
    await new Promise<void>((resolve, reject) => {
      holder.stdout!.on('data', (b) => String(b).includes('held') && resolve())
      holder.once('error', reject)
      holder.once('exit', () => reject(new Error('the holder ended before it held the file')))
    })
    recordServePort(d, 9300)
    expect(readServeState(d)?.port).toBe(9300)
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)
  }, 30_000 * SLOW)
})

describe('replacing a file that a reader holds open (#1041)', () => {
  const busy = (code: string) => Object.assign(new Error(`${code}: busy`), { code })
  const quick = { sleep: () => {}, retry: true }

  it('tries a refused rename again on Windows until it goes through', () => {
    let calls = 0
    const rename = () => {
      if (++calls < 4) throw busy(['EPERM', 'EBUSY', 'EACCES'][calls - 1]!)
    }
    renameRetrying('a', 'b', { ...quick, rename })
    expect(calls).toBe(4)
  })

  it('gives up with the last error once the time is spent, and waits longer between tries', () => {
    const waits: number[] = []
    let t = 0
    const rename = () => {
      throw busy('EPERM')
    }
    expect(() => renameRetrying('a', 'b', { retry: true, rename, sleep: (ms: number) => ((t += ms), waits.push(ms)), now: () => t, budgetMs: 500 })).toThrow(/EPERM/)
    expect(waits.slice(0, 4)).toEqual([10, 20, 40, 80])
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(500)
  })

  it('does not retry anywhere else, nor an error that is not a busy file', () => {
    let calls = 0
    const rename = () => {
      calls++
      throw busy('EPERM')
    }
    expect(() => renameRetrying('a', 'b', { retry: false, rename, sleep: () => {} })).toThrow(/EPERM/)
    expect(calls).toBe(1)
    calls = 0
    const enoent = () => {
      calls++
      throw busy('ENOENT')
    }
    expect(() => renameRetrying('a', 'b', { ...quick, rename: enoent })).toThrow(/ENOENT/)
    expect(calls).toBe(1)
  })

  it('leaves the old file whole and no temporary file when the rename never goes through', () => {
    const d = tempDir()
    const file = join(d, 'f.json')
    writeFileSync(file, 'old')
    const rename = () => {
      throw busy('EBUSY')
    }
    expect(() => replaceFile(file, 'new', { ...quick, rename, budgetMs: 0 })).toThrow(/EBUSY/)
    expect(readFileSync(file, 'utf8')).toBe('old')
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)
  })

  it('reads serve.json again when the first read is refused or half there', () => {
    const d = tempDir()
    const state = ensureServeState(d)
    const file = join(d, SERVE_STATE_FILE)
    const whole = readFileSync(file, 'utf8')
    writeFileSync(file, whole.slice(0, 20))
    let sleeps = 0
    expect(readServeState(d, { sleep: () => (++sleeps === 2 ? writeFileSync(file, whole) : undefined) })).toEqual(state)
    expect(sleeps).toBe(2)
  })

  it('still says there is no state when serve.json is absent, without waiting', () => {
    let sleeps = 0
    expect(readServeState(tempDir(), { sleep: () => sleeps++ })).toBeNull()
    expect(sleeps).toBe(0)
  })
})

describe('the person’s stop and the earlier logs (#1143)', () => {
  it('keeps the three earlier starts’ serve.log, so the first failure’s is still there after three more starts', () => {
    const d = tempDir()
    const log = join(d, 'serve.log')
    for (const n of [1, 2, 3, 4]) {
      writeFileSync(log, `start ${n}`)
      rotateServeLog(log)
    }
    expect(existsSync(log)).toBe(false)
    expect([1, 2, 3].map((k) => readFileSync(`${log}.${k}`, 'utf8'))).toEqual(['start 4', 'start 3', 'start 2'])
    writeFileSync(log, 'start 5')
    rotateServeLog(log)
    expect(readFileSync(`${log}.3`, 'utf8')).toBe('start 3')
    expect(existsSync(`${log}.4`)).toBe(false)
    // A second call for the same start, with no serve.log to move (the task's line removed before a WMI start): nothing moves
    rotateServeLog(log)
    expect([1, 2, 3].map((k) => readFileSync(`${log}.${k}`, 'utf8'))).toEqual(['start 5', 'start 4', 'start 3'])
  })

  it('reads the mark it wrote, a mark that does not parse as a stop, and none as none', () => {
    const d = tempDir()
    expect(readStopped(d)).toBeNull()
    markStopped(d, 'stop', 1234)
    expect(readStopped(d)).toEqual({ by: 'stop', at: 1234 })
    writeFileSync(join(d, SERVE_STOPPED_FILE), '{"v":1,"by":"quit","at":9}')
    expect(readStopped(d)).toEqual({ by: 'quit', at: 9 })
    writeFileSync(join(d, SERVE_STOPPED_FILE), 'half')
    expect(readStopped(d)).toEqual({ by: 'stop', at: null })
    expect(JSON.parse(connectionLine({ port: 1, token: 't', version: '1', protocolVersion: 1, dataDir: d, hostRunning: false, stopped: { by: 'quit', at: 9 } }))).toMatchObject({ stopped: { by: 'quit', at: 9 } })
  })
})

describe('the connection line', () => {
  it('has exactly the fields the client reads, in one JSON object', () => {
    const line = connectionLine({ port: 17175, token: 't', version: '1.2.3', protocolVersion: 1, dataDir: '/d', hostRunning: false })
    // `takes`: the options an older serve refuses, so a hub (`from`) or the window (`window`) uses them only on one that says so (#1223)
    // `pair` (#1405): `--connection --pair` hands out a full credential of its own
    expect(JSON.parse(line)).toEqual({ v: 1, port: 17175, token: 't', version: '1.2.3', protocolVersion: 1, dataDir: '/d', hostRunning: false, takes: ['from', 'window', 'pair'] })
    expect(line).not.toContain('\n')
  })

  // Only a host that proved it holds the token is marked (#838); a line without it gets the hello as before
  it('says proof only when the running host proved it', () => {
    const base = { port: 17175, token: 't', version: '1.2.3', protocolVersion: 1, dataDir: '/d', hostRunning: true }
    expect(JSON.parse(connectionLine({ ...base, proof: true }))).toMatchObject({ proof: true })
    expect(JSON.parse(connectionLine({ ...base, proof: false }))).not.toHaveProperty('proof')
  })

  it('has a default port below the ephemeral ranges and the host’s view origin ports', () => {
    expect(DEFAULT_SERVE_PORT).toBeLessThan(20000)
    expect(DEFAULT_SERVE_PORT).toBeGreaterThan(1024)
  })
})

describe('how the host is started', () => {
  const env = { PATH: '/usr/bin', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', CC_KEEPER: '1', CC_DEV: '1', CC_HOST_TOKEN: 'old' }

  /*
   * #538: a process's start environment stays readable to every process of its user while it runs (#502), and its
   * arguments to every user. The token goes as the first line on the host's stdin, a pipe to this launcher.
   */
  /*
   * #1223: the host writes who asked for it to its host.lock (`CC_SERVE_FROM`, which it takes out of its environment
   * before it starts anything). A `--detach` runs in the ssh session and its launcher does not, so it carries what it found
   */
  it('tells the host who asked for it: the hub --from named and the ssh client, carried past --detach', () => {
    const ssh = { SSH_CLIENT: '192.168.0.5 52344 22' }
    expect(serveFrom(ssh, 'Mac-mini')).toEqual({ hub: 'Mac-mini', ssh: '192.168.0.5' })
    expect(serveFrom({ SSH_CONNECTION: 'fe80::1 52344 fe80::2 22' })).toEqual({ ssh: 'fe80::1' })
    expect(serveFrom({})).toBeNull()
    expect(serveFrom({ SSH_CLIENT: '$(rm) 1 22' }, 'a b')).toBeNull()
    const carried = { CENTRALU_STARTED_FROM: JSON.stringify({ hub: 'Mac-mini', ssh: '192.168.0.5' }) }
    expect(serveFrom(carried)).toEqual({ hub: 'Mac-mini', ssh: '192.168.0.5' })
    const spec = decodeChildSpec(encodeChildSpec({ env: { ...carried, SSH_CLIENT: 'x' }, log: '/d/serve.log' }))
    expect(spec.env).toEqual(carried)
    const e = hostEnv({ ...carried, CC_STARTED_BY: 'app' }, { dataDir: '/d', version: '1.0.0', hostDir: '/h', from: serveFrom(carried) })
    expect(JSON.parse(e.CC_SERVE_FROM)).toEqual({ hub: 'Mac-mini', ssh: '192.168.0.5' })
    expect(e.CENTRALU_STARTED_FROM).toBeUndefined()
    expect(e.CC_STARTED_BY).toBeUndefined()
    expect(hostEnv({ CC_SERVE_FROM: 'stale' }, { dataDir: '/d', version: '1.0.0', hostDir: '/h' }).CC_SERVE_FROM).toBeUndefined()
  })

  it('hands the token over on stdin, never in the environment or on the command line', () => {
    const e = hostEnv(env, { dataDir: '/d', version: '1.0.0', hostDir: '/h' })
    expect(e.CC_HOST_TOKEN).toBeUndefined()
    expect(Object.values(e).some((v) => String(v).includes('secret-token') || String(v).includes('old'))).toBe(false)
    expect(e.CC_HOST_TOKEN_ON_STDIN).toBe('1')
    expect(tokenLine('secret-token')).toBe('{"token":"secret-token"}\n')
    const plan = hostCommand('/usr/bin/node', '/h/main.mjs', { port: 17175, dataDir: '/d', platform: 'linux' })
    expect(plan.args.join(' ')).not.toContain('secret-token')
    expect(plan.args).not.toContain('--token')
  })

  // Review of #1100: CENTRALU_HOST_ENTRY can point at a bundle from before #538, which reads only CC_HOST_TOKEN
  it('gives a host bundle from before the stdin token its token in the environment, as before', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-token-entry-'))
    try {
      writeFileSync(join(d, 'main.mjs'), '')
      writeFileSync(join(d, 'bundle-info.json'), JSON.stringify({ protocolVersion: 1, hostProof: 1 }))
      expect(takesTokenOnStdin(join(d, 'main.mjs'))).toBe(false)
      const e = hostEnv(env, { dataDir: '/d', version: '1.0.0', hostDir: d, legacyToken: 'secret-token' })
      expect(e.CC_HOST_TOKEN).toBe('secret-token')
      expect(e.CC_HOST_TOKEN_ON_STDIN).toBeUndefined()
      writeFileSync(join(d, 'bundle-info.json'), JSON.stringify({ protocolVersion: 1, hostProof: 1, tokenOnStdin: 1 }))
      expect(takesTokenOnStdin(join(d, 'main.mjs'))).toBe(true)
      // The source, which has no bundle-info.json, reads it from stdin
      expect(takesTokenOnStdin(join(ROOT, 'packages/agent-host/src/main.ts'))).toBe(true)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('starts the host with no display and none of the keeper’s or dev mode’s variables', () => {
    const e = hostEnv(env, { dataDir: '/d', version: '1.0.0', hostDir: '/h' })
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

  // The same launcher on Windows is a .cmd, run by cmd.exe as ssh's default shell runs it, with a PATH that has
  // nothing on it: node and the CLI are named by absolute path. A quote cannot be in a Windows file name; an
  // apostrophe, spaces and a percent sign can, and are what cmd.exe is most likely to mangle.
  it.skipIf(POSIX)('runs the CLI from a .cmd by absolute paths, even with an apostrophe, spaces and a percent sign in them', () => {
    const d = tempDir()
    const cli = join(d, "it's a 100% cli.mjs")
    writeFileSync(cli, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
    const file = ensureLauncher(d, { cliPath: cli })
    expect(file).toBe(join(d, 'bin', 'centralu.cmd'))
    const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', file, 'serve', '--connection'], { encoding: 'utf8', env: { PATH: '', SystemRoot: process.env.SystemRoot } })
    expect(r.stderr).toBe('')
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
  // No scheduled task from a test: on a Windows machine with a desktop, --detach would start the host through one (#1224)
  return { ...process.env, CC_DATA_DIR: dataDir, CENTRALU_HOST_ENTRY: SOURCE_HOST, CI: '1', CENTRALU_SIGNIN_TASK: 'off' }
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

/**
 * The options a host `centralu serve` runs is started with since #1405: its key as the token, and the full credentials
 * those serve.json names, read at each hello
 */
function serveHostCredentials(dataDir: string) {
  return { token: String(readServeState(dataDir).key), fullCredentials: () => readFullCredentials(join(dataDir, SERVE_STATE_FILE), (f) => readFileSync(f, 'utf8')) }
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

describe('the port serve starts on (#482)', () => {
  const takenOf = (...ports: number[]) => async (p: number) => ports.includes(p)

  it('uses a port the person gave as given, even when it is taken', async () => {
    expect(await chooseServePort({ asked: 17175, recorded: 18000, taken: takenOf(17175) })).toEqual({ port: 17175, from: null })
  })

  it('keeps the recorded port, else the default, while it is free', async () => {
    expect(await chooseServePort({ asked: null, recorded: 18000, taken: takenOf() })).toEqual({ port: 18000, from: null })
    expect(await chooseServePort({ asked: null, recorded: null, taken: takenOf() })).toEqual({ port: DEFAULT_SERVE_PORT, from: null })
  })

  it('moves to the next free port above a taken one, and says which it left', async () => {
    const r = await chooseServePort({ asked: null, recorded: null, taken: takenOf(DEFAULT_SERVE_PORT, DEFAULT_SERVE_PORT + 1) })
    expect(r).toEqual({ port: DEFAULT_SERVE_PORT + 2, from: DEFAULT_SERVE_PORT })
  })

  it('gives up after SERVE_PORT_TRIES ports, and never moves to 20000 or above', async () => {
    const all = async () => true
    expect(await chooseServePort({ asked: null, recorded: null, taken: all })).toBeNull()
    expect(await chooseServePort({ asked: null, recorded: 19999, taken: takenOf(19999) })).toBeNull()
    const tried: number[] = []
    await chooseServePort({ asked: null, recorded: 17000, taken: async (p: number) => (tried.push(p), true) })
    expect(tried).toHaveLength(SERVE_PORT_TRIES)
  })

  it('sees a port another program listens on here', async () => {
    const srv = createServer()
    await new Promise<void>((r) => srv.listen({ host: '127.0.0.1', port: 0 }, r))
    const port = (srv.address() as { port: number }).port
    try {
      expect(await listensHere(port)).toBe(true)
    } finally {
      await new Promise((r) => srv.close(r))
    }
    expect(await listensHere(port)).toBe(false)
  })

  it('reads the listening ports from Windows netstat, in any display language', () => {
    const text = [
      '',
      '활성 연결',
      '',
      '  프로토콜  로컬 주소              외부 주소              상태',
      '  TCP    0.0.0.0:135            0.0.0.0:0              수신 대기',
      '  TCP    127.0.0.1:17175        0.0.0.0:0              LISTENING',
      '  TCP    127.0.0.1:17175        127.0.0.1:50211        ESTABLISHED',
      '  TCP    192.0.2.24:139       0.0.0.0:0              LISTENING',
      '  TCP    [::1]:17176            [::]:0                 LISTENING',
      '  TCP    127.0.0.1:50211        127.0.0.1:17175        ESTABLISHED',
    ].join('\r\n')
    expect([...parseNetstatListening(text)].sort()).toEqual([135, 17175, 17176])
  })
})

describe('centralu serve, end to end (a host from source, a temporary data folder)', () => {
  it(
    'serves on 127.0.0.1 with its token, reports itself in --connection, refuses a second serve, and stops on SIGTERM (--stop on Windows)',
    async () => {
      const d = tempDir()
      const before = await connection(d)
      expect(before).toMatchObject({ v: 1, port: DEFAULT_SERVE_PORT, protocolVersion: PROTOCOL_VERSION, dataDir: d, hostRunning: false })

      // The data folder as an older build left it (#838): the host makes it its owner's only
      chmodSync(d, 0o755)
      const port = await freePort()
      const s = serve(d, ['--port', String(port)])
      await s.until(/listening on 127\.0\.0\.1:\d+/)
      // Mode bits say nothing on Windows, where the host leaves them (`modesGuardFiles`)
      if (POSIX) expect(statSync(d).mode & 0o777).toBe(0o700)

      const info = await connection(d)
      // proof (#838): the running host answered a prove, so the hub will ask it to before sending the token
      expect(info).toMatchObject({ v: 1, port, limited: before.limited, protocolVersion: PROTOCOL_VERSION, dataDir: d, hostRunning: true, proof: true })
      // From the installed build (#838), whether a host runs or not
      expect(before.proof).toBe(true)
      // --connection alone hands out no full credential (#1405): the limited one only
      expect(info.token).toBeUndefined()
      expect(String(info.limited)).toMatch(/^ccl1:/)

      // A hub pairs (#1405): a full credential of its own, printed once, which the running host takes at once
      const paired = (await cli(d, ['--connection', '--pair', 'hub:test'])).line
      expect(paired).toMatchObject({ token: expect.any(String), credential: expect.stringMatching(/^[0-9a-f]{8}$/), others: [] })
      expect(readFileSync(join(d, SERVE_STATE_FILE), 'utf8')).not.toContain(String(paired.token))
      const ok = await hello(port, String(paired.token))
      // Whether it runs with administrator rights is known before it listens (#702): a hub's first hello already says it
      expect(ok).toMatchObject({ kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION, elevated: expect.any(Boolean) })
      // The limited credential is a client too, and the key it comes from is no credential at all
      expect(await hello(port, String(info.limited))).toMatchObject({ kind: 'hello_ok' })
      await expect(hello(port, String(readServeState(d).key))).rejects.toThrow(/closed 4001/)
      await expect(hello(port, 'not-the-token')).rejects.toThrow(/closed 4001/)
      // Withdrawn, the credential's next hello is refused
      expect((await cli(d, ['--revoke', String(paired.credential)])).code).toBe(0)
      await expect(hello(port, String(paired.token))).rejects.toThrow(/closed 4001/)

      const second = serve(d, [])
      expect(await second.exited).toBe(1)
      expect(second.out.stderr).toContain(`centralu serve is already running for ${d} on 127.0.0.1:${port}`)

      // Windows has no SIGTERM to send: killing the launcher would end it without a word. The way it is
      // asked to stop there is the one the hub uses on a Windows machine, `centralu serve --stop`
      if (POSIX) s.child.kill('SIGTERM')
      else expect((await cli(d, ['--stop'])).line.stop).toMatchObject({ ok: true, wasRunning: true })
      expect(await s.exited).toBe(0)
      expect(s.out.stderr).toContain('[agent-host] shutting down')
      // The ready line carries the host's key; serve passes it to no one, nor any credential
      expect(s.out.stdout).toBe('')
      expect(s.out.stderr).not.toContain(String(paired.token))
      expect(s.out.stderr).not.toContain(String(readServeState(d).key))
      expect((await connection(d)).hostRunning).toBe(false)
    },
    90_000 * SLOW,
  )

  // Windows cannot send a Ctrl+C to one process from Node (the console delivers it to the whole group), and serve
  // leaves it to the host there, which shares the console
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
    90_000 * SLOW,
  )

  it(
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
    90_000 * SLOW,
  )

  it(
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
    90_000 * SLOW,
  )
  it(
    'starts on the next free port when another program holds the recorded one, and reports that port (#482)',
    async () => {
      const d = tempDir()
      // Two free ports in a row below 20000, the first held by a stand-in for WSL2's relay
      let held = 0
      for (let p = 18000 + Math.floor(Math.random() * 1500); p < 19990 && !held; p += 7) {
        if (!(await listensHere(p)) && !(await listensHere(p + 1))) held = p
      }
      expect(held).toBeGreaterThan(0)
      ensureServeState(d)
      recordServePort(d, held)
      // Drops what connects, so closing it below does not wait on serve's probe of that port
      const blocker = createServer((socket) => socket.destroy())
      await new Promise<void>((r) => blocker.listen({ host: '127.0.0.1', port: held }, r))
      try {
        const s = serve(d, [])
        await s.until(/listening on 127\.0\.0\.1:\d+/)
        expect(s.out.stderr).toContain(`127.0.0.1:${held} is in use by another program; starting on ${held + 1} instead`)
        const info = await connection(d)
        expect(info).toMatchObject({ port: held + 1, hostRunning: true })
        expect(await hello(held + 1, String(info.limited))).toMatchObject({ kind: 'hello_ok' })
        if (POSIX) s.child.kill('SIGTERM')
        else await cli(d, ['--stop'])
        expect(await s.exited).toBe(0)
      } finally {
        await new Promise((r) => blocker.close(r))
      }
    },
    90_000 * SLOW,
  )
  it(
    'gives serve\'s advice, not a developer\'s, when the port given with --port is taken (#482)',
    async () => {
      const d = tempDir()
      const blocker = createServer((socket) => socket.destroy())
      await new Promise<void>((r) => blocker.listen({ host: '127.0.0.1', port: 0 }, r))
      const port = (blocker.address() as { port: number }).port
      try {
        const s = serve(d, ['--port', String(port)])
        expect(await s.exited).not.toBe(0)
        expect(s.out.stderr).toContain(`Port ${port} is already in use.`)
        expect(s.out.stderr).toContain('centralu serve --port <n>')
        expect(s.out.stderr).not.toContain('pnpm host')
      } finally {
        await new Promise((r) => blocker.close(r))
      }
    },
    90_000 * SLOW,
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
    // Started from PowerShell 7, 5.1 inherits a module path with 7.x modules it cannot load (links/install-windows.test.ts); the reset is the same defensive line the hub sends
    expect(script).toContain('$env:PSModulePath = ')
  })

  it('reads a created process, a refusal code and a thrown error from what the script printed', () => {
    expect(parseWmiAnswer('CENTRALU-WMI 0 4242\r\n')).toEqual({ ok: true, pid: 4242 })
    expect(parseWmiAnswer('CENTRALU-WMI 2 \r\n')).toEqual({ ok: false, message: "WMI's Win32_Process.Create returned 2 (access denied)" })
    expect(parseWmiAnswer('CENTRALU-WMI-ERROR Access is denied.\r\n')).toEqual({ ok: false, message: 'WMI refused to create the process: Access is denied.' })
    expect(parseWmiAnswer('').ok).toBe(false)
  })

  /** runDetach with WMI stood in for, on a port nobody serves; the sign-in task (#1224) stood in for too, nobody signed in */
  async function detachWith(start: (...a: unknown[]) => Promise<unknown>, signIn: (...a: unknown[]) => Promise<unknown> = async () => ({ started: false, reason: 'nosession' })) {
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
      signIn,
      signInMs: 600,
      timeoutMs: 5_000,
      noStartMs: 300,
      write: (l: string) => void lines.push(l),
    })
    return { code, line: JSON.parse(lines.join('')) as { v: number; hostRunning?: boolean; detach: { ok: boolean; how: string; reason: string; message: string } }, dataDir: d }
  }

  /*
   * #1224: a host WMI creates keeps the ssh session's network logon, where Git cannot use the credentials saved in
   * Windows. With someone signed in, --detach starts it through the sign-in task instead, and WMI is not asked
   */
  it('starts the host in the Windows sign-in through the task when someone is signed in, and asks WMI nothing', async () => {
    const servers: HostServer[] = []
    let wmi = 0
    try {
      const r = await detachWith(
        async () => {
          wmi++
          return { ok: false, blocked: true, message: 'not asked' }
        },
        async (...a: unknown[]) => {
          // What the task's serve does: a host on this folder's port, with its token
          const { dataDir } = a[0] as { dataDir: string }
          const state = readServeState(dataDir)!
          const server = new HostServer({ port: state.port!, ...serveHostCredentials(dataDir), onRpc: async () => ({}), build: { commit: 'c', protocolVersion: PROTOCOL_VERSION, version: '1.0.0' } })
          servers.push(server)
          await server.listen()
          return { started: true, name: 'Centralu host 1a2b3c4d' }
        },
      )
      expect(r.code).toBe(0)
      expect(r.line).toMatchObject({ hostRunning: true, detach: { ok: true, how: 'task', already: false } })
      // The task's serve writes no serve.log: --detach leaves the line that says how this host started (#1223)
      expect(readFileSync(join(r.dataDir, 'serve.log'), 'utf8')).toBe(
        '[centralu serve] started centralu serve in the Windows sign-in (the scheduled task "Centralu host 1a2b3c4d"); waiting for its host\n',
      )
      expect(wmi).toBe(0)
    } finally {
      for (const s of servers) await s.close()
    }
  })

  it('falls back to WMI when nobody is signed in, or when the task’s host does not answer in time', async () => {
    let wmi = 0
    const refused = async () => {
      wmi++
      return { ok: false, blocked: true, message: 'Windows did not start Centralu through WMI (returned 2)' }
    }
    expect((await detachWith(refused)).line.detach).toMatchObject({ ok: false, how: 'wmi', reason: 'wmi_blocked' })
    expect(wmi).toBe(1)
    const t0 = Date.now()
    expect((await detachWith(refused, async () => ({ started: true, name: 'Centralu host' }))).line.detach).toMatchObject({ ok: false, how: 'wmi' })
    expect(wmi).toBe(2)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500)
  })

  /*
   * #1223: a host that started through WMI on a laptop where someone was signed in left no trace of why. serve.log says
   * which way the host was started and why: the task's line is written by --detach (the task's serve writes no
   * serve.log), a WMI launcher's by the launcher, from what --detach passed it
   */
  describe('the serve.log line that says how the host was started and why (#1223)', () => {
    /** The `start` a stand-in WMI was handed for its launcher's serve.log line, refused so nothing runs */
    async function wmiStart(signIn: (...a: unknown[]) => Promise<unknown>) {
      let start: string | undefined
      const r = await detachWith(async (...a: unknown[]) => {
        const { args } = a[0] as { args: (string | null)[] }
        const flag = args.find((x) => typeof x === 'string' && x.startsWith('--detached-child='))!
        start = (decodeChildSpec(flag.slice('--detached-child='.length)) as { start?: string }).start
        return { ok: false, blocked: true, message: 'not run' }
      }, signIn)
      return { start, dataDir: r.dataDir }
    }

    it('says through WMI, and that this user’s sign-in was not found, with how many desktops there were', async () => {
      expect((await wmiStart(async () => ({ started: false, reason: 'nosession', desktops: 1 }))).start).toBe(
        "through WMI: no Windows sign-in of this user was found (none of the 1 Explorer in desktop sessions is this account's)",
      )
      expect((await wmiStart(async () => ({ started: false, reason: 'nosession', desktops: 3, unreadable: 2 }))).start).toBe(
        "through WMI: no Windows sign-in of this user was found (none of the 3 Explorers in desktop sessions is this account's, 2 of them with an owner WMI would not tell)",
      )
      expect((await wmiStart(async () => ({ started: false, reason: 'nosession', desktops: 0 }))).start).toBe('through WMI: no Windows sign-in of this user was found (no Explorer in any desktop session)')
      expect((await wmiStart(async () => ({ started: false, reason: 'nosession' }))).start).toBe('through WMI: no Windows sign-in of this user was found (no Explorer of this account in a desktop session)')
    })

    it('says the task failed and why, or that it is turned off', async () => {
      expect((await wmiStart(async () => ({ started: false, reason: 'error', message: 'Access is denied.' }))).start).toBe('through WMI: the sign-in task failed: Access is denied.')
      expect((await wmiStart(async () => ({ started: false, reason: 'off' }))).start).toBe('through WMI: the sign-in task is turned off (CENTRALU_SIGNIN_TASK=off)')
      // It travels on the launcher's command line, so a long refusal is cut
      expect((await wmiStart(async () => ({ started: false, reason: 'error', message: 'x'.repeat(5000) }))).start).toBe(`through WMI: the sign-in task failed: ${'x'.repeat(300)}`)
    })

    it('when the task’s host does not answer, the WMI launcher says so, and serve.log.1 keeps the start before', async () => {
      const r = await wmiStart(async (...a: unknown[]) => {
        writeFileSync(join((a[0] as { dataDir: string }).dataDir, 'serve.log'), 'the previous launcher\n')
        return { started: true, name: 'Centralu host (me)' }
      })
      expect(r.start).toBe('through WMI: the host the sign-in task "Centralu host (me)" started did not answer within 1 s')
      expect(readFileSync(join(r.dataDir, 'serve.log.1'), 'utf8')).toBe('the previous launcher\n')
      // The task's line went with its host, so a WMI start that never ran still shows as no serve.log (wmi_blocked)
      expect(existsSync(join(r.dataDir, 'serve.log'))).toBe(false)
    })

    it('removes a serve.log it cannot move aside, so a WMI start that never ran still reads as wmi_blocked', async () => {
      const r = await detachWith(
        async () => ({ ok: true, pid: 4242, alive: () => true, stop: async () => {} }),
        async (...a: unknown[]) => {
          // What a rename cannot replace: serve.log.1 is a folder
          const { dataDir } = a[0] as { dataDir: string }
          writeFileSync(join(dataDir, 'serve.log'), 'an earlier start\n')
          mkdirSync(join(dataDir, 'serve.log.1', 'x'), { recursive: true })
          return { started: false, reason: 'nosession' }
        },
      )
      expect(r.line.detach).toMatchObject({ ok: false, reason: 'wmi_blocked' })
    }, 30_000 * SLOW)

    it('carries the line to the launcher in its --detached-child spec', () => {
      const spec = decodeChildSpec(encodeChildSpec({ env: {}, log: '/d/serve.log', start: 'through WMI: why' }))
      expect(spec).toEqual({ log: '/d/serve.log', env: {}, start: 'through WMI: why' })
    })
  })

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

/*
 * #1224: a host the hub's ssh started before anyone signed in runs in a network logon, where Git cannot use the
 * credentials saved in Windows. The serve the sign-in task starts takes the folder over, but only once that host has
 * nothing running a person would lose: Windows has no keeper, so stopping it ends what runs in it
 */
describe('moving a host that runs in a network logon into the Windows sign-in', () => {
  const idle = { working: 0, approvals: 0, questions: 0, background: 0, terminals: 0, commandRuns: 0 }

  /**
   * A host on a data folder's recorded port, with its token: it says `logon`, answers `host.stop {ifIdle}` busy while
   * `counts` (taken one per stop) says something runs and goes when it does not, and keeps what `host.handover` told it
   */
  async function heldFolder(logon: 'network' | 'interactive' | null, counts: Record<string, number>[]) {
    const d = tempDir()
    ensureServeState(d)
    recordServePort(d, await freePort())
    const state = readServeState(d)!
    const calls: string[] = []
    const told: unknown[] = []
    const server: HostServer = new HostServer({
      port: state.port!,
      ...serveHostCredentials(d),
      ...(logon ? { logon: () => logon } : {}),
      build: { commit: 'c', protocolVersion: PROTOCOL_VERSION, version: '1.0.0' },
      onRpc: async (method, params) => {
        calls.push(`${method}${(params as { ifIdle?: boolean })?.ifIdle ? ' ifIdle' : ''}${(params as { forUpdate?: boolean })?.forUpdate ? ' forUpdate' : ''}`)
        if (method === 'host.handover') told.push((params as { handover: unknown }).handover)
        if (method === 'host.stop') {
          const now = counts.length > 1 ? counts.shift()! : counts[0]!
          if ((params as { ifIdle?: boolean })?.ifIdle && Object.values(now).some((n) => n > 0)) return { ok: false, busy: now, calls: 0 }
          setTimeout(() => void server.close(), 20)
          return { ok: true }
        }
        return { ok: true }
      },
    })
    await server.listen()
    const existing = await probeHost({ port: state.port!, token: state.token, protocolVersion: PROTOCOL_VERSION })
    return { d, server, calls, told, existing }
  }

  // #1618: a hub's update stops the host with `CENTRALU_STOP_FOR=update`, and the host lists the turns it ends for the next one
  it('passes an update’s stop on to the host as host.stop {forUpdate}, and only an update’s', async () => {
    for (const [env, call] of [
      [{ CENTRALU_STOP_BY: 'hub', CENTRALU_STOP_FOR: 'update' }, 'host.stop forUpdate'],
      [{ CENTRALU_STOP_BY: 'hub' }, 'host.stop'],
    ] as const) {
      const h = await heldFolder(null, [idle])
      try {
        const lines: string[] = []
        await runStop({ env: { CC_DATA_DIR: h.d, ...env }, home: h.d, entry: SOURCE_HOST, write: (l: string) => void lines.push(l) })
        expect(h.calls.filter((c) => c.startsWith('host.stop'))).toEqual([call])
        expect(JSON.parse(lines.join(''))).toMatchObject({ v: 1, stop: { ok: true, wasRunning: true } })
      } finally {
        await h.server.close()
      }
    }
  })

  it('reads the logon a host says in its hello', async () => {
    const h = await heldFolder('network', [idle])
    try {
      expect(h.existing).toMatchObject({ running: true, logon: 'network' })
    } finally {
      await h.server.close()
    }
  })

  /*
   * #1224's review: the check and the stop are one call, `host.stop {ifIdle}`, which the host decides and acts on in one
   * step (lifecycle/stop-gate.ts there); asked as two (the activity, then the stop), a turn the hub started in between
   * was ended with the host
   */
  it('stops only through host.stop {ifIdle}, asking again while it answers busy, and says it waits', async () => {
    const h = await heldFolder('network', [{ ...idle, working: 1 }, { ...idle, terminals: 1 }, idle])
    try {
      const moved = await moveIntoSignIn({ dataDir: h.d, entry: SOURCE_HOST, env: {}, existing: h.existing, platform: 'win32', logonOf: async () => 'interactive', pollMs: 50 })
      expect(moved).toBe(true)
      expect(h.calls.filter((c) => c.startsWith('host.stop'))).toEqual(['host.stop ifIdle', 'host.stop ifIdle', 'host.stop ifIdle'])
      expect(h.calls).not.toContain('host.activity')
      expect(h.told).toEqual([{ state: 'waiting', since: expect.any(Number) }])
      expect((await probeHost({ port: readServeState(h.d)!.port!, token: readServeState(h.d)!.token, protocolVersion: PROTOCOL_VERSION })).running).toBe(false)
    } finally {
      await h.server.close()
    }
  })

  it('gives up after the bound with the host still busy, says so to the host, and never stops it', async () => {
    const h = await heldFolder('network', [{ ...idle, working: 1 }])
    let clock = 0
    try {
      const moved = await moveIntoSignIn({
        dataDir: h.d,
        entry: SOURCE_HOST,
        env: {},
        existing: h.existing,
        platform: 'win32',
        logonOf: async () => 'interactive',
        pollMs: 10,
        maxWaitMs: 30 * 60_000,
        // Ten minutes pass between two asks
        now: () => (clock += 10 * 60_000),
      })
      expect(moved).toBe(false)
      expect(h.told.map((t) => (t as { state: string }).state)).toEqual(['waiting', 'gave_up'])
      expect(h.calls.every((c) => c !== 'host.stop')).toBe(true)
      expect((await probeHost({ port: readServeState(h.d)!.port!, token: readServeState(h.d)!.token, protocolVersion: PROTOCOL_VERSION })).running).toBe(true)
    } finally {
      await h.server.close()
    }
  })

  it('moves nothing that is not a network logon, nor from a serve that is not in the sign-in itself, nor off Windows', async () => {
    for (const [logon, mine, platform] of [
      ['interactive', 'interactive', 'win32'],
      [null, 'interactive', 'win32'],
      ['network', 'network', 'win32'],
      ['network', null, 'win32'],
      ['network', 'interactive', 'linux'],
    ] as const) {
      const h = await heldFolder(logon, [idle])
      try {
        expect(await moveIntoSignIn({ dataDir: h.d, entry: SOURCE_HOST, env: {}, existing: h.existing, platform, logonOf: async () => mine, pollMs: 50 }), `${logon} ${mine} ${platform}`).toBe(false)
        expect(h.calls.filter((c) => c.startsWith('host.stop'))).toEqual([])
      } finally {
        await h.server.close()
      }
    }
  })

  /** What the sign-in task runs: `serve` in the foreground, which used to give up on a folder another host held */
  it('starts its own host once the hand-over freed the folder, where it used to refuse', async () => {
    const h = await heldFolder('network', [idle])
    const fake = join(tempDir(), 'host.mjs')
    const ran = `${fake}.ran`
    // As a bundle says it: its protocol, and that it reads the token on stdin
    writeFileSync(join(fake, '..', 'bundle-info.json'), JSON.stringify({ protocolVersion: PROTOCOL_VERSION, tokenOnStdin: 1 }))
    // A stand-in host: reads its token line, says it is ready on the port it was given, then ends
    writeFileSync(
      fake,
      `import { writeFileSync } from 'node:fs'
process.stdin.once('data', () => {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1])
  writeFileSync(${JSON.stringify(ran)}, String(port))
  console.log(JSON.stringify({ ready: true, port, token: 'x' }))
  setTimeout(() => process.exit(0), 50)
})
`,
    )
    let asked = 0
    try {
      const code = await runServe({
        env: { CC_DATA_DIR: h.d },
        home: h.d,
        entry: fake,
        version: '1.0.0',
        cliPath: null,
        platform: 'win32',
        handOver: async (o: { existing: { logon?: string } }) => {
          asked++
          expect(o.existing.logon).toBe('network')
          await h.server.close()
          return true
        },
      })
      expect(asked).toBe(1)
      expect(code).toBe(0)
      expect(existsSync(ran)).toBe(true)
    } finally {
      await h.server.close()
    }
  }, 60_000 * SLOW)
})

/*
 * #1223: the desktop window on Windows found the folder held by the host a hub's link started there, and its own host
 * was refused by the lock: "Could not start the agent host". With serve installed in the folder, the window runs
 * `serve --window` instead, which hands it the folder's serve host (started in this sign-in when none runs)
 */
describe('centralu serve --window: the desktop window uses the folder’s serve host', () => {
  async function folder() {
    const d = tempDir()
    ensureServeState(d)
    recordServePort(d, await freePort())
    return { d, state: readServeState(d)! }
  }
  const hostOn = async (state: { port: number | null; token: string }, logon: 'network' | 'interactive' = 'interactive', d = '') => {
    const server = new HostServer({ port: state.port!, ...serveHostCredentials(d), logon: () => logon, onRpc: async () => ({}), build: { commit: 'c', protocolVersion: PROTOCOL_VERSION, version: '1.0.0' } })
    await server.listen()
    return server
  }
  const window = (d: string, o: Record<string, unknown> = {}) => {
    const lines: string[] = []
    const stdin = new PassThrough()
    const calls = { detach: 0, signIn: 0 }
    const done = runWindow({
      env: { CC_DATA_DIR: d },
      home: d,
      entry: SOURCE_HOST,
      version: '1.0.0',
      cliPath: null,
      platform: 'win32',
      write: (l: string) => void lines.push(l),
      stdin,
      detach: async () => {
        calls.detach++
        throw new Error('not asked')
      },
      signIn: async () => {
        calls.signIn++
        return { started: true, name: 'Centralu host' }
      },
      pollMs: 50,
      misses: 3,
      ...o,
    }) as Promise<number>
    return { lines, stdin, calls, done }
  }

  it('hands the window the running host’s port and token as a ready line, and leaves the host running when the window goes', async () => {
    const { d, state } = await folder()
    const server = await hostOn(state, 'interactive', d)
    try {
      const w = window(d)
      await vi.waitFor(() => expect(w.lines).toHaveLength(1))
      // A full credential made for the window at this start (#1405): serve.json keeps only its verifier
      const ready = JSON.parse(w.lines[0]!)
      expect(ready).toEqual({ ready: true, port: state.port, token: expect.any(String), db: join(d, 'store.db') })
      expect(readServeState(d).full).toEqual([expect.objectContaining({ label: 'window', verifier: verifierOf(ready.token) })])
      expect(readFileSync(join(d, SERVE_STATE_FILE), 'utf8')).not.toContain(ready.token)
      expect(await hello(Number(state.port), ready.token)).toMatchObject({ kind: 'hello_ok' })
      expect(w.calls).toEqual({ detach: 0, signIn: 0 })
      w.stdin.end()
      expect(await w.done).toBe(0)
      expect((await probeHost({ port: state.port!, token: state.token, protocolVersion: PROTOCOL_VERSION })).running).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('starts the host the way --detach does when none runs, then ends when that host stops answering, so the window starts it again', async () => {
    const { d, state } = await folder()
    let server: HostServer | null = null
    try {
      const w = window(d, {
        detach: async (o: { write: (l: string) => void }) => {
          server = await hostOn(state, 'interactive', d)
          o.write(`${JSON.stringify({ v: 1, port: state.port, hostRunning: true, detach: { ok: true, how: 'task', already: false } })}\n`)
          return 0
        },
      })
      await vi.waitFor(() => expect(w.lines).toHaveLength(1))
      expect(JSON.parse(w.lines[0]!)).toMatchObject({ ready: true, port: state.port, token: expect.any(String) })
      await server!.close()
      expect(await w.done).toBe(1)
    } finally {
      await (server as HostServer | null)?.close()
    }
  })

  it('says why and prints no ready line when the host cannot be started', async () => {
    const { d } = await folder()
    const w = window(d, {
      detach: async (o: { write: (l: string) => void }) => {
        o.write(`${JSON.stringify({ v: 1, detach: { ok: false, how: 'wmi', reason: 'wmi_blocked', message: 'blocked' } })}\n`)
        return 1
      },
    })
    expect(await w.done).toBe(1)
    expect(w.lines).toEqual([])
  })

  it('uses a host in a network logon now, and starts the sign-in task that moves it into this sign-in once idle (#1224)', async () => {
    const { d, state } = await folder()
    const server = await hostOn(state, 'network', d)
    try {
      const w = window(d)
      await vi.waitFor(() => expect(w.lines).toHaveLength(1))
      expect(w.calls).toEqual({ detach: 0, signIn: 1 })
      w.stdin.end()
      expect(await w.done).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('takes no port: the one serve recorded is the window’s', () => {
    expect(parseServeArgs(['--window'])).toEqual({ mode: 'window', port: null })
    expect(parseServeArgs(['--window', '--port', '9000']).error).toMatch(/--window .* takes no --port/)
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

  // The sh launcher; the Windows .cmd one is the test after it
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
async function cli(dataDir: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return await new Promise<{ code: number | null; line: Record<string, any>; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve', ...args], { cwd: ROOT, env: { ...cliEnv(dataDir), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
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


describe('centralu serve --detach and --stop, end to end (a host from source, a temporary data folder)', () => {
  // What a test has seen end is not signalled afterwards: its number may be someone else's by then (#1308)
  let own = ownProcesses()
  const alive = (pid: number) => own.alive(pid)
  beforeEach(() => {
    own = ownProcesses()
  })
  /** Ends what a failed test left running: only the processes this data folder's files name, which this test started and has not seen end */
  function cleanup(d: string) {
    for (const file of [SERVE_PID_FILE, 'host.lock']) {
      try {
        own.end([(JSON.parse(readFileSync(join(d, file), 'utf8')) as { pid: number }).pid])
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
        // How it was started, and on Windows why not in the sign-in (#1223)
        expect(serveLog).toMatch(POSIX ? /started in the background through setsid \(pid \d+/ : /started in the background through WMI: the sign-in task is turned off \(CENTRALU_SIGNIN_TASK=off\) \(pid \d+/)
        expect(serveLog).not.toContain(String(started.line.token))

        expect((await cli(d, ['--stop'])).line).toMatchObject({ v: 1, stop: { ok: true, wasRunning: false } })
      } finally {
        cleanup(d)
      }
    },
    120_000 * SLOW,
  )

  /*
   * #1143: the person's stop is remembered, so a linked hub does not start the host again by itself; the hub's own stop
   * (an update) is not the person's, and the next host to start here, whoever starts it, takes the mark away
   */
  it(
    'remembers the person’s --stop for --connection, not the hub’s, and the next start takes it away',
    async () => {
      const d = tempDir()
      try {
        ensureServeState(d)
        const port = await freePort()
        expect((await cli(d, ['--detach', '--port', String(port)])).line).toMatchObject({ hostRunning: true })
        expect((await cli(d, ['--stop'], { CENTRALU_STOP_BY: 'hub' })).line.stop).toMatchObject({ ok: true, wasRunning: true })
        expect(await connection(d)).not.toHaveProperty('stopped')
        expect((await cli(d, ['--detach'])).line).toMatchObject({ hostRunning: true })
        expect((await cli(d, ['--stop'])).line.stop).toMatchObject({ ok: true, wasRunning: true })
        const line = await connection(d)
        expect(line).toMatchObject({ hostRunning: false, stopped: { by: 'stop', at: expect.any(Number) } })
        // Started again (here --detach, as a hub does at the person's Start): the host removes the mark
        const again = await cli(d, ['--detach'])
        expect(again.line).toMatchObject({ hostRunning: true })
        expect(again.line).not.toHaveProperty('stopped')
        expect(existsSync(join(d, SERVE_STOPPED_FILE))).toBe(false)
        expect((await cli(d, ['--stop'], { CENTRALU_STOP_BY: 'hub' })).line.stop).toMatchObject({ ok: true })
      } finally {
        cleanup(d)
      }
    },
    180_000 * SLOW,
  )

  // The process group is POSIX's. Windows has no group to kill at once; its counterpart is the first test above, where the
  // host started through WMI belongs to no session at all
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
        /*
         * What lets the launcher and the host outlive the session is being outside its process group (#845). The test
         * used to kill the group, wait a fixed second and find the host answering, which a loaded machine could do
         * before a kill that reached the host had landed. The groups are read first, so no wait decides it.
         */
        const { pid, hostPid } = JSON.parse(readFileSync(join(d, SERVE_PID_FILE), 'utf8')) as { pid: number; hostPid: number }
        const groups = [pid, hostPid].map((p) => Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(p)], { encoding: 'utf8' }).stdout.trim()))
        expect(groups.every((g) => g > 0)).toBe(true)
        expect(groups).not.toContain(session.pid)
        // The session ends the way sshd can end one: every process in its group, at once
        const ended = new Promise((r) => session.once('exit', r))
        process.kill(-session.pid!, 'SIGKILL')
        await ended
        expect(alive(pid) && alive(hostPid)).toBe(true)
        expect((await connection(d)).hostRunning).toBe(true)
        expect((await cli(d, ['--stop'])).line.stop).toMatchObject({ ok: true, how: 'asked' })
      } finally {
        cleanup(d)
      }
    },
    120_000 * SLOW,
  )
})

/*
 * `serve --connection`, `serve` and `serve --stop` ask the host on the recorded port with the token (#838). Another
 * account on the linked machine can hold that port while the host is down: the token goes out only after the host
 * proves it holds it, and `proof` in the line comes from the installed build, not from whatever answers.
 */
describe('asking the host on the port without handing the token to anyone else (#838)', () => {
  const TOKEN = 'serve-token-'.padEnd(43, 'x')
  // `ws` is the host's dependency, not the root's: taken from there
  type Peer = { on(e: 'message', f: (d: unknown) => void): void; send(s: string): void }
  type Wss = { on(e: 'connection', f: (ws: Peer) => void): void; once(e: 'listening', f: () => void): void; address(): unknown; close(f: () => void): void }
  const { WebSocketServer } = createRequire(join(ROOT, 'packages/agent-host/package.json'))('ws') as { WebSocketServer: new (o: { port: number; host: string }) => Wss }
  async function squatter() {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const got: string[] = []
    // It answers a prove with a guess, and a hello as a host would
    wss.on('connection', (ws) => ws.on('message', (d) => {
      got.push(String(d))
      const f = JSON.parse(String(d)) as { kind: string; nonce?: string }
      ws.send(JSON.stringify(f.kind === 'prove' ? { kind: 'proof', nonce: f.nonce, mac: 'A'.repeat(43) } : { kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION, resyncRequired: false, currentSeq: 0 }))
    }))
    return { port: (wss.address() as { port: number }).port, got, close: () => new Promise<void>((r) => wss.close(() => r())) }
  }

  it('a program on the port gets a nonce, never the token, from the probe and from --stop', async () => {
    const s = await squatter()
    try {
      const probe = await probeHost({ port: s.port, token: TOKEN, protocolVersion: PROTOCOL_VERSION, prove: true })
      expect(probe).toEqual({ running: false, unproven: true })
      expect(await askHostToStop({ port: s.port, token: TOKEN, protocolVersion: PROTOCOL_VERSION, prove: true })).toMatchObject({ ok: false })
      expect(s.got.join('\n')).not.toContain(TOKEN)
      expect(s.got.map((g) => JSON.parse(g).kind)).toEqual(['prove', 'prove'])
      // Not this folder's host: no live lock holder
      expect(heldHere(probe, tempDir())).toBe(false)
    } finally {
      await s.close()
    }
  })

  it('the real host proves it and then gets the hello', async () => {
    const server = new HostServer({ port: 0, token: TOKEN, onRpc: async () => ({}), build: { commit: 'c', protocolVersion: PROTOCOL_VERSION, version: '9.9.9' } })
    const port = await server.listen()
    try {
      expect(await probeHost({ port, token: TOKEN, protocolVersion: PROTOCOL_VERSION, prove: true })).toEqual({ running: true, protocolVersion: PROTOCOL_VERSION, version: '9.9.9' })
    } finally {
      await server.close()
    }
  })

  /*
   * A refusal for another protocol names the host's in `data` for a program to read (server.ts), and in the sentence
   * for a person. `--stop` read `data` first; the probe behind `--connection` read only the sentence, so a rewording
   * there would have reported no protocol. Both read it the same way now.
   */
  it('reads the host protocol a version_mismatch names in its data, in the probe as in --stop', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    wss.on('connection', (ws) => ws.on('message', () => {
      ws.send(JSON.stringify({ kind: 'res', id: null, ok: false, error: { code: 'version_mismatch', message: 'Update Centralu.', retryable: false, data: { protocolVersion: 7 } } }))
    }))
    const port = (wss.address() as { port: number }).port
    try {
      expect(await probeHost({ port, token: TOKEN, protocolVersion: PROTOCOL_VERSION })).toEqual({ running: true, protocolVersion: 7 })
      expect(await askHostToStop({ port, token: TOKEN, protocolVersion: PROTOCOL_VERSION })).toMatchObject({ ok: false, protocolVersion: 7 })
    } finally {
      await new Promise<void>((r) => wss.close(() => r()))
    }
  })

  it('takes proof from the installed build: a bundle that says hostProof, or the source', () => {
    const d = tempDir()
    expect(hostProvesOf(join(d, 'main.mjs'))).toBe(false)
    writeFileSync(join(d, 'bundle-info.json'), JSON.stringify({ protocolVersion: 1 }))
    expect(hostProvesOf(join(d, 'main.mjs'))).toBe(false)
    writeFileSync(join(d, 'bundle-info.json'), JSON.stringify({ protocolVersion: 1, hostProof: 1 }))
    expect(hostProvesOf(join(d, 'main.mjs'))).toBe(true)
    expect(hostProvesOf(SOURCE_HOST)).toBe(true)
  })
})

/*
 * A host.lock a dead host left names a pid another process of the same user may have now (#838 review): counted as the
 * folder's host, `--stop` would signal that stranger. Only the process that started when the lock says counts.
 */
describe('the pid host.lock names', () => {
  it('reads it in both forms a host writes, and nothing else', () => {
    const d = tempDir()
    expect(lockHolderPid(d)).toBeNull()
    const at = (text: string) => {
      writeFileSync(join(d, 'host.lock'), text)
      return lockHolderPid(d)
    }
    expect(at('4242\n')).toBe(4242)
    expect(at(JSON.stringify({ pid: 4242, started: 'Thu Oct 16 10:00:00 2026' }))).toBe(4242)
    expect(at(JSON.stringify({ pid: 4242 }))).toBe(4242)
    for (const bad of ['0', '{"pid":0}', '{"pid":-3}', '{"pid":"4242"}', '{"pid":4.5}', '"4242"', '4.0', 'null', 'not a lock', '']) expect(at(bad), bad).toBeNull()
  })

  // So a serve refused on a folder says whose host holds it (#1223): what it says, never what it does not
  it('reads who started that host when the lock says, and nothing it does not know', () => {
    const d = tempDir()
    const at = (v: unknown) => {
      writeFileSync(join(d, 'host.lock'), JSON.stringify(v))
      return lockHolder(d)
    }
    expect(at({ pid: 4242, started: null, by: 'app', at: 1 })).toEqual({ pid: 4242, started: null, by: 'app' })
    expect(at({ pid: 4242, started: null, by: 'serve', from: { hub: 'Mac' } })).toEqual({ pid: 4242, started: null, by: 'serve' })
    expect(at({ pid: 4242, started: null, by: 'robot' })).toEqual({ pid: 4242, started: null })
    writeFileSync(join(d, 'host.lock'), '77')
    expect(lockHolder(d)).toEqual({ pid: 77, started: null })
  })
})

describe.skipIf(!POSIX)('the folder’s host, by the lock and the start time it records', () => {
  const lock = (d: string, v: unknown) => writeFileSync(join(d, 'host.lock'), typeof v === 'string' ? v : JSON.stringify(v))

  it('is the live process that started when host.lock says, and nothing else', () => {
    const d = tempDir()
    const started = processStartTime(process.pid)
    expect(started).toEqual(expect.any(String))
    lock(d, { pid: process.pid, started })
    expect(lockHolderIsAlive(d)).toBe(true)
    expect(heldHere({ running: false, unproven: true }, d)).toBe(true)
    // The same pid, started at another time: the pid was reused
    lock(d, { pid: process.pid, started: 'Thu Jan  1 00:00:00 1970' })
    expect(lockHolderIsAlive(d)).toBe(false)
    expect(heldHere({ running: false, unproven: true }, d)).toBe(false)
    // No start time (a host from before it was recorded): cannot be told apart, so not counted
    lock(d, String(process.pid))
    expect(lockHolderIsAlive(d)).toBe(false)
    // A proven host is the host whatever the lock says
    expect(heldHere({ running: true }, d)).toBe(true)
  })
})
