/**
 * The files `centralu serve` keeps in the data folder: the host's key, the verifiers of the full credentials and the
 * port (serve.json, private to the user), the running launcher's pid (serve.pid), and the host's own lock (host.lock),
 * read to tell a live host of this folder from a stale pid.
 */
import { execFileSync } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { isAlive, renameRetrying, replaceFile, sleepSync } from './serve-util.mjs'
import { CREDENTIAL_ID_RE, PAIR_LABEL_RE } from './serve-args.mjs'

/**
 * The file in the data folder that holds the host's key, the full credentials' verifiers and the port, mode 0600.
 *
 * Since #1405 (version 2) it holds **no credential that opens the host whole**:
 *
 * - `key`: 32 random bytes the host derives what it hands out from (the limited credential `--connection` prints, a
 *   Codex bridge's, the proof of a launcher's probe). With it a process of this user gets the limited credential;
 *   it is never a full one (a hello with it is refused as full).
 * - `full`: one entry per full credential, `{ id, label, verifier, created }`, the verifier being the SHA-256 of the
 *   credential. The credential itself is printed once, to whoever asked for it (`--pair`: a hub at each link,
 *   `--window` for the person's own window, which the desktop app runs on Windows and which runs on every OS), and written nowhere. The host checks a hello against these,
 *   read again at each hello, so a pairing or a revocation applies at once.
 * - `legacyHostToken`: only while the installed host is from before verifiers (a rollback): the one token such a
 *   host knows, given to it and to the hub that pairs, as before #1405.
 *
 * The port is the one the last `serve` actually listened on, which is how `--connection`, a separate process, learns a
 * `--port` given to `serve` in a systemd unit. A version 1 file (`{ token, port }`) is moved to version 2 on first
 * use: its token becomes a full credential labelled `legacy` (a hub or window still holding it keeps working), which the
 * next pairing removes.
 */
export const SERVE_STATE_FILE = 'serve.json'

/** The label of the full credential a version 1 file's token became; removed by the next pairing */
export const LEGACY_LABEL = 'legacy'

/** A full credential's verifier: the SHA-256 of it, as hex (the host's `serve-credentials.ts` compares the same) */
export function verifierOf(credential) {
  return createHash('sha256').update(credential).digest('hex')
}

/** The limited credential the host derives from `key` (#1405, the host's `transport/limited-token.ts`) */
export function limitedOf(key) {
  return `ccl1:${createHmac('sha256', key).update('centralu limited token v1').digest('base64url')}`
}

/** What a detached serve writes: its own lines, and the host's until it is ready (host.log has the rest) */
export const SERVE_LOG_FILE = 'serve.log'

/** The running launcher's pid and port, so `--stop` can find it. Removed when it exits */
export const SERVE_PID_FILE = 'serve.pid'

/** How many earlier starts' serve.log are kept, as serve.log.1 (the last) to serve.log.3 */
export const SERVE_LOGS_KEPT = 3

/**
 * Makes room for a new start's serve.log (#1143): the earlier ones move down a place, and the oldest past
 * `SERVE_LOGS_KEPT` goes. A hub that starts a host again after it stopped makes at most three starts in ten minutes,
 * so the log of the start that failed first is still here when it stops trying. The last one is moved aside with
 * `renameRetrying` (a reader may hold the file on Windows, #1223); one that cannot be moved is removed rather than
 * left to read as the new start's. Never fatal
 */
export function rotateServeLog(log, kept = SERVE_LOGS_KEPT, rename = renameRetrying) {
  // No log to move aside, no room to make: a second call for the same start (the task's line removed before a WMI start)
  if (!existsSync(log)) return
  for (let i = kept - 1; i >= 1; i--) {
    try {
      renameSync(`${log}.${i}`, `${log}.${i + 1}`)
    } catch {
      // there was none, or a reader holds it: the older log stays where it is
    }
  }
  try {
    rename(log, `${log}.1`)
  } catch (e) {
    if (e?.code === 'ENOENT') return
    try {
      rmSync(log, { force: true, maxRetries: 5 })
    } catch {
      // nothing more to do
    }
  }
}

