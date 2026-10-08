/**
 * `centralu serve`: the host without the app, for the remote mode's first phase (#82).
 *
 * The person starts this by hand on another machine (an SSH server, later a laptop). It runs the
 * same bundled host the app runs (`resources/host/main.mjs`, on the system Node), with no window
 * and no keeper, bound to 127.0.0.1 only. The app on the person's own computer reaches it through
 * an SSH local forward, so nothing ever listens on a public interface. The design and its limits
 * are in docs/agent-host.md §4.7; the trust argument in docs/security-boundaries.md.
 *
 * `centralu serve --connection` is the one question the client asks over `ssh <target>`: where to
 * forward and how to authenticate. It answers with one JSON line on stdout and nothing else.
 *
 * Everything here takes its inputs as arguments (environment, home, platform) instead of reading
 * `process`, so `tooling/launcher-serve.test.ts` can import it: `centralu.mjs` runs a command at
 * import time and cannot be imported by a test. package.json "files" lists the whole bin/
 * directory, so this ships automatically.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, closeSync } from 'node:fs'
import { connect } from 'node:net'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * The port `serve` listens on unless told otherwise, and keeps across restarts.
 *
 * Stable, because the client is told it once per connection and the person may write it into an
 * SSH config or a systemd unit. Below 20000 on purpose: every OS lends ports from its ephemeral
 * range to outgoing connections (Linux 32768–60999, macOS and Windows 49152–65535), and the host
 * itself hands out per-app view origins from 20000–32767 (views/origin-ports.ts). A default inside
 * either range could be taken by something transient the day the host restarts.
 */
export const DEFAULT_SERVE_PORT = 17175

/**
 * The file in the data folder that holds the token and the port, mode 0600.
 *
 * The token is generated once, the first time either `serve` or `serve --connection` runs, and kept:
 * the client stores it (in the OS secret store) and has to find the same one after the host
 * restarts. The port is the one the last `serve` actually listened on, which is how
 * `--connection`, a separate process, learns a `--port` given to `serve` in a systemd unit.
 */
export const SERVE_STATE_FILE = 'serve.json'

/** What a detached serve writes: its own lines, and the host's until it is ready (host.log has the rest) */
export const SERVE_LOG_FILE = 'serve.log'

/** The running launcher's pid and port, so `--stop` can find it. Removed when it exits */
export const SERVE_PID_FILE = 'serve.pid'

export const SERVE_HELP = `centralu serve: run the Centralu host on this machine, without a window

  centralu serve                  Start the host in the foreground, on 127.0.0.1 only
  centralu serve --port <n>       ... on that port (kept for the next start; default ${DEFAULT_SERVE_PORT})
  centralu serve --detach         Start it in the background, outside this session; return once it answers
  centralu serve --stop           Ask the running host to stop, and wait until it has
  centralu serve --connection     Print how to reach it as one JSON line, then exit
  centralu serve --rotate-token   Replace the token (a running serve keeps the old one until restarted)

The data folder is ~/.centralu (CC_DATA_DIR overrides it). The app on another computer reaches
this host through an SSH local forward, and starts it with --detach when it is not running.
Stop a foreground one with Ctrl+C or SIGTERM, a detached one with --stop. A detached one writes
how its start went to serve.log in the data folder; the host's own log is host.log.

serve, --detach and --connection keep ~/.centralu/bin/centralu up to date: a launcher with absolute
paths, for SSH sessions whose PATH has neither npm's global folder nor node. Not when they run
from an install the app made over SSH, which has a launcher of its own.`

/** The flags that each make serve a different command */
const MODE_FLAGS = { '--connection': 'connection', '--rotate-token': 'rotate', '--detach': 'detach', '--stop': 'stop' }
const FLAG_OF = Object.fromEntries(Object.entries(MODE_FLAGS).map(([f, m]) => [m, f]))

/**
 * The argument a detached launcher is started with: what it needs from the `--detach` that started
 * it, which a process created through WMI does not inherit (it gets the account's default
 * environment, not this one). Never a secret: the token stays in serve.json. Internal, not in the help.
 */
const CHILD_FLAG = '--detached-child='

/**
 * What the arguments after `serve` ask for: `{ mode, port }` (plus `child` for a detached launcher)
 * or `{ error }`.
 *
 * `mode` is `serve`, `detach`, `stop`, `connection`, `rotate` or `help`; `port` is null when not
 * given. `--port` goes with `serve` and `--detach` only: `--connection` has to report the port
 * `serve` uses, not one the caller names, and `--stop` stops the one that runs.
 */
export function parseServeArgs(argv) {
  let mode = 'serve'
  let port = null
  let help = false
  let child = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (Object.hasOwn(MODE_FLAGS, a)) {
      const m = MODE_FLAGS[a]
      if (mode !== 'serve' && mode !== m) return { error: `${FLAG_OF[mode]} and ${a} are separate commands; pass one` }
      mode = m
    } else if (a === '--help' || a === '-h') help = true
    else if (a.startsWith(CHILD_FLAG)) child = a.slice(CHILD_FLAG.length)
    else if (a === '--port' || a.startsWith('--port=')) {
      const raw = a === '--port' ? argv[++i] : a.slice('--port='.length)
      const n = parsePort(raw)
      if (n === null) return { error: `--port needs a port number between 1 and 65535 (got ${raw === undefined ? 'nothing' : JSON.stringify(raw)})` }
      port = n
    } else return { error: `unknown option for serve: ${a}\n\n${SERVE_HELP}` }
  }
  if (help) return { mode: 'help', port }
  if (child !== null) {
    if (mode !== 'serve') return { error: `${CHILD_FLAG.slice(0, -1)} is how --detach starts serve, not an option of ${FLAG_OF[mode]}` }
    return { mode, port, child }
  }
  if ((mode === 'connection' || mode === 'rotate') && port !== null) {
    return { error: '--port goes with `centralu serve`; `--connection` reports the port serve listens on' }
  }
  if (mode === 'stop' && port !== null) return { error: '--stop stops the serve that is running, on the port it recorded; it takes no --port' }
  return { mode, port }
}

function parsePort(raw) {
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= 65535 ? n : null
}

/** The data folder: the host's own rule (`dataRoot()` in agent-host), CC_DATA_DIR or ~/.centralu */
export function serveDataDir(env, home) {
  return env.CC_DATA_DIR || join(home, '.centralu')
}

