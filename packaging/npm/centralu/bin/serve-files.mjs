/**
 * The files `centralu serve` keeps in the data folder: the token and port (serve.json, private to the
 * user), the running launcher's pid (serve.pid), and the host's own lock (host.lock), read to tell a
 * live host of this folder from a stale pid.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { isAlive, replaceFile } from './serve-util.mjs'

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
  replacePrivate(file, { v: 1, token: state.token, port }, platform)
}

/**
 * A new token, keeping the port. Only when the person asks (`--rotate-token`): every client that
 * stored the old one has to fetch the new one with `--connection`, and a serve already running
 * keeps answering to the old one until it restarts.
 */
export function rotateServeToken(dataDir, platform = process.platform) {
  const before = ensureServeState(dataDir, platform)
  replacePrivate(join(dataDir, SERVE_STATE_FILE), { v: 1, token: randomBytes(32).toString('base64url'), port: before.port }, platform)
  return readServeState(dataDir)
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

/** Replaces a private file whole (`replaceFile`), created 0600 as `writePrivate` creates one */
function replacePrivate(file, value, platform) {
  replaceFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
  keepPrivate(file, platform)
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

/** serve.pid: `{ pid, hostPid, port }` of the launcher that runs, or null */
export function readServePid(dataDir) {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, SERVE_PID_FILE), 'utf8'))
    return Number.isInteger(v?.pid) && v.pid > 0 ? { pid: v.pid, hostPid: Number.isInteger(v.hostPid) ? v.hostPid : null, port: v.port ?? null } : null
  } catch {
    return null
  }
}

export function removeServePid(dataDir, pid) {
  if (readServePid(dataDir)?.pid !== pid) return
  try {
    rmSync(join(dataDir, SERVE_PID_FILE), { force: true })
  } catch {
    // another serve's by now, or gone
  }
}

/**
 * A probe that did not prove the token, while this data folder's host is alive (`host.lock`): a host from before #838
 * still running after an update. It is running, and is not sent the token; a hub asking it for a proof is refused
 * until it restarts. Without a live lock holder, what answered is not ours.
 */
export function heldHere(probe, dataDir, startOf = processStartTime) {
  if (probe.running) return true
  if (!probe.unproven) return false
  return lockHolderIsAlive(dataDir, startOf)
}

/**
 * Whether the process `host.lock` names is the one that wrote it (#838 review): alive, and started when the lock says
 * (`ps -o lstart`, as the host writes it, `instance-lock.ts`). A lock left by a host that died, whose pid another
 * process of the same user now has, names a stranger: counted as running, `--stop` would signal it. A lock without a
 * start time (a host from before #184) or a system without `ps` (Windows) cannot be told apart, so it does not count.
 */
export function lockHolderIsAlive(dataDir, startOf = processStartTime) {
  let holder
  try {
    holder = parseLockHolder(readFileSync(join(dataDir, 'host.lock'), 'utf8'))
  } catch {
    return false
  }
  if (!holder || !holder.started || !isAlive(holder.pid)) return false
  return startOf(holder.pid) === holder.started
}

/** host.lock's `{ pid, started }`; a bare pid (an older host) has no start time */
function parseLockHolder(text) {
  const t = text.trim()
  if (/^\d+$/.test(t)) return Number(t) > 0 ? { pid: Number(t), started: null } : null
  try {
    const v = JSON.parse(t)
    return Number.isInteger(v?.pid) && v.pid > 0 ? { pid: v.pid, started: typeof v.started === 'string' ? v.started : null } : null
  } catch {
    return null
  }
}

/**
 * A pid's start time, as `instance-lock.ts`'s `processStartTime` reads it: `ps -o lstart=` with the C locale, so the
 * host that wrote the lock and this launcher read the same text. null without `ps` (Windows) or when it fails.
 */
export function processStartTime(pid) {
  if (process.platform === 'win32') return null
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/** Who `host.lock` names as the data folder's owner, or null */
export function lockHolderPid(dataDir) {
  try {
    return parseLockHolder(readFileSync(join(dataDir, 'host.lock'), 'utf8'))?.pid ?? null
  } catch {
    return null
  }
}