/**
 * The person's stop, kept in the data folder (#1143): `centralu serve --stop` writes it (`by: 'stop'`), and so does a
 * host that Centralu's own app stops for good when the person quits it there (`by: 'quit'`, the host's
 * lifecycle/stopped-mark.ts, which names the same file). Every host that starts in the folder removes it.
 * `--connection` reports it while no host runs, and a hub then starts none by itself. A hub's own stop (an update)
 * leaves none: it says so with `CENTRALU_STOP_BY=hub`
 */
export const SERVE_STOPPED_FILE = 'stopped.json'

/** Writes the mark; never fatal, a stop that could not note itself still stopped */
export function markStopped(dataDir, by, now = Date.now()) {
  try {
    replaceFile(join(dataDir, SERVE_STOPPED_FILE), `${JSON.stringify({ v: 1, by, at: now })}\n`)
  } catch {
    // the folder is read-only or gone: nothing to remember it in
  }
}

/** The mark as `{ by, at }`, or null when there is none. One that does not parse is still a stop, by `stop`, at no time */
export function readStopped(dataDir) {
  let text
  try {
    text = readFileSync(join(dataDir, SERVE_STOPPED_FILE), 'utf8')
  } catch {
    return null
  }
  let o = null
  try {
    o = JSON.parse(text)
  } catch {
    // half written, or written by hand
  }
  return { by: o?.by === 'quit' ? 'quit' : 'stop', at: typeof o?.at === 'number' && Number.isFinite(o.at) ? o.at : null }
}

/** The data folder: the host's own rule (`dataRoot()` in agent-host), CC_DATA_DIR or ~/.centralu */
export function serveDataDir(env, home) {
  return env.CC_DATA_DIR || join(home, '.centralu')
}

/**
 * The state, or null when there is none yet or it cannot be read as one. A file that is refused (Windows, while a
 * writer or a scanner has it) or does not parse is read again a few times before it counts as unreadable: a
 * `--detach` waiting for the port reads it while the launcher replaces it (#1041).
 */
export function readServeState(dataDir, { tries = 5, sleep = sleepSync } = {}) {
  const file = join(dataDir, SERVE_STATE_FILE)
  for (let i = 1; ; i++) {
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (e) {
      if (e?.code === 'ENOENT' || i >= tries) return null
      sleep(10 * i)
      continue
    }
    const state = parseServeState(raw)
    if (state || i >= tries) return state
    sleep(10 * i)
  }
}

/**
 * The state as the launcher uses it. `token` is the credential the launcher's own probes say hello with, and
 * `proofKey` what the host proves with to them: the limited credential and the key for version 2, the token for a
 * version 1 file not moved yet.
 */
function parseServeState(raw) {
  try {
    const v = JSON.parse(raw)
    const port = Number.isInteger(v?.port) && v.port >= 1 && v.port <= 65535 ? v.port : null
    if (v?.v === 2) {
      if (typeof v.key !== 'string' || v.key.length < 32) return null
      // Exactly what the host takes (serve-credentials.ts `isListedEntry`): an entry of another shape is dropped here, so
      // the next write leaves it out too, and the host refuses it meanwhile
      const full = (Array.isArray(v.full) ? v.full : []).filter((e) => isListedEntry(e)).map((e) => ({ id: e.id, label: e.label, verifier: e.verifier, created: Number.isFinite(e.created) ? e.created : 0, ...(PAIRED_VIA.includes(e.via) ? { via: e.via } : {}), ...(e.replaced === true ? { replaced: true } : {}) }))
      const legacyHostToken = typeof v.legacyHostToken === 'string' && v.legacyHostToken.length >= 32 ? v.legacyHostToken : null
      return { v: 2, key: v.key, port, full, legacyHostToken, token: limitedOf(v.key), proofKey: v.key }
    }
    if (typeof v?.token !== 'string' || v.token.length < 32) return null
    return { v: 1, token: v.token, proofKey: v.token, port, key: null, full: [], legacyHostToken: null }
  } catch {
    return null
  }
}