/** The state, or null when there is none yet or it cannot be read as one */
export function readServeState(dataDir) {
  let raw
  try {
    raw = readFileSync(join(dataDir, SERVE_STATE_FILE), 'utf8')
  } catch {
    return null
  }
  try {
    const v = JSON.parse(raw)
    if (typeof v?.token !== 'string' || v.token.length < 32) return null
    return { token: v.token, port: Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535 ? v.port : null }
  } catch {
    return null
  }
}

/**
 * The state, created on first use. Never replaces a token that is already there.
 *
 * Created with `wx`, so two first runs at the same moment (a `serve` and a `--connection`) cannot
 * each write a different token: the second one fails to create and reads the first one's. A file
 * that exists but cannot be read as state is refused rather than overwritten: it may be a token
 * the client already holds, and a silent new one would lock that client out with "bad token".
 */
export function ensureServeState(dataDir, platform = process.platform) {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, SERVE_STATE_FILE)
  if (!existsSync(file)) {
    const token = randomBytes(32).toString('base64url')
    try {
      writePrivate(file, { v: 1, token, port: null }, 'wx')
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
    }
  }
  const state = readServeState(dataDir)
  if (!state) throw new Error(`${file} exists but is not a serve state file. Move it aside and run again.`)
  keepPrivate(file, platform)
  return state
}

/** Writes the port `serve` listened on, keeping the token. Atomic: a temp file renamed over it */
export function recordServePort(dataDir, port, platform = process.platform) {
  const file = join(dataDir, SERVE_STATE_FILE)
  const state = readServeState(dataDir)
  if (!state) throw new Error(`${file} is missing or unreadable`)
  if (state.port === port) return
  const tmp = `${file}.${process.pid}.tmp`
  writePrivate(tmp, { v: 1, token: state.token, port }, 'wx')
  renameSync(tmp, file)
  keepPrivate(file, platform)
}

/**
 * A new token, keeping the port. Only when the person asks (`--rotate-token`): every client that
 * stored the old one has to fetch the new one with `--connection`, and a serve already running
 * keeps answering to the old one until it restarts.
 */
