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
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync, closeSync } from 'node:fs'
import { connect } from 'node:net'
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

export const SERVE_HELP = `centralu serve: run the Centralu host on this machine, without a window

  centralu serve                  Start the host in the foreground, on 127.0.0.1 only
  centralu serve --port <n>       ... on that port (kept for the next start; default ${DEFAULT_SERVE_PORT})
  centralu serve --connection     Print how to reach it as one JSON line, then exit
  centralu serve --rotate-token   Replace the token (a running serve keeps the old one until restarted)

The data folder is ~/.centralu (CC_DATA_DIR overrides it). The app on another computer reaches
this host through an SSH local forward. Stop it with Ctrl+C or SIGTERM.

Both serve and --connection keep ~/.centralu/bin/centralu up to date: a launcher with absolute
paths, for SSH sessions whose PATH has neither npm's global folder nor node.`

/**
 * What the arguments after `serve` ask for: `{ mode, port }` or `{ error }`.
 *
 * `mode` is `serve`, `connection`, `rotate` or `help`; `port` is null when not given. `--port` does not go
 * with `--connection`: the answer has to be the port `serve` uses, not one the caller names.
 */
export function parseServeArgs(argv) {
  let mode = 'serve'
  let port = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--connection' || a === '--rotate-token') {
      const m = a === '--connection' ? 'connection' : 'rotate'
      if (mode !== 'serve' && mode !== 'help' && mode !== m) return { error: '--connection and --rotate-token are separate commands; pass one' }
      if (mode !== 'help') mode = m
    }
    else if (a === '--help' || a === '-h') mode = 'help'
    else if (a === '--port' || a.startsWith('--port=')) {
      const raw = a === '--port' ? argv[++i] : a.slice('--port='.length)
      const n = parsePort(raw)
      if (n === null) return { error: `--port needs a port number between 1 and 65535 (got ${raw === undefined ? 'nothing' : JSON.stringify(raw)})` }
      port = n
    } else return { error: `unknown option for serve: ${a}\n\n${SERVE_HELP}` }
  }
  if ((mode === 'connection' || mode === 'rotate') && port !== null) {
    return { error: '--port goes with `centralu serve`; `--connection` reports the port serve listens on' }
  }
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

/** ensureLauncher, with a failure said on stderr instead of thrown: the launcher is a convenience */
function keepLauncher(dataDir, cliPath) {
  if (!cliPath) return
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

/** The `--connection` answer. The shape is the client's interface (docs/agent-host.md §4.7) */
export function connectionLine({ port, token, version, protocolVersion, dataDir, hostRunning }) {
  return JSON.stringify({ v: 1, port, token, version, protocolVersion, dataDir, hostRunning })
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
 * - The keeper's and dev mode's variables are dropped: this host is neither.
 */
export function hostEnv(env, { token, dataDir, version, hostDir }) {
  const out = { ...env }
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'CC_KEEPER', 'CC_FRONT_DOOR', 'CC_DEV', 'CC_HOST_TOKEN', 'CC_HOST_SOURCE']) delete out[k]
  out.CC_DATA_DIR = dataDir
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

/** Writes a line to stderr, prefixed so it reads apart from the host's own log lines */
function say(line) {
  process.stderr.write(`[centralu serve] ${line}\n`)
}

/**
 * `centralu serve --connection`. stdout carries exactly one line, the JSON; everything else goes to
 * stderr. Exit 1 when there is no host to describe.
 */
export async function printConnection({ env, home, entry, version, cliPath }) {
  const dataDir = serveDataDir(env, home)
  const state = ensureServeState(dataDir)
  keepLauncher(dataDir, cliPath)
  const port = state.port ?? DEFAULT_SERVE_PORT
  const installed = protocolVersionOf(entry)
  const probe = await probeHost({ port, token: state.token, protocolVersion: installed })
  const protocolVersion = (probe.running ? probe.protocolVersion : undefined) ?? installed
  if (protocolVersion === null) {
    say(`cannot read the protocol version of the host at ${entry}`)
    return 1
  }
  process.stdout.write(
    `${connectionLine({
      port,
      token: state.token,
      version: (probe.running ? probe.version : undefined) ?? version,
      protocolVersion,
      dataDir,
      hostRunning: probe.running,
    })}\n`,
  )
  return 0
}

/**
 * `centralu serve`. Resolves with the exit code once the host has exited.
 *
 * The host's stdout is read here and never passed on: its ready line carries the token, which is
 * printed nowhere but `--connection`. Every other line the host writes to stdout (a lock conflict,
 * a store from a newer build) it also writes to stderr, which is passed through untouched.
 */
export async function runServe({ env, home, entry, version, cliPath, port: askedPort, platform = process.platform, execPath = process.execPath }) {
  const dataDir = serveDataDir(env, home)
  const state = ensureServeState(dataDir, platform)
  keepLauncher(dataDir, cliPath)
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
    stdio: ['pipe', 'pipe', 'inherit'],
    env: hostEnv(env, { token: state.token, dataDir, version, hostDir: dirname(entry) }),
    detached: plan.detached,
    windowsHide: true,
  })

  let ready = false
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
    say(`from your computer: ssh -N -L ${p}:127.0.0.1:${p} <this machine>, or let the app connect over SSH`)
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
      say(`could not start the host (${plan.command}): ${e.message}`)
      resolve(1)
    })
    child.on('exit', (code, signal) => {
      for (const s of signals) process.off(s, forward)
      if (!ready && code !== 0) {
        const pid = lockHolderPid(dataDir)
        if (pid && pid !== child.pid && isAlive(pid)) {
          say(
            `the host did not start. ${dataDir} belongs to another Centralu host (pid ${pid}), ` +
              'probably the Centralu app on this machine. Quit it, or point CC_DATA_DIR at another folder.',
          )
        }
      }
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