/** An entry the launcher lists, `--revoke` takes and the host accepts: an 8-hex id, a label `--pair` takes, a hex verifier */
export function isListedEntry(e) {
  return typeof e?.id === 'string' && CREDENTIAL_ID_RE.test(e.id) && typeof e.label === 'string' && PAIR_LABEL_RE.test(e.label) && typeof e.verifier === 'string' && /^[0-9a-f]{64}$/.test(e.verifier)
}

/** What version 2 writes for a state */
function stateFile(state) {
  return { v: 2, key: state.key, port: state.port, full: state.full, ...(state.legacyHostToken ? { legacyHostToken: state.legacyHostToken } : {}) }
}

/** A new full credential and its id */
function mint() {
  return { token: randomBytes(32).toString('base64url'), id: randomBytes(4).toString('hex') }
}

/**
 * The state, created on first use. Never replaces a token that is already there.
 *
 * Created with `wx`, so two first runs at the same moment (a `serve` and a `--connection`) cannot
 * each write a different token: the second one fails to create and reads the first one's. A file
 * that exists but cannot be read as state is refused rather than overwritten: it may be a token
 * the client already holds, and a silent new one would lock that client out with "bad token".
 */
export function ensureServeState(dataDir, platform = process.platform, now = Date.now()) {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, SERVE_STATE_FILE)
  if (!existsSync(file)) {
    try {
      writePrivate(file, { v: 2, key: randomBytes(32).toString('base64url'), port: null, full: [] }, 'wx')
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
    }
  }
  let state = readServeState(dataDir)
  if (!state) throw noState(file)
  // A version 1 file (#1405): its token becomes a full credential no longer written down, and a new key is drawn
  if (state.v === 1) {
    state = changeServeState(dataDir, (s) =>
      s.v === 1
        ? { v: 2, key: randomBytes(32).toString('base64url'), port: s.port, full: [{ id: randomBytes(4).toString('hex'), label: LEGACY_LABEL, verifier: verifierOf(s.token), created: now }], legacyHostToken: null }
        : s,
      platform,
    )
  }
  keepPrivate(file, platform)
  return state
}

/**
 * Why serve.json gives no state (#1405 review): a file this user may not read is said as that, with what makes it
 * readable again. Moving it aside, the advice for a file that is not a state file, would lock out every hub and window
 * that holds a credential it names.
 */
export function noState(file, read = readFileSync) {
  try {
    read(file)
  } catch (e) {
    if (e?.code === 'EACCES' || e?.code === 'EPERM') {
      return new Error(`${file} cannot be read by this user (${e.code}). Give this user read and write access to it again (on Linux and macOS: chmod 600 ${file}) and run again; do not move it aside.`)
    }
    if (e?.code === 'ENOENT') return new Error(`${file} is missing`)
  }
  return new Error(`${file} exists but is not a serve state file. Move it aside and run again.`)
}

/** How long a held `serve.json.lock` is waited on before it counts as a crashed writer's (`changeServeState`) */
export const STATE_LOCK_STALE_MS = 10_000

/**
 * How long before `STATE_LOCK_STALE_MS` a writer stops trying to write (#1405 review): the time it leaves itself
 * for the rename, so that a rename it starts lands before any waiter may count its lock as stale
 */
export const STATE_LOCK_MARGIN_MS = 2_000