export function rotateServeToken(dataDir, platform = process.platform) {
  const before = ensureServeState(dataDir, platform)
  const file = join(dataDir, SERVE_STATE_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  writePrivate(tmp, { v: 1, token: randomBytes(32).toString('base64url'), port: before.port }, 'wx')
  renameSync(tmp, file)
  keepPrivate(file, platform)
  return readServeState(dataDir)
}

/**
 * The launcher `serve` keeps at `<data folder>/bin/centralu` (`centralu.cmd` on Windows).
 *
 * The client runs `ssh -T -o BatchMode=yes <target> centralu …`, and a non-interactive SSH shell
 * reads no profile: npm's global bin under nvm, fnm, volta or `~/.npm-global` is not on its PATH,
 * and often neither is `node`. So the plain name fails with exit 127, and the person, who just ran
 * `centralu serve` in their own shell, sees no reason why. This file names both by absolute path,
 * so `~/.centralu/bin/centralu` works from any shell. It is rewritten whenever it differs from
 * what this run would write, which follows a Node upgrade or a moved npm prefix on the next start.
 */
export function launcherScript(platform, execPath, cliPath) {
  if (platform === 'win32') {
    return `@echo off\r\nrem Written by \`centralu serve\`: reaches this install without npm's folder on PATH.\r\n"${execPath}" "${cliPath}" %*\r\n`
  }
  const q = (v) => `'${String(v).replaceAll("'", "'\\''")}'`
  return (
    '#!/bin/sh\n' +
    "# Written by `centralu serve`: reaches this install from a shell whose PATH has neither npm's global\n" +
    '# folder nor node (a non-interactive SSH session). Rewritten when node or the package moves.\n' +
    `exec ${q(execPath)} ${q(cliPath)} "$@"\n`
  )
}

/** Writes the launcher if it is missing or out of date. Returns its path. Never fatal to the caller */
export function ensureLauncher(dataDir, { platform = process.platform, execPath = process.execPath, cliPath }) {
  const file = join(dataDir, 'bin', platform === 'win32' ? 'centralu.cmd' : 'centralu')
  const want = launcherScript(platform, execPath, cliPath)
  let have = null
  try {
    have = readFileSync(file, 'utf8')
  } catch {
    // not there yet
  }
  if (have !== want) {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    const fd = openSync(tmp, 'w', 0o755)
    try {
      writeSync(fd, want)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  }
  if (platform !== 'win32' && (statSync(file).mode & 0o777) !== 0o755) chmodSync(file, 0o755)
  return file
}

/**
 * ensureLauncher, with a failure said on stderr instead of thrown: the launcher is a convenience.
 *
 * Not under the managed launcher (`CENTRALU_MANAGED=1`, docs/plans/remote-hub.md §10.1): an install
 * the hub made over ssh has its own launcher in `<data>/remote/bin/`, which reads `current`. Writing
 * `<data>/bin/centralu` from there would point an npm install's launcher at one managed version, and
 * the two would rewrite each other's file on every start.
 */
function keepLauncher(dataDir, cliPath, env) {
  if (!cliPath || env?.CENTRALU_MANAGED === '1') return
  try {
    ensureLauncher(dataDir, { cliPath })
  } catch (e) {
    say(`could not write the launcher in ${join(dataDir, 'bin')}: ${e.message}`)
  }
}

/**
 * Created 0600 from the first byte, not chmod-ed after: a file written with the default mode and
 * narrowed afterwards is readable by everyone on the machine for the moment in between.
 */
function writePrivate(file, value, flag) {
  const fd = openSync(file, flag, 0o600)
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`)
  } finally {
    closeSync(fd)
  }
}

/**
 * 0600 again on every use. A copy, a restore from backup or an editor that rewrites the file can
 * leave it readable by the group; the token in it is the key to every RPC. Windows has no mode
 * bits to set (the profile folder's ACL is what protects it there).
 */
function keepPrivate(file, platform) {
  if (platform === 'win32') return
  if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600)
}

/**
 * The protocol a host folder speaks, from the `bundle-info.json` the bundler writes next to
 * `main.mjs`. For a host run from source (`CENTRALU_HOST_ENTRY=…/src/main.ts`) there is no bundle
 * info, so the constant is read where the bundler reads it. null when neither is there.
 */
export function protocolVersionOf(entry) {
  try {
    const v = JSON.parse(readFileSync(join(dirname(entry), 'bundle-info.json'), 'utf8')).protocolVersion
    if (Number.isInteger(v)) return v
  } catch {
    // not a bundle; try the source below
  }
  try {
    const src = readFileSync(join(dirname(entry), '..', '..', 'protocol', 'src', 'envelope.ts'), 'utf8')
    const m = /export const PROTOCOL_VERSION = (\d+)/.exec(src)
    if (m) return Number(m[1])
  } catch {
    // nothing to read
  }
  return null
}

/**
 * The `--connection` answer. The shape is the client's interface (docs/agent-host.md §4.7).
 * `install` (additive, the line stays `v: 1`) says what runs this command (`installInfo`); `detach`
 * is added by `--detach` only.
 */
export function connectionLine({ port, token, version, protocolVersion, dataDir, hostRunning, install, detach }) {
  return JSON.stringify({
    v: 1,
    port,
    token,
    version,
    protocolVersion,
    dataDir,
    hostRunning,
    ...(install ? { install } : {}),
    ...(detach ? { detach } : {}),
  })
}

/**
 * The install the hub manages on this machine (docs/plans/remote-hub.md §10.1): side-by-side
 * versions, the pinned Node they run on, and two pointer files naming what runs and what to roll
 * back to. The hub's installer writes it; `serve` only reads it.
 */
export function remoteLayout(dataDir) {
  const root = join(dataDir, 'remote')
  return {
    root,
    current: join(root, 'current'),
    previous: join(root, 'previous'),
    versions: join(root, 'versions'),
    node: join(root, 'node'),
    bin: join(root, 'bin'),
  }
}

/** A word a pointer file may hold: a folder name, nothing a path could escape with */
const POINTER_WORD = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

/** `current` / `previous`: one line, "<centralu version> <node version>". null for anything else */
export function parsePointer(text) {
  const m = /^\s*(\S+)[ \t]+(\S+)\s*$/.exec(String(text ?? ''))
  if (!m || !POINTER_WORD.test(m[1]) || !POINTER_WORD.test(m[2])) return null
  return { version: m[1], node: m[2] }
}

/**
 * The connection line's `install` field (docs/plans/remote-hub.md §10.5): whether this command was
 * started by the managed launcher, the managed install's `current` and `previous`, and the Node
 * running this command. Read from the machine at every ask, never kept by the hub (S12).
 */
export function installInfo(dataDir, env, nodeVersion = process.versions.node) {
  const l = remoteLayout(dataDir)
  const read = (file) => {
    try {
      return parsePointer(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  return { managed: env.CENTRALU_MANAGED === '1', current: read(l.current), previous: read(l.previous), node: nodeVersion }
}

/**
 * The managed launcher, `<data>/remote/bin/centralu` (`centralu.cmd` on Windows), as the installer
 * writes it (docs/plans/remote-hub.md §10.1, S8).
 *
 * **Its text never changes.** It reads `current` at every start and runs that version's
 * `centralu.mjs` on that version's Node, so switching versions is one file replaced by a rename,
 * atomic on both systems. A launcher rewritten per version would be replaced while it may be
 * running, and cmd.exe reads a batch file by offset as it runs. It sets `CENTRALU_MANAGED=1`, so
 * the `serve` it starts leaves `<data>/bin/` to an npm install on the same machine.
 *
 * Both refuse a pointer that holds anything but plain version words, so an edited `current` cannot
 * point it outside the install.
 */
export function managedLauncherScript(platform) {
  if (platform === 'win32') {
    return (
      [
        '@echo off',
        'rem The Centralu launcher for the install the app manages over SSH. It never changes: it reads',
        'rem "current" at every start, so switching versions replaces that file and never this one.',
        'setlocal',
        'set "CENTRALU_REMOTE=%~dp0.."',
        'set "CENTRALU_LINE="',
        'set "CENTRALU_V="',
        'set "CENTRALU_N="',
        'set /p CENTRALU_LINE=<"%CENTRALU_REMOTE%\\current"',
        'for /f "tokens=1,2" %%a in ("%CENTRALU_LINE%") do (set "CENTRALU_V=%%a" & set "CENTRALU_N=%%b")',
        'if not defined CENTRALU_N goto none',
        'echo %CENTRALU_V% %CENTRALU_N%| findstr /r /c:"^[0-9A-Za-z][0-9A-Za-z.+-]* [0-9A-Za-z][0-9A-Za-z.+-]*$" >nul || goto none',
        'set CENTRALU_MANAGED=1',
        '"%CENTRALU_REMOTE%\\node\\v%CENTRALU_N%\\node.exe" "%CENTRALU_REMOTE%\\versions\\%CENTRALU_V%\\node_modules\\centralu\\bin\\centralu.mjs" %*',
        'exit /b %ERRORLEVEL%',
        ':none',
        'echo Centralu: no version is installed in %CENTRALU_REMOTE% 1>&2',
        'exit /b 1',
      ].join('\r\n') + '\r\n'
    )
  }
  return [
    '#!/bin/sh',
    '# The Centralu launcher for the install the app manages over SSH. It never changes: it reads',
    '# `current` at every start, so switching versions replaces that file and never this one.',
    'remote=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 1',
    'v= n=',
    'read -r v n < "$remote/current" 2>/dev/null',
    'case "$v" in ""|[!0-9A-Za-z]*|*[!0-9A-Za-z.+-]*) echo "Centralu: no version is installed in $remote" >&2; exit 1 ;; esac',
    'case "$n" in ""|[!0-9A-Za-z]*|*[!0-9A-Za-z.+-]*) echo "Centralu: no version is installed in $remote" >&2; exit 1 ;; esac',
    'CENTRALU_MANAGED=1',
    'export CENTRALU_MANAGED',
    'exec "$remote/node/v$n/bin/node" "$remote/versions/$v/node_modules/centralu/bin/centralu.mjs" "$@"',
    '',
  ].join('\n')
}

/**
 * The host's environment.
 *
 * - The token travels in `CC_HOST_TOKEN`, not `--token`: arguments are readable by every user on
 *   the machine (`ps`), a process's environment only by its owner. The host deletes it after
 *   reading, so nothing it spawns inherits it.
 * - `CC_HOST_SOURCE` is the record `hello_ok.build` is made from (keeper-link.ts); without it a
 *   client could not see which version the host it reached is.
 * - Headless: no `DISPLAY` / `WAYLAND_DISPLAY`. Nothing the host or an agent starts gets a screen
 *   to open a window or a keyring prompt on, so a tool that would ask falls back to its file store
 *   or fails with a message in the log instead of waiting on a dialog nobody can see.
 * - The keeper's and dev mode's variables are dropped: this host is neither. So is
 *   `CENTRALU_MANAGED`, which is the launcher's business and would otherwise reach every agent.
 * - `CC_SERVE=1` lets the host take `host.stop` (`--stop`); a host the app runs refuses it.
 */
export function hostEnv(env, { token, dataDir, version, hostDir }) {
  const out = { ...env }
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'CC_KEEPER', 'CC_FRONT_DOOR', 'CC_DEV', 'CC_HOST_TOKEN', 'CC_HOST_SOURCE', 'CENTRALU_MANAGED']) delete out[k]
  out.CC_DATA_DIR = dataDir
  // The host `host.stop` may end (`centralu serve --stop`): nothing else stops it in order on Windows
  out.CC_SERVE = '1'
  out.CC_HOST_TOKEN = token
  out.CC_HOST_SOURCE = JSON.stringify({ version, bundlePath: hostDir })
  return out
}

/**
 * How to start the host.
 *
 * `--watch-parent` with stdin a pipe: if this launcher dies however it dies (SIGKILL included), the
 * pipe closes and the host shuts down with its children, instead of living on unsupervised.
 * `detached` on POSIX puts the host in its own process group, so the terminal's Ctrl+C reaches
 * only this launcher, which passes one SIGINT to the host alone; the host then stops its own
 * children in order. Without it the terminal would signal every agent at the same time as the
 * host. Not on Windows: there `detached` means a new console, and Ctrl+C reaches the host through
 * the console it shares with this launcher.
 */
export function hostCommand(execPath, entry, { port, dataDir, platform }) {
  return {
    command: execPath,
    args: [
      // A source entry (development, tests) needs the TypeScript loader; a bundle does not.
      ...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []),
      entry,
      '--port',
      String(port),
      '--db',
      join(dataDir, 'store.db'),
      '--watch-parent',
    ],
    detached: platform !== 'win32',
  }
}

/** The port from the host's ready line (`{"ready":true,"port":…,"token":…}`), null for any other line */
export function readyPort(line) {
  try {
    const v = JSON.parse(line)
    return v?.ready === true && Number.isInteger(v.port) ? v.port : null
  } catch {
    return null
  }
}

/**
 * The protocol a host's `version_mismatch` refusal names, from either wording: this one's
 * ("this host speaks protocol 2") or the one before it ("server 2, client 1"). null if neither.
 */
export function mismatchServerVersion(message) {
  const m = /host speaks protocol (\d+)|\bserver (\d+)/.exec(String(message ?? ''))
  return m ? Number(m[1] ?? m[2]) : null
}

/**
 * Whether a host that holds this token answers on the port: a real hello, not a TCP connect, so a
 * stranger's program on the same port does not count, and the answer carries the running host's
 * own protocol and version (which differ from the installed package's after an `npm i -g` the
 * host was not restarted for).
 *
 * `{ running, protocolVersion?, version? }`. Node 22.4+ has a global WebSocket; on an older 22
 * this falls back to a TCP connect and reports only `running`.
 */
export function probeHost({ port, token, protocolVersion, timeoutMs = 2000, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== 'function') return tcpProbe(port, timeoutMs)
  return new Promise((resolve) => {
    let ws = null
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws?.close()
      } catch {
        // already closed
      }
      resolve(result)
    }
    const timer = setTimeout(() => done({ running: false }), timeoutMs)
    try {
      ws = new WebSocketImpl(`ws://127.0.0.1:${port}`)
    } catch {
      done({ running: false })
      return
    }
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: protocolVersion ?? 0 }))
    ws.onmessage = (ev) => {
      let m
      try {
        m = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (m?.kind === 'hello_ok') {
        done({
          running: true,
          protocolVersion: Number.isInteger(m.protocolVersion) ? m.protocolVersion : undefined,
          version: typeof m.build?.version === 'string' ? m.build.version : undefined,
        })
      } else if (m?.kind === 'res' && m.ok === false && m.error?.code === 'version_mismatch') {
        // The token was right (it is checked first), so this is our host, on another protocol
        done({ running: true, protocolVersion: mismatchServerVersion(m.error.message) ?? undefined })
      }
    }
    ws.onerror = () => done({ running: false })
    ws.onclose = () => done({ running: false })
  })
}

function tcpProbe(port, timeoutMs) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port })
    const done = (running) => {
      s.destroy()
      resolve({ running })
    }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

/** Who `host.lock` names as the data folder's owner, or null */
export function lockHolderPid(dataDir) {
  try {
    const text = readFileSync(join(dataDir, 'host.lock'), 'utf8').trim()
    const pid = /^\d+$/.test(text) ? Number(text) : JSON.parse(text)?.pid
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/**
 * Where `say` writes: stderr, except in a detached launcher, which nobody reads the stderr of and
 * which writes serve.log instead (`runDetachedChild`).
 */
let sink = (text) => process.stderr.write(text)

/** Writes a line to stderr, prefixed so it reads apart from the host's own log lines */
function say(line) {
  sink(`[centralu serve] ${line}\n`)
}

/** What `--connection` answers, as fields: the running host's versions when one answers, else the installed ones */
async function describe({ env, dataDir, state, entry, version }) {
  const port = state.port ?? DEFAULT_SERVE_PORT
  const installed = protocolVersionOf(entry)
  const probe = await probeHost({ port, token: state.token, protocolVersion: installed })
  const protocolVersion = (probe.running ? probe.protocolVersion : undefined) ?? installed
  if (protocolVersion === null) return null
  return {
    port,
    token: state.token,
    version: (probe.running ? probe.version : undefined) ?? version,
    protocolVersion,
    dataDir,
    hostRunning: probe.running,
    install: installInfo(dataDir, env),
  }
}

/**
 * `centralu serve --connection`. stdout carries exactly one line, the JSON; everything else goes to
 * stderr. Exit 1 when there is no host to describe.
 */
export async function printConnection({ env, home, entry, version, cliPath }) {
  const dataDir = serveDataDir(env, home)
  const state = ensureServeState(dataDir)
  keepLauncher(dataDir, cliPath, env)
  const d = await describe({ env, dataDir, state, entry, version })
  if (!d) {
    say(`cannot read the protocol version of the host at ${entry}`)
    return 1
  }
  process.stdout.write(`${connectionLine(d)}\n`)
  return 0
}

/** serve.pid: `{ pid, hostPid, port }` of the launcher that runs, or null */
export function readServePid(dataDir) {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, SERVE_PID_FILE), 'utf8'))
    return Number.isInteger(v?.pid) && v.pid > 0 ? { pid: v.pid, hostPid: Number.isInteger(v.hostPid) ? v.hostPid : null, port: v.port ?? null } : null
  } catch {
    return null
  }
}