/**
 * Reads the state, changes it with `change` and writes it back, under a lock (`serve.json.lock`) so two changes at once
 * (a hub pairing while a window starts) do not lose one another. Returns the state written.
 *
 * - A lock whose time is more than `STATE_LOCK_STALE_MS` from now, either way, is a crashed writer's and is taken over.
 *   Either way (#1405 review): a lock dated ahead of now (a crashed writer, then the clock set back) blocked every
 *   `--pair` and `--revoke` for as long as it was ahead, so a hub could not link.
 * - The lock holds a nonce of its writer's, and the writer reads it back before each try of the rename that replaces
 *   the file: a writer stalled past the 10 s, whose lock another took over meanwhile, writes nothing (#1405 review),
 *   rather than a state it computed before a `--revoke` that came in between. It throws, and whoever asked tries again
 *   (a hub at its next link attempt, a person by running it again).
 * - A writer also writes only within `STATE_LOCK_STALE_MS - STATE_LOCK_MARGIN_MS` of taking its lock, by this
 *   process's own clock, which a clock set back does not stretch (#1405 review): on Windows a rename is tried again
 *   for up to 5 s while a reader holds the file, and a try seconds after the read-back could land after another writer
 *   took the lock over and wrote. Its last try is then at least 2 s before any waiter may take the lock over.
 * - Taking over a stale lock, and removing its own at the end, first move the lock aside under a name of this
 *   writer's and look at what was moved: a fresh lock, or another writer's, is put back (`releaseLock`). Before, two
 *   waiters taking over one stale lock at once could remove the other's fresh lock, and a writer's end could remove the
 *   lock of one that took it over between its read-back and its removal.
 *
 * What is left: a writer suspended for over 2 s between its last read-back and the rename right after it; a
 * system clock set forward by more than 10 s while a writer holds the lock, which makes its lock look stale to a
 * waiter; and the moment a lock is moved aside to be looked at, during which a third writer may create one and read
 * the state while the lock's owner, past its read-back, renames (on a file system without hard links the moved lock is
 * not put back at all, and its owner's next read-back refuses). No lock file can close these.
 */
export function changeServeState(dataDir, change, platform = process.platform, { sleep = sleepSync, nowMs = Date.now, clock = () => performance.now(), read = readFileSync } = {}) {
  const file = join(dataDir, SERVE_STATE_FILE)
  const lock = `${file}.lock`
  const mine = randomBytes(8).toString('hex')
  for (let i = 0; ; i++) {
    try {
      const fd = openSync(lock, 'wx', 0o600)
      try {
        writeSync(fd, mine)
      } finally {
        closeSync(fd)
      }
      break
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
      try {
        if (Math.abs(nowMs() - statSync(lock).mtimeMs) > STATE_LOCK_STALE_MS) takeOverStale(lock, mine, nowMs)
      } catch {
        // gone meanwhile: try again
      }
      // Past the 10 s after which a lock counts as a crashed writer's, so a waiter takes it over rather than giving up first
      if (i >= 480) throw new Error(`${lock} is held by another serve; try again`)
      sleep(25)
    }
  }
  const took = clock()
  const held = () => {
    try {
      return read(lock, 'utf8') === mine
    } catch {
      return false
    }
  }
  // Whether this writer may still write: within its time, and the lock still its own
  const mayWrite = () => {
    if (clock() - took >= STATE_LOCK_STALE_MS - STATE_LOCK_MARGIN_MS) return new Error(`${lock} was held too long by this serve to write safely; nothing was written, try again`)
    if (!held()) return new Error(`${lock} was taken over while this serve held it; nothing was written, try again`)
    return null
  }
  try {
    const before = readServeState(dataDir)
    if (!before) throw noState(file)
    const after = change(before)
    if (after !== before) {
      const refusal = mayWrite()
      if (refusal) throw refusal
      replacePrivate(file, stateFile(after), platform, { mayTry: mayWrite })
    }
    // What was written, as a reader reads it: never null once written
    return after !== before ? parseServeState(JSON.stringify(stateFile(after))) : before
  } finally {
    // Only its own: a lock another writer took over is that writer's to keep
    releaseLock(lock, mine, { read })
  }
}

/**
 * Removes `lock` if it is `mine` (#1405 review): moved aside under a name of this writer's first, so what is looked at
 * is what is removed, and put back when it was another writer's. Reading it and then removing it by name could remove
 * a lock another writer took over in between. Never throws: a lock left behind goes stale and is taken over.
 */