function removeServePid(dataDir, pid) {
  if (readServePid(dataDir)?.pid !== pid) return
  try {
    rmSync(join(dataDir, SERVE_PID_FILE), { force: true })
  } catch {
    // another serve's by now, or gone
  }
}

/**
 * `centralu serve`. Resolves with the exit code once the host has exited.
 *
 * The host's stdout is read here and never passed on: its ready line carries the token, which is
 * printed nowhere but `--connection`. Every other line the host writes to stdout (a lock conflict,
 * a store from a newer build) it also writes to stderr, which is passed through untouched.
 *
 * `logFd` is serve.log of a detached launcher (`runDetachedChild`): the host's stderr goes there
 * until it is ready, so a host that dies while starting (a native module that does not load, a store
 * from a newer build) says why in a file `--detach` can quote. From then on host.log has every line,
 * and serve.log stops growing.
 */
export async function runServe({ env, home, entry, version, cliPath, port: askedPort, platform = process.platform, execPath = process.execPath, logFd = null }) {
  const dataDir = serveDataDir(env, home)
  const state = ensureServeState(dataDir, platform)
  keepLauncher(dataDir, cliPath, env)
  const port = askedPort ?? state.port ?? DEFAULT_SERVE_PORT
  const protocolVersion = protocolVersionOf(entry)

  // A serve that is already up answers on the port it recorded; say so before starting a host that
  // would only fail on the data folder's lock with a less specific message.
  const recorded = state.port ?? DEFAULT_SERVE_PORT
  const existing = await probeHost({ port: recorded, token: state.token, protocolVersion })
  if (existing.running) {
    const pid = lockHolderPid(dataDir)
    say(`centralu serve is already running for ${dataDir} on 127.0.0.1:${recorded}${pid ? ` (pid ${pid})` : ''}. Not starting a second one.`)
    return 1
  }

  const plan = hostCommand(execPath, entry, { port, dataDir, platform })
  const child = spawn(plan.command, plan.args, {
    stdio: ['pipe', 'pipe', logFd === null ? 'inherit' : 'pipe'],
    env: hostEnv(env, { token: state.token, dataDir, version, hostDir: dirname(entry) }),
    detached: plan.detached,
    windowsHide: true,
  })

  let ready = false
  if (logFd !== null) {
    // Read to the end in any case: a pipe nobody drains stops the host once its buffer is full
    child.stderr.on('data', (b) => {
      if (ready) return
      try {
        writeSync(logFd, b)
      } catch {
        // the log is a convenience
      }
    })
  }
  if (child.pid) {
    try {
      writeFileSync(join(dataDir, SERVE_PID_FILE), `${JSON.stringify({ pid: process.pid, hostPid: child.pid, port })}\n`)
    } catch (e) {
      say(`could not write ${SERVE_PID_FILE}: ${e.message}`)
    }
  }
  createInterface({ input: child.stdout }).on('line', (line) => {
    const p = readyPort(line)
    if (p === null || ready) return
    ready = true
    try {
      recordServePort(dataDir, p, platform)
    } catch (e) {
      say(`could not record the port in ${join(dataDir, SERVE_STATE_FILE)}: ${e.message}`)
    }
    say(`listening on 127.0.0.1:${p} (Centralu ${version}, protocol ${protocolVersion ?? 'unknown'}, data ${dataDir})`)
    if (logFd === null) say(`from your computer: ssh -N -L ${p}:127.0.0.1:${p} <this machine>, or let the app connect over SSH`)
    else say(`the host's own log continues in ${join(dataDir, 'host.log')}`)
  })

  /*
   * One signal to the host alone, whatever reached this launcher. SIGHUP (the terminal closed) is
   * passed as SIGTERM: the host has no SIGHUP handler, and Node's default for it is to exit on the
   * spot, skipping the shutdown that stops the agents. A second signal changes nothing on the host
   * side (its shutdown runs once), so forwarding every one is safe.
   */
  const forward = (sig) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (platform === 'win32') return // the host shares the console and received Ctrl+C itself
    try {
      child.kill(sig === 'SIGHUP' ? 'SIGTERM' : sig)
    } catch {
      // already gone
    }
  }
  const signals = platform === 'win32' ? ['SIGINT'] : ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const s of signals) process.on(s, forward)

  return await new Promise((resolve) => {
    child.on('error', (e) => {
      removeServePid(dataDir, process.pid)
      say(`could not start the host (${plan.command}): ${e.message}`)
      resolve(1)
    })
    child.on('exit', (code, signal) => {
      for (const s of signals) process.off(s, forward)
      removeServePid(dataDir, process.pid)
      if (!ready && code !== 0) {
        const pid = lockHolderPid(dataDir)
        if (pid && pid !== child.pid && isAlive(pid)) {
          say(
            `the host did not start. ${dataDir} belongs to another Centralu host (pid ${pid}), ` +
              'probably the Centralu app on this machine. Quit it, or point CC_DATA_DIR at another folder.',
          )
        }
      }
      if (logFd !== null) say(`the host exited (${signal ?? code})`)
      resolve(code ?? (signal ? 1 : 0))
    })
  })
}

/** `centralu serve --rotate-token` */
export function rotateToken({ env, home }) {
  const dataDir = serveDataDir(env, home)
  rotateServeToken(dataDir)
  say(`replaced the token in ${join(dataDir, SERVE_STATE_FILE)}.`)
  say('A serve that is running keeps the old one until it restarts; clients read the new one with --connection.')
  return 0
}

// ── --detach ────────────────────────────────────────────────────────────────────────────────

/**
 * What a detached launcher needs from the `--detach` that started it. A process created through WMI
 * does not inherit this environment: it gets the account's default one. Everything else it needs
 * (the token, the port) is in the data folder. Never a secret.
 */
export const CARRIED_ENV = ['CC_DATA_DIR', 'CENTRALU_HOST_ENTRY', 'CENTRALU_MANAGED']

export function encodeChildSpec({ env, log }) {
  const carried = {}
  for (const k of CARRIED_ENV) if (typeof env[k] === 'string' && env[k]) carried[k] = env[k]
  return Buffer.from(JSON.stringify({ log, env: carried }), 'utf8').toString('base64url')
}

/** `{ log, env }` from `--detached-child=`, only the carried variables; null when it is not one */
export function decodeChildSpec(raw) {
  try {
    const v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'))
    if (typeof v?.log !== 'string' || !v.log) return null
    const env = {}
    for (const k of CARRIED_ENV) if (typeof v.env?.[k] === 'string') env[k] = v.env[k]
    return { log: v.log, env }
  } catch {
    return null
  }
}

/**
 * How `--detach` starts the launcher so that it outlives the session that asked (measured,
 * docs/plans/remote-hub.md §10.4):
 *
 *   setsid  posix: a new session, no terminal, nothing from the ssh session's process group. Once
 *           `--detach` returns, the launcher is reparented to init (the second fork of the usual
 *           double fork); it opens no terminal, so it can never get a controlling one back
 *   wmi     Windows: `Win32_Process.Create`. Windows' OpenSSH ends every process of a session with
 *           it, `Start-Process` included; a process WMI creates is not part of the session
 *   wsl     inside WSL: the same WMI call from the Windows side, creating `wsl.exe -d <distro>
 *           --exec <launcher>`. A `setsid` launcher inside the distro survives the session but not the
 *           distro, which WSL stops about 15 s after its last `wsl.exe` client exits; this
 *           `wsl.exe` is a client for as long as the host runs, and ending it ends the host
 */
export function detachHow(platform, env, interop = wslInterop) {
  if (platform === 'win32') return 'wmi'
  if (platform === 'linux' && env.WSL_DISTRO_NAME && interop()) return 'wsl'
  return 'setsid'
}

function wslInterop() {
  return existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop-late')
}

/**
 * One argument for a Windows command line, as `CommandLineToArgvW` and the C runtime read it: always
 * quoted, backslashes before the closing quote doubled. A double quote or a line break cannot be a
 * path on Windows and is refused rather than escaped.
 */
export function windowsArg(arg) {
  const s = String(arg)
  if (/["\r\n\0]/.test(s)) throw new Error(`cannot pass ${JSON.stringify(s)} on a Windows command line`)
  return `"${s.replace(/(\\+)$/, '$1$1')}"`
}

/** The PowerShell that asks WMI to create `commandLine`. Values cross as base64, so no quoting can break */
export function wmiScript({ commandLine, cwd = null }) {
  const text = (s) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(s, 'utf8').toString('base64')}'))`
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$a = @{ CommandLine = ${text(commandLine)} }`,
    ...(cwd ? [`$a.CurrentDirectory = ${text(cwd)}`] : []),
    // No console window when this runs from a desktop session; left out where it cannot be built
    'try { $a.ProcessStartupInformation = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 } } catch { }',
    'try {',
    '  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $a',
    "  if ($r.ReturnValue -eq 21 -and $a.ContainsKey('ProcessStartupInformation')) { $a.Remove('ProcessStartupInformation'); $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $a }",
    '  "CENTRALU-WMI $($r.ReturnValue) $($r.ProcessId)"',
    '} catch { "CENTRALU-WMI-ERROR $($_.Exception.Message)" }',
  ].join('\n')
}

/** `Win32_Process.Create`'s return values (Microsoft's documentation of the method) */
const WMI_CODES = { 2: 'access denied', 3: 'insufficient privilege', 8: 'unknown failure', 9: 'path not found', 21: 'invalid parameter' }

/** What the WMI script said: `{ ok: true, pid }` or `{ ok: false, message }` */
export function parseWmiAnswer(stdout) {
  const text = String(stdout ?? '')
  const m = /CENTRALU-WMI (\d+) (\d*)/.exec(text)
  if (m) {
    const rv = Number(m[1])
    if (rv === 0 && Number(m[2]) > 0) return { ok: true, pid: Number(m[2]) }
    return { ok: false, message: `WMI's Win32_Process.Create returned ${rv}${WMI_CODES[rv] ? ` (${WMI_CODES[rv]})` : ''}` }
  }
  const e = /CENTRALU-WMI-ERROR (.*)/.exec(text)
  if (e) return { ok: false, message: `WMI refused to create the process: ${e[1].trim()}` }
  return { ok: false, message: 'PowerShell did not answer the WMI request' }
}

/**
 * The sentence for a start WMI did not make. Some managed machines block process creation through
 * WMI (Microsoft Defender's attack surface reduction rule "Block process creations originating from
 * PSExec and WMI commands", off by default); the hub then runs the host bound to its link
 * (docs/plans/remote-hub.md §10.9, decision 3).
 */
export function wmiBlockedMessage(detail) {
  return (
    `Windows did not start Centralu through WMI (${detail}). Some managed Windows machines block it ` +
    '(Microsoft Defender\'s attack surface reduction rule "Block process creations originating from PSExec and WMI commands"). ' +
    'Centralu can run there while this computer is linked instead, and stops when the link does.'
  )
}