export function releaseLock(lock, mine, { read = readFileSync, rename = renameSync, link = linkSync, rm = rmSync } = {}) {
  const aside = `${lock}.${mine}.release`
  try {
    renameRetrying(lock, aside, { rename, budgetMs: 1_000 })
  } catch {
    // not there (taken over and removed), or held open past the retries: nothing of this writer's to remove now
    return
  }
  let found = null
  try {
    found = read(aside, 'utf8')
  } catch {
    // unreadable (a scanner on Windows): it may be another writer's, so it is put back; if it was this one's, it goes stale
  }
  if (found !== mine) putBack(aside, lock, link)
  try {
    rm(aside, { force: true })
  } catch {
    // a stray file beside the lock, nothing a writer reads
  }
}

/**
 * Takes over a lock that looked stale (`changeServeState`): moved aside first, and put back when what was moved is not
 * stale after all (another waiter's fresh lock, taken over a moment before). The caller then creates its own
 */
function takeOverStale(lock, mine, nowMs) {
  const aside = `${lock}.${mine}.stale`
  renameSync(lock, aside)
  let stale = true
  try {
    stale = Math.abs(nowMs() - statSync(aside).mtimeMs) > STATE_LOCK_STALE_MS
  } catch {
    // gone: nothing to put back
  }
  if (!stale) putBack(aside, lock, linkSync)
  rmSync(aside, { force: true })
}

/** Puts a moved lock back where it was, unless another writer created one there since (a hard link never replaces) */
function putBack(aside, lock, link) {
  try {
    link(aside, lock)
  } catch {
    // another holds the lock by now, or links are not possible here: that writer's read-back sees it is not its own
  }
}

/**
 * How a full credential was asked for, kept on its entry as `via` (#1405 review): `pair` (`--connection --pair`, a
 * hub's at each link or any program's), `window` (`--window`, the person's window on Windows at each start), `handover`
 * (the launcher's own, for one `host.handover` call and withdrawn right after)
 */
export const PAIRED_VIA = ['pair', 'window', 'handover']

/**
 * A new full credential for `label` (#1405): written as its verifier only, and returned once. One label holds one
 * credential: a hub pairing again (each link does) replaces its own, and `window` the window's. The `legacy` one a
 * version 1 file left goes with a hub's or the window's pairing: whoever held it was one of the two, which pairs now.
 * `via` is how it was asked for (`PAIRED_VIA`). Returns `{ token, id, state }`.
 *
 * `replaced` (#1405 review): set on the new entry only when the one of its label it takes the place of was asked for
 * another way, or the file does not say how. The window pairing again at each start, and a hub at each link, are the
 * same pairer as before and are not marked: marked at every routine pairing, the flag meant nothing. A `--pair window`
 * taking the window's place, or the window's next start taking that one's, is marked. What this cannot tell is two
 * askers of the same way: a program's `--pair hub:<name>-<key>` against that hub's own. The hub's row tells that one
 * by itself (`hubsName`, and its own credential gone), docs/security-boundaries.md.
 */
export function pairServe(dataDir, label, platform = process.platform, now = Date.now(), via = 'pair') {
  ensureServeState(dataDir, platform, now)
  const { token, id } = mint()
  const state = changeServeState(dataDir, (s) => ({
    ...s,
    /*
     * A hub's or the window's pairing removes the `legacy` one (#1405 review): whoever held it was a hub or the window
     * of before #1405, each of which pairs now, so on a machine no hub links to it does not outlive the window's next
     * start. Any other label leaves it: a program's own `--pair` does not cut off a hub that has not paired yet
     */
    full: [
      ...s.full.filter((e) => e.label !== label && !(takesLegacyPlace(label) && e.label === LEGACY_LABEL)),
      { id, label, verifier: verifierOf(token), created: now, via, ...(s.full.some((e) => e.label === label && e.via !== via) ? { replaced: true } : {}) },
    ],
  }), platform)
  return { token, id, state }
}

/** The pairings that stand for whoever held a version 1 file's token: a hub's and the window's (`pairServe`) */
function takesLegacyPlace(label) {
  return label === 'window' || label.startsWith('hub:')
}

/** Removes the full credential `id`; true when there was one. A hello with it is refused from then on */
export function revokeServe(dataDir, id, platform = process.platform) {
  let found = false
  changeServeState(dataDir, (s) => {
    found = s.full.some((e) => e.id === id)
    return found ? { ...s, full: s.full.filter((e) => e.id !== id) } : s
  }, platform)
  return found
}

/**
 * The one token an installed host from before verifiers knows (a rollback): kept in the state while such a host is
 * installed, given to it and to a hub that pairs. Created once; returns it.
 */
export function legacyHostTokenOf(dataDir, platform = process.platform) {
  const state = ensureServeState(dataDir, platform)
  if (state.legacyHostToken) return state.legacyHostToken
  const token = randomBytes(32).toString('base64url')
  return changeServeState(dataDir, (s) => (s.legacyHostToken ? s : { ...s, legacyHostToken: token }), platform).legacyHostToken
}

/** A host of today runs: the token kept for an older one is not kept any longer */
export function dropLegacyHostToken(dataDir, platform = process.platform) {
  changeServeState(dataDir, (s) => (s.legacyHostToken ? { ...s, legacyHostToken: null } : s), platform)
}

/** Writes the port `serve` listened on, keeping the rest. Atomic: a temp file renamed over it */
export function recordServePort(dataDir, port, platform = process.platform) {
  changeServeState(dataDir, (s) => (s.port === port ? s : { ...s, port }), platform)
}

/**
 * A new key, and no full credential, keeping the port. Only when the person asks (`--rotate-token`): every hub pairs
 * again at its next link, the window at its next start, and a serve already running keeps its old key (what it hands
 * out) until it restarts, while the full credentials end at once.
 */
export function rotateServeToken(dataDir, platform = process.platform) {
  ensureServeState(dataDir, platform)
  return changeServeState(dataDir, (s) => ({ ...s, key: randomBytes(32).toString('base64url'), full: [], legacyHostToken: null }), platform)
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

/** Replaces a private file whole (`replaceFile`), created 0600 as `writePrivate` creates one; `rename` goes to `renameRetrying` */
function replacePrivate(file, value, platform, rename = {}) {
  replaceFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx', ...rename })
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
 *
 * `portRecorded`: serve.json names the port the probe went to (`state.port != null`). A folder that has none was probed
 * on the default port, where whatever listens is as likely another host's (a hub's ssh forward to a linked machine's serve
 * lands there): an unproven answer from it says nothing about this folder, whoever holds the lock.
 */
export function heldHere(probe, dataDir, startOf = processStartTime, portRecorded = true) {
  if (probe.running) return true
  if (!probe.unproven || !portRecorded) return false
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

/**
 * host.lock's `{ pid, started, by? }`; a bare pid (an older host) has no start time. `by` (#1223, additive) is who
 * started the host: `app`, `keeper` or `serve` (`instance-lock.ts`), absent when the host did not say
 */
function parseLockHolder(text) {
  const t = text.trim()
  if (/^\d+$/.test(t)) return Number(t) > 0 ? { pid: Number(t), started: null } : null
  try {
    const v = JSON.parse(t)
    if (!Number.isInteger(v?.pid) || v.pid <= 0) return null
    const by = v.by === 'app' || v.by === 'keeper' || v.by === 'serve' ? v.by : null
    return { pid: v.pid, started: typeof v.started === 'string' ? v.started : null, ...(by ? { by } : {}) }
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

/** Who `host.lock` names as the data folder's owner, `{ pid, started, by? }`, or null */
export function lockHolder(dataDir) {
  try {
    return parseLockHolder(readFileSync(join(dataDir, 'host.lock'), 'utf8'))
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