/** Windows PowerShell 5.1, by full path: under %SystemRoot% on Windows, through the drive WSL mounts inside a distro */
export function windowsPowershell(how, env, mounts) {
  return windowsTool(how, env, ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'], mounts)
}

/** A program under the Windows folder, by full path, from Windows or from inside a WSL distro; null when unreachable */
function windowsTool(how, env, rel, mounts = () => readFileSync('/proc/mounts', 'utf8')) {
  if (how === 'wmi') return [env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', ...rel].join('\\')
  let text = ''
  try {
    text = mounts()
  } catch {
    // no /proc: not WSL after all
  }
  for (const line of text.split('\n')) {
    const [, at, type] = line.split(' ')
    if (!at || !(type === '9p' || type === 'drvfs')) continue
    const candidate = [at, 'Windows', ...rel].join('/')
    if (existsSync(candidate)) return candidate
  }
  return null
}

function runCaptured(command, args, env) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      return resolve({ code: null, stdout, stderr: e.message })
    }
    child.stdout.on('data', (b) => (stdout += String(b)))
    child.stderr.on('data', (b) => (stderr += String(b)))
    child.once('error', (e) => resolve({ code: null, stdout, stderr: e.message }))
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * Starts the launcher outside this session (`detachHow`). `{ ok: true, pid, exited?, alive? }` once
 * something was created, `{ ok: false, blocked, message }` when nothing was: `blocked` is the WMI
 * refusal the hub falls back from.
 */
export async function startDetached({ how, execPath, args, env, cwd }) {
  if (how === 'setsid') {
    return await new Promise((resolve) => {
      let child
      try {
        child = spawn(execPath, args, { detached: true, stdio: 'ignore', cwd, env, windowsHide: true })
      } catch (e) {
        return resolve({ ok: false, blocked: false, message: `could not start ${execPath}: ${e.message}` })
      }
      child.once('error', (e) => resolve({ ok: false, blocked: false, message: `could not start ${execPath}: ${e.message}` }))
      child.once('spawn', () => {
        const exited = new Promise((r) => child.once('exit', (code, signal) => r(signal ?? code)))
        child.unref()
        resolve({ ok: true, pid: child.pid, exited })
      })
    })
  }
  const ps = windowsPowershell(how, env)
  if (!ps) return { ok: false, blocked: true, message: wmiBlockedMessage('Windows PowerShell is not reachable from this WSL distro') }
  let commandLine
  try {
    if (how === 'wmi') commandLine = [execPath, ...args].map(windowsArg).join(' ')
    else {
      const distro = env.WSL_DISTRO_NAME ?? ''
      const user = userInfo().username
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(distro)) throw new Error(`not a WSL distro name: ${distro}`)
      if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(user)) throw new Error(`cannot name the user ${user} to wsl.exe`)
      commandLine = ['wsl.exe', '-d', distro, '-u', user, '--cd', cwd, '--exec', execPath, ...args].map(windowsArg).join(' ')
    }
  } catch (e) {
    return { ok: false, blocked: false, message: e.message }
  }
  const script = wmiScript({ commandLine, cwd: how === 'wmi' ? cwd : null })
  const r = await runCaptured(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env)
  const answer = parseWmiAnswer(r.stdout)
  if (!answer.ok) return { ok: false, blocked: true, message: wmiBlockedMessage(r.stdout.trim() || !r.stderr.trim() ? answer.message : r.stderr.trim().split(/\r?\n/).at(-1)) }
  // A Windows pid can be watched from Windows; from inside WSL it names nothing here
  /*
   * Measured on a Windows 11 laptop (2026-10-08): a `wsl.exe` that WMI creates can hang without
   * running anything in the distro (it starts a second wsl.exe and waits), while `wsl.exe --list`
   * from the same context answers. `--detach` reports that as a start that never ran, and ends what
   * it created rather than leave it waiting: this pid and its children, nothing else.
   */
  const taskkill = windowsTool(how, env, ['System32', 'taskkill.exe'])
  const stop = taskkill ? () => runCaptured(taskkill, ['/PID', String(answer.pid), '/T', '/F'], env) : null
  return { ok: true, pid: answer.pid, alive: how === 'wmi' ? () => isAlive(answer.pid) : null, stop }
}

/** The last lines of a file, for a reason; empty when it cannot be read */
function tail(file, n = 15) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-n).join('\n')
  } catch {
    return ''
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * `centralu serve --detach` (docs/plans/remote-hub.md §10.4, S9): starts `serve` outside this
 * session (`detachHow`) and returns once its host answers a hello, so the caller, typically the
 * hub over ssh, can connect at once.
 *
 * stdout carries one JSON line, read by the hub (`links/tunnel.ts`): the connection line with
 * `hostRunning: true` and `detach: { ok: true, how, already }`, or `{ v: 1, detach: { ok: false,
 * how, reason, message } }`. `reason` is `wmi_blocked` when WMI created nothing or created something
 * that never ran, which the hub answers with a link-bound start; `exited` and `timeout` quote the
 * end of serve.log. Exit codes do not survive Windows' ssh (agent-host.md §4.8), so the line is
 * what counts; the exit code is 0 or 1 for a person at a prompt.
 *
 * `start` and the two waits are parameters so tests can stand in for WMI.
 */
export async function runDetach({
  env,
  home,
  entry,
  version,
  cliPath,
  port = null,
  platform = process.platform,
  execPath = process.execPath,
  cwd = process.cwd(),
  start = startDetached,
  how = detachHow(platform, env),
  timeoutMs = 30_000,
  noStartMs = 10_000,
  write = (line) => process.stdout.write(line),
}) {
  const dataDir = serveDataDir(env, home)
  // Created here, so the token exists before the launcher reads it and `answered` reads it again
  ensureServeState(dataDir, platform)
  keepLauncher(dataDir, cliPath, env)
  const fail = (reason, message) => {
    say(message)
    write(`${JSON.stringify({ v: 1, detach: { ok: false, how, reason, message } })}\n`)
    return 1
  }
  const answered = async (already) => {
    const d = await describe({ env, dataDir, state: ensureServeState(dataDir, platform), entry, version })
    if (!d?.hostRunning) return false
    write(`${connectionLine({ ...d, detach: { ok: true, how, already } })}\n`)
    return true
  }
  if (await answered(true)) return 0

  const log = join(dataDir, SERVE_LOG_FILE)
  // One start per log: the last one's is kept beside it, and its absence is how a start that never ran shows
  try {
    renameSync(log, `${log}.1`)
  } catch {
    // there was none
  }
  const args = [cliPath, 'serve', ...(port !== null ? ['--port', String(port)] : []), `${CHILD_FLAG}${encodeChildSpec({ env, log })}`]
  let started
  try {
    started = await start({ how, execPath, args, env, cwd })
  } catch (e) {
    return fail('failed', `could not start centralu serve in the background: ${e.message}`)
  }
  if (!started.ok) return fail(started.blocked ? 'wmi_blocked' : 'failed', started.message)
  say(`started centralu serve in the background (${how}, pid ${started.pid ?? 'unknown'}); waiting for its host`)

  let exited
  started.exited?.then((c) => (exited = c ?? 'unknown'))
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await answered(false)) return 0
    const why = tail(log)
    if (exited !== undefined) return fail('exited', `centralu serve exited (${exited}) before its host answered${why ? `:\n${why}` : ''}`)
    const gone = started.alive?.() === false
    if (how !== 'setsid' && !existsSync(log) && (gone || Date.now() - t0 > noStartMs)) {
      // WMI said yes, and nothing ran: the process was stopped before Node started, or hangs (`startDetached`)
      if (!gone) await started.stop?.()
      return fail('wmi_blocked', wmiBlockedMessage(gone ? `process ${started.pid} ended before it started` : `nothing started within ${Math.round(noStartMs / 1000)} s`))
    }
    if (gone) return fail('exited', `centralu serve exited before its host answered${why ? `:\n${why}` : ''}`)
    await sleep(250)
  }
  const why = tail(log)
  return fail('timeout', `the host did not answer within ${Math.round(timeoutMs / 1000)} s${why ? `:\n${why}` : ''}`)
}

/**
 * The launcher `--detach` started: `runServe` writing to serve.log. The carried variables are
 * already in `env` (centralu.mjs merges them before it looks for the host).
 */
export async function runDetachedChild({ spec, ...opts }) {
  let fd = null
  try {
    fd = openSync(spec.log, 'a')
    sink = (text) => {
      try {
        writeSync(fd, text)
      } catch {
        // nowhere left to say it
      }
    }
  } catch {
    // no log: say() keeps stderr, which nobody reads; --detach then reports the start as never run
  }
  say(`started in the background (pid ${process.pid}, Node ${process.version})`)
  try {
    return await runServe({ ...opts, logFd: fd })
  } catch (e) {
    say(e?.message ?? String(e))
    return 1
  }
}

// ── --stop ──────────────────────────────────────────────────────────────────────────────────

/**
 * Asks a running host to stop (`host.stop`, an additive RPC): a hello with the token, then the call.
 * `{ ok: true }` once the host took it, `{ ok: false, message, protocolVersion? }` otherwise; the
 * last names the host's protocol when the hello was refused for it, so the caller can ask again.
 */
export function askHostToStop({ port, token, protocolVersion, timeoutMs = 5000, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== 'function') return Promise.resolve({ ok: false, message: `Node ${process.version} has no WebSocket to ask with` })
  return new Promise((resolve) => {
    let ws = null
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws?.close()
      } catch {
        // already closed
      }
      resolve(result)
    }
    const timer = setTimeout(() => done({ ok: false, message: 'no answer in time' }), timeoutMs)
    try {
      ws = new WebSocketImpl(`ws://127.0.0.1:${port}`)
    } catch (e) {
      done({ ok: false, message: e.message })
      return
    }
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: protocolVersion ?? 0 }))
    ws.onmessage = (ev) => {
      let m
      try {
        m = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (m?.kind === 'hello_ok') ws.send(JSON.stringify({ kind: 'rpc', id: 'stop', method: 'host.stop', params: {} }))
      else if (m?.kind === 'res' && m.id === 'stop') done(m.ok ? { ok: true } : { ok: false, message: m.error?.message ?? 'refused' })
      else if (m?.kind === 'res' && m.ok === false) {
        const pv = m.error?.code === 'version_mismatch' ? (m.error?.data?.protocolVersion ?? mismatchServerVersion(m.error.message)) : null
        done({ ok: false, message: m.error?.message ?? 'refused', ...(Number.isInteger(pv) ? { protocolVersion: pv } : {}) })
      }
    }
    ws.onerror = () => done({ ok: false, message: 'could not connect' })
    ws.onclose = () => done({ ok: false, message: 'the connection closed' })
  })
}

async function waitUntil(pred, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await pred()) return true
    await sleep(200)
  }
  return pred()
}

/**
 * `centralu serve --stop` (docs/plans/remote-hub.md §10.4, S10): asks the running host to stop over
 * its own socket and waits until it has, so its shutdown runs (its agents, terminals and app
 * processes stopped in order, the store closed). Measured on Windows: killing the WMI-started
 * launcher ended the host 143 ms later with no "shutting down" line, because the host sits in
 * libuv's kill-on-close job object; so on Windows killing is the last resort, not the way.
 *
 * Then, only for a host that did not go: posix SIGTERM to the launcher (which passes it to the host,
 * the same clean stop), and on Windows ending the host. A host from before `host.stop` gets that
 * too. The launcher ends with its host; one still there afterwards is ended.
 *
 * Only the processes serve.pid and host.lock name, and only while they agree with each other and
 * the host answered with this folder's token: a stale pid is never signalled.
 *
 * stdout: one line, `{ v: 1, stop: { ok, wasRunning, how?, message? } }`.
 */
export async function runStop({
  env,
  home,
  entry,
  platform = process.platform,
  timeoutMs = 30_000,
  graceMs = 15_000,
  kill = (pid, sig) => process.kill(pid, sig),
  write = (line) => process.stdout.write(line),
}) {
  const dataDir = serveDataDir(env, home)
  const report = (stop) => {
    if (stop.message) say(stop.message)
    write(`${JSON.stringify({ v: 1, stop })}\n`)
    return stop.ok ? 0 : 1
  }
  const state = readServeState(dataDir)
  if (!state) return report({ ok: true, wasRunning: false, message: `no centralu serve has run for ${dataDir}` })
  const port = state.port ?? DEFAULT_SERVE_PORT
  const installed = protocolVersionOf(entry) ?? 0
  const probe = () => probeHost({ port, token: state.token, protocolVersion: installed })
  const first = await probe()
  if (!first.running) return report({ ok: true, wasRunning: false, message: `centralu serve is not running for ${dataDir}` })

  const hostPid = lockHolderPid(dataDir)
  const launcher = readServePid(dataDir)
  // serve.pid is only believed when it names the host that holds the folder now
  const launcherPid = launcher && hostPid && launcher.hostPid === hostPid ? launcher.pid : null
  const down = async () => !(await probe()).running && !(hostPid && isAlive(hostPid))

  let asked = await askHostToStop({ port, token: state.token, protocolVersion: first.protocolVersion ?? installed })
  if (!asked.ok && asked.protocolVersion !== undefined) asked = await askHostToStop({ port, token: state.token, protocolVersion: asked.protocolVersion })
  let how = 'asked'
  let stopped = asked.ok && (await waitUntil(down, timeoutMs))
  let note = asked.ok ? null : `the host did not take the request to stop (${asked.message})`
  if (!stopped) {
    const target = platform !== 'win32' && launcherPid ? launcherPid : hostPid
    if (target) {
      how = platform === 'win32' ? 'ended' : 'signal'
      try {
        kill(target, 'SIGTERM')
      } catch {
        // gone in the meantime
      }
      stopped = await waitUntil(down, platform === 'win32' ? 5_000 : graceMs)
      if (!stopped && hostPid && isAlive(hostPid)) {
        how = 'ended'
        try {
          kill(hostPid, 'SIGKILL')
        } catch {
          // gone in the meantime
        }
        stopped = await waitUntil(down, 5_000)
      }
    }
    if (how === 'ended') note = `${note ? `${note}; ` : ''}ended the host without its shutdown`
  }
  if (launcherPid && launcherPid !== process.pid && !(await waitUntil(() => !isAlive(launcherPid), 5_000))) {
    try {
      kill(launcherPid, 'SIGKILL')
    } catch {
      // gone in the meantime
    }
  }
  if (!stopped) return report({ ok: false, wasRunning: true, how, message: `the host on 127.0.0.1:${port} is still running${note ? ` (${note})` : ''}` })
  return report({ ok: true, wasRunning: true, how, ...(note ? { message: note } : {}) })
}
