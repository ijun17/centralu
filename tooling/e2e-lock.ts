/**
 * The e2e lock (#1632): one run of `pnpm e2e`, `pnpm ux`, `pnpm perf` or `pnpm perf:memory` per machine at a time.
 *
 * Two runs share ports and browsers and fail each other in ways that look like flakes. The lock used to be a line in each
 * agent's shell (`until mkdir /tmp/centralu-e2e.lock …`), and `/tmp` is a different folder in Git Bash, WSL and PowerShell,
 * so two runs overlapped; a run that was killed left the folder behind and every later run waited for ever. Now the
 * runners take it (tooling/with-e2e-lock.ts), in a folder every shell on the machine sees (`lockFile`).
 *
 * The lock names its holder: the runner's process id and a stamp of when that process started (`Started`), and the command
 * it runs (a Playwright process the runner started is named too, since a runner that is killed does not take its child
 * with it on every OS). A holder is gone when its process does not exist, or exists with another start stamp (the id was
 * reused). Only then is the lock taken over, and it says so. There is no expiry by time: a run that takes an hour holds it
 * for an hour. While it waits, a run prints who holds it.
 *
 * Taking it is a compare-and-swap on a name. The lock is a set of files `<file>.<generation>`; the one with the highest
 * generation is the lock. A file is written whole under a private name and hard-linked to `<file>.<top + 1>`, which fails if
 * that name exists. So of any number of runs that judged the same holder gone, one creates the next generation and the
 * others fail and look again; a late run that judged an old holder gone can never move a lock that was taken since, because
 * the name it aims at is taken, and the lock file is never absent between holders. A run that did create a name checks that
 * it is the highest and that no other lock below it is held (the case of a number that was free again), and withdraws if
 * not. The files below the lock are stale and removed. A file that names no holder is never removed.
 *
 * It asks the OS what no Node API tells: when a process started. This module is in the OS layer (tooling/os-layer.js), and
 * its tests run on every OS.
 */
import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { posix, win32, dirname, basename, join } from 'node:path'

/**
 * When a process started, as a stamp that does not move while it runs and tells it from another that got its id later:
 * milliseconds since the epoch (macOS, Windows), or on Linux `<boot id>:<ticks since boot>`, a string compared whole
 */
export type Started = number | string
/** A process: its id and the stamp of when it started (null while it is not known) */
export type Proc = { pid: number; started: Started | null }
/** What a lock names: the runner, what it runs, the child it started, and whether it may have made the old lock folder (`legacyLockDir`) */
export type Holder = Proc & { at: number; command: string; cwd: string; child?: Proc; legacy?: boolean }

/** The OS's answers about other processes; replaced in tests */
export type Probe = {
  alive: (pid: number) => boolean
  startOf: (pid: number) => Started | null
}

const LOCK_NAME = 'centralu-e2e-lock.json'

/**
 * The lock's file name (its generations are `<name>.<n>`): `E2E_LOCK_FILE` when set (the tests), otherwise one place for the
 * whole machine, the same from every shell and sandbox, and not one that follows a variable. On POSIX a fixed `/tmp`:
 * `os.tmpdir()` follows `$TMPDIR`, which macOS sets per user and not at all under ssh, cron or `env -i`. On Windows the
 * folder `%ProgramData%` names (`C:\ProgramData`, which every user may create files in), not `%TEMP%`, which a shell, a
 * sandbox or a service can set to its own. A WSL shell and native Windows are two machines to this lock: WSL's `/tmp` is not
 * a Windows folder, so a run in each does not wait for the other.
 */
export const lockFile = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string => {
  if (env.E2E_LOCK_FILE) return env.E2E_LOCK_FILE
  return platform === 'win32' ? win32.join(env.ProgramData || 'C:\\ProgramData', LOCK_NAME) : posix.join('/tmp', LOCK_NAME)
}

/**
 * The folder the shell line this replaced made (`until mkdir /tmp/centralu-e2e.lock …`; in Git Bash on Windows that is the
 * temporary folder). A branch cut before the runners took the lock still runs bare Playwright behind only that line, so while
 * a run holds the lock it makes this folder too, and removes it when it gives the lock back, only if it made it. It never
 * waits for it: an old line in a new checkout holds it itself around a run that holds the lock, and waiting would be a
 * deadlock. So this protects one direction only: a new run does not stop an old run that holds the folder. To be removed once
 * no branch is left that has the line (#1637).
 */
export const legacyLockDir = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string =>
  env.E2E_LEGACY_LOCK_DIR || join(platform === 'win32' ? tmpdir() : '/tmp', 'centralu-e2e.lock')

/** The error code (`ENOENT`, `EPERM`) of what was thrown, when it has one */
const code = (err: unknown): string | undefined => (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined)

/** What a shell reports for a process a signal ended: 128 plus the signal's number (137 for SIGKILL, 143 for SIGTERM, 130 for SIGINT) */
export const signalExit = (signal: string | null): number => 128 + (Object.entries(constants.signals).find(([name]) => name === signal)?.[1] ?? 1)

/**
 * Is a SIGINT or SIGTERM that reaches the runner passed on to its command? Not on Windows: a console's Ctrl-C reaches every
 * process on the console, the command included, which then tears down and writes its report; `child.kill` there is
 * `TerminateProcess`, which would end it outright, skipping that. (Windows has no other signal to pass on.)
 */
export const passesSignalOn = (platform: NodeJS.Platform = process.platform): boolean => platform !== 'win32'

/** How the start time is asked of the OS: the program and its arguments, per platform */
export function startTimeCommand(pid: number, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32') {
    // Milliseconds since the epoch, an integer: the answer does not follow the user's locale or time zone
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`] }
  }
  return { file: 'ps', args: ['-o', 'lstart=', '-p', String(pid)] }
}

/** Runs a program with this environment added to the process's, and returns what it printed, or null when it failed; replaced in tests */
export type Run = (file: string, args: string[], env: Record<string, string>) => string | null
export type RunAsync = (file: string, args: string[], env: Record<string, string>) => Promise<string | null>
/** Reads a text file, or null when it cannot be read; replaced in tests */
export type ReadText = (path: string) => string | null

/**
 * What `ps` is run with: `lstart` is written in local time and in the locale's words ("2026년 9월 27일 …"), so two runs in
 * another time zone or locale would read the same process as having started at another time and take over a live lock.
 * Both are pinned: `UTC0` is a POSIX time zone (no daylight saving), `C` the one locale with English names.
 */
export const PS_ENV = { LC_ALL: 'C', TZ: 'UTC0' }

const run: Run = (file, args, env) => {
  try {
    const out = execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env } })
    return out.trim() || null
  } catch {
    return null
  }
}

const runAsync: RunAsync = (file, args, env) =>
  new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, ...env } }, (err, stdout) => resolve(err ? null : stdout.trim() || null))
    } catch {
      resolve(null)
    }
  })

const readText: ReadText = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Mon Oct 26 10:00:00 2026` (`ps -o lstart=` in the C locale, in UTC) as milliseconds since the epoch; null if it is not that */
export function parseLstart(text: string): number | null {
  const m = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim())
  const month = m ? MONTHS.indexOf(m[1] ?? '') : -1
  if (!m || month < 0) return null
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
}

/**
 * Linux: `<boot id>:<starttime>` from `/proc/<pid>/stat` (field 22, in clock ticks since boot). `ps -o lstart` adds that to the
 * boot time, which is the clock minus the uptime, so it moves when the clock is stepped (a VM resumed, an NTP step) and a live
 * holder would look like a reused id. Ticks since boot do not move; the boot id keeps one boot's ticks from another's.
 */
export function procStamp(pid: number, read: ReadText = readText): string | null {
  const stat = read(`/proc/${pid}/stat`)
  const boot = read('/proc/sys/kernel/random/boot_id')?.trim()
  if (stat === null || !boot) return null
  // `pid (comm) state …`: the name can hold spaces and brackets, so count from the last `)`
  const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
  const ticks = rest[19] // field 22 overall; `state` is the first of these, field 3
  return ticks !== undefined && /^\d+$/.test(ticks) ? `${boot}:${ticks}` : null
}

const parseStart = (out: string | null, platform: NodeJS.Platform): number | null => {
  if (out === null) return null
  if (platform === 'win32') {
    const ms = Number(out)
    return Number.isFinite(ms) && ms > 0 ? ms : null
  }
  return parseLstart(out)
}

/**
 * When `pid` started, as a stamp that is the same whatever the asker's time zone and locale and does not move with the
 * clock: `/proc` on Linux, otherwise (and where `/proc` cannot be read) milliseconds since the epoch from `ps` (macOS: the time
 * the kernel recorded at the process's creation) or PowerShell (Windows: its creation time). null when the OS cannot say.
 */
export function processStartTime(pid: number, ask: Run = run, platform: NodeJS.Platform = process.platform, read: ReadText = readText): Started | null {
  if (platform === 'linux') {
    const stamp = procStamp(pid, read)
    if (stamp !== null) return stamp
  }
  const { file, args } = startTimeCommand(pid, platform)
  return parseStart(ask(file, args, platform === 'win32' ? {} : PS_ENV), platform)
}

/** `processStartTime` without holding the event loop: a PowerShell run takes seconds */
export async function processStartTimeAsync(pid: number, ask: RunAsync = runAsync, platform: NodeJS.Platform = process.platform, read: ReadText = readText): Promise<Started | null> {
  if (platform === 'linux') {
    const stamp = procStamp(pid, read)
    if (stamp !== null) return stamp
  }
  const { file, args } = startTimeCommand(pid, platform)
  return parseStart(await ask(file, args, platform === 'win32' ? {} : PS_ENV), platform)
}

/**
 * This process's own start stamp. On Windows from the uptime Node keeps (a few hundred milliseconds off the process's creation
 * time, well within the tolerance), since asking PowerShell takes seconds before every run; elsewhere asked of the OS.
 */
export function ownStart(platform: NodeJS.Platform = process.platform, uptime: number = process.uptime(), now: number = Date.now()): Started | null {
  return platform === 'win32' ? Math.round(now - uptime * 1000) : processStartTime(process.pid, run, platform)
}

/** `ps` rounds to the second, and the clocks of Node and Windows differ a little: starts this close are the same process */
export const START_TOLERANCE_MS = 2000
/** Are these the same process? Epoch times within the tolerance; stamps whole. Two kinds that cannot be compared (a Linux host that sometimes could not read `/proc`) are taken as the same: a live process is never called gone for that */
const sameStart = (a: Started, b: Started): boolean => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= START_TOLERANCE_MS : typeof a !== typeof b || a === b)

/** Does a process with this id exist? One that exists but is not ours to signal does too */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return code(err) === 'EPERM'
  }
}

export const realProbe: Probe = { alive: isAlive, startOf: (pid) => (pid === process.pid ? ownStart() : processStartTime(pid)) }

/** Is this process gone: no such id, or the id now belongs to a process that started at another time? */
export function procGone(p: Proc, probe: Probe): boolean {
  if (!probe.alive(p.pid)) return true
  if (p.started === null) return false // it was not known when it was written: only its absence tells
  const now = probe.startOf(p.pid)
  return now !== null && !sameStart(now, p.started)
}

/**
 * A probe that asks for a start stamp only when it has none for that process yet, or the one it has is a minute old. A
 * waiting run looks at the lock every second, and on Windows a start time is a PowerShell process; an id is reused only
 * after its process has died, which `alive` shows, and that forgets the answer.
 */
export function cachedProbe(probe: Probe, now: () => number = Date.now, ttlMs = 60_000): Probe {
  const known = new Map<number, { at: number; value: Started | null }>()
  return {
    alive(pid) {
      const alive = probe.alive(pid)
      if (!alive) known.delete(pid)
      return alive
    },
    startOf(pid) {
      const seen = known.get(pid)
      if (seen && now() - seen.at < ttlMs) return seen.value
      const value = probe.startOf(pid)
      known.set(pid, { at: now(), value })
      return value
    },
  }
}

/** Is the holder gone: the runner and, if it started one, its child */
export function holderGone(h: Holder, probe: Probe): boolean {
  return procGone(h, probe) && (!h.child || procGone(h.child, probe))
}

const field = (v: unknown, name: string): unknown => {
  if (typeof v !== 'object' || v === null) return undefined
  const value: unknown = Reflect.get(v, name)
  return value
}

const asProc = (v: unknown): Proc | null => {
  if (typeof v !== 'object' || v === null) return null
  const pid = field(v, 'pid')
  const started = field(v, 'started')
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  return { pid, started: (typeof started === 'number' && Number.isFinite(started)) || (typeof started === 'string' && started !== '' && started.length <= 200) ? started : null }
}

/** The holder a lock file names; null when the file is not there; `'unreadable'` when it says nothing usable */
export function readHolder(path: string): Holder | null | 'unreadable' {
  let text = ''
  for (let attempt = 0; ; attempt++) {
    try {
      text = readFileSync(path, 'utf8')
      break
    } catch (err) {
      if (code(err) === 'ENOENT') return null
      // The file is being replaced (Windows refuses a read for an instant): look again before calling it unreadable
      if (attempt >= 10) return 'unreadable'
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    const v: unknown = JSON.parse(text)
    const p = asProc(v)
    if (!p) return 'unreadable'
    const child = asProc(field(v, 'child'))
    const at = field(v, 'at')
    const command = field(v, 'command')
    const cwd = field(v, 'cwd')
    const legacy = field(v, 'legacy')
    return { ...p, at: typeof at === 'number' ? at : 0, command: typeof command === 'string' ? command : '', cwd: typeof cwd === 'string' ? cwd : '', ...(child ? { child } : {}), ...(legacy === true ? { legacy: true } : {}) }
  } catch {
    return 'unreadable'
  }
}

/** One generation of the lock: its number and its path */
export type Generation = { gen: number; path: string }

/** The generations that exist for `file`, lowest first */
export function generations(file: string): Generation[] {
  const folder = dirname(file)
  const prefix = `${basename(file)}.`
  let names: string[] = []
  try {
    names = readdirSync(folder)
  } catch (err) {
    if (code(err) !== 'ENOENT') throw err
    mkdirSync(folder, { recursive: true })
  }
  const found: Generation[] = []
  for (const name of names) {
    const rest = name.startsWith(prefix) ? name.slice(prefix.length) : ''
    if (/^\d{1,15}$/.test(rest)) found.push({ gen: Number(rest), path: join(folder, name) })
  }
  return found.sort((a, b) => a.gen - b.gen)
}

export type Held = {
  release: () => void
  setChild: (child: Proc) => void
  /** Makes the old lock folder, having recorded that it may be this lock's; `mkdir` is replaced in tests */
  claimLegacy: (dir: string, inherit: boolean, mkdir?: (dir: string) => void) => void
  holder: Holder
  readonly released: boolean
}
/** One try at the lock: taken, or who holds it (and in which file) */
export type Attempt = { ok: true; held: Held; tookOver: Holder[] } | { ok: false; holder: Holder | null | 'unreadable'; path: string; tookOver: Holder[] }

/** The holder a runner writes for itself */
export function describeSelf(command: string, probe: Probe = realProbe, now: () => number = Date.now): Holder {
  // One line, and short enough to print: a `node -e` script can be long
  const line = command.replace(/\s+/g, ' ').trim()
  return { pid: process.pid, started: probe.startOf(process.pid), at: now(), command: line.length > 160 ? `${line.slice(0, 157)}...` : line, cwd: process.cwd() }
}

/** Writes `holder` whole under a private name and links it to `path`; fails with EEXIST when that name exists */
function linkNew(path: string, holder: Holder, link: (existing: string, created: string) => void = linkSync): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const data = JSON.stringify(holder)
  writeFileSync(tmp, data)
  try {
    try {
      link(tmp, path)
    } catch (err) {
      const c = code(err)
      if (c === 'EEXIST') throw err
      // A folder that has no hard links (some network volumes): create the file in one call; it is empty for an instant
      if (c !== 'EPERM' && c !== 'ENOTSUP' && c !== 'EXDEV' && c !== 'ENOSYS') {
        // FAT and exFAT answer EISDIR: say which folder and what it must do, not a bare failure
        throw new Error(`cannot create the lock ${path} (${c ?? (err instanceof Error ? err.message : String(err))}): the folder must support hard links (FAT and exFAT volumes do not); point E2E_LOCK_FILE at a file on another volume`)
      }
      writeFileSync(path, data, { flag: 'wx' })
    }
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // gone already
    }
  }
}

const remove = (path: string) => {
  try {
    unlinkSync(path)
  } catch {
    // gone already
  }
}

/** Hooks for the tests: run at the moments a race has to be made */
export type Hooks = { afterJudged?: (judged: Holder | null) => void; link?: (existing: string, created: string) => void }

/**
 * One try at the lock: taken, or who holds it. A holder that is gone is taken over (it is in `tookOver`). The lock is the
 * highest generation; taking it is creating the next one, which only one of any number of takers can.
 */
export function tryAcquire(file: string, self: Holder, probe: Probe = realProbe, legacyDir: string | null = null, hooks: Hooks = {}): Attempt {
  for (let attempt = 0; attempt < 12; attempt++) {
    const all = generations(file)
    const top = all[all.length - 1]
    let judged: Holder | null = null
    if (top) {
      const holder = readHolder(top.path)
      if (holder === null) continue // released between the two calls
      // A file that names no holder is not ours to remove: a person looks at it
      if (holder === 'unreadable' || !holderGone(holder, probe)) return { ok: false, holder, path: top.path, tookOver: [] }
      judged = holder
    }
    hooks.afterJudged?.(judged)
    const next = (top?.gen ?? 0) + 1
    const mine = `${file}.${next}`
    try {
      linkNew(mine, self, hooks.link)
    } catch (err) {
      if (code(err) !== 'EEXIST') throw err
      continue // someone else made the next generation first: look at theirs
    }
    // Only the highest generation is the lock, and no other lock may be held below it. Both hold unless this number had been
    // free again: a run that judged a holder gone long ago, after that holder's lock and the ones after it were all given back.
    // Ours is told from the others by its number: `file` may be written with `//`, `./` or mixed slashes, and a listing gives
    // the path normalised, so the paths of one file differ as strings.
    const others = generations(file).filter((g) => g.gen !== next)
    const stale: Holder[] = []
    let withdraw = false
    for (const g of others) {
      // A lock above ours: the next taker looks at the highest, so a lock held below it is not held. A live holder above is
      // caught by the liveness test below too, and a dead one is removed with the other stale files; what only this line
      // catches is a file above that names no holder (the empty instant of a lock made without a hard link, or a stray file):
      // it is skipped below, and we would hold a lock under it.
      if (g.gen > next) {
        withdraw = true
        break
      }
      const h = readHolder(g.path)
      if (h === null || h === 'unreadable') continue
      if (holderGone(h, probe)) stale.push(h)
      else withdraw = true
    }
    if (withdraw) {
      remove(mine)
      continue
    }
    const h = held(mine, self)
    // A stale lock below this one that made the old folder: this one takes on removing it (before those files go)
    if (legacyDir !== null) h.claimLegacy(legacyDir, stale.some((s) => s.legacy === true))
    for (const g of others) {
      const o = readHolder(g.path)
      if (o !== null && o !== 'unreadable' && holderGone(o, probe)) remove(g.path)
    }
    return { ok: true, held: h, tookOver: judged === null ? [] : [judged] }
  }
  const all = generations(file)
  const top = all[all.length - 1]
  return { ok: false, holder: top ? readHolder(top.path) : null, path: top?.path ?? file, tookOver: [] }
}

function held(path: string, self: Holder): Held {
  let current = self
  let released = false
  let legacyMade: string | null = null
  const ours = () => {
    const r = readHolder(path)
    return r !== null && r !== 'unreadable' && r.pid === current.pid && r.started === current.started && r.at === current.at
  }
  /** Replaces the lock file with this record (atomically), when the lock is still ours; says whether it did */
  const replace = (next: Holder): boolean => {
    if (released || !ours()) return false
    const data = JSON.stringify(next)
    // Replacing the file can be refused for an instant while another run is reading it (Windows): try again
    for (let attempt = 0; attempt < 40; attempt++) {
      const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        writeFileSync(tmp, data)
        renameSync(tmp, path)
        current = next
        return true
      } catch {
        remove(tmp)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
    }
    return false
  }
  return {
    get holder() {
      return current
    },
    get released() {
      return released
    },
    // The child the runner started, so that the lock is not free while it runs on after a runner that was killed
    setChild(child) {
      replace({ ...current, child })
    },
    // The old lock folder (legacyLockDir), made while this lock is held. The intent is written first and the folder made
    // after, so a runner killed between the two leaves a record that says the folder may be its own: whoever takes the lock
    // over removes it (`inherit`). Made the other way round, a kill between them left a folder no record owned.
    claimLegacy(dir, inherit, mkdir = (d) => mkdirSync(d)) {
      if (existsSync(dir) && !inherit) return // an old shell line holds it, and it is not ours to remove
      if (!replace({ ...current, legacy: true })) return
      if (inherit) {
        try {
          rmdirSync(dir)
        } catch {
          // not there
        }
      }
      try {
        mkdir(dir)
        legacyMade = dir
      } catch {
        // An old shell line made it just now: not ours, so the record stops saying it may be
        replace({ ...current, legacy: false })
      }
    },
    release() {
      if (released) return
      released = true
      // Only our own record is removed: a lock that is not ours any more is someone else's
      const own = ours()
      if (legacyMade !== null) {
        try {
          rmdirSync(legacyMade)
        } catch {
          // gone already
        }
      }
      if (own) remove(path)
    },
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type TrackOptions = {
  /** Asks when the child started; may take seconds */
  ask?: (pid: number) => Promise<Started | null>
  alive?: (pid: number) => boolean
  /** First wait before asking again; doubles up to ten seconds */
  retryMs?: number
}

/**
 * Names the child the runner started in the lock at once, without a start time, and fills the start time in when it is
 * known, asking again until it is (or the child is gone, or the lock was given back). A runner killed in between still
 * leaves the child named, so the lock is not free while Playwright runs.
 */
export async function trackChild(h: Held, pid: number, opts: TrackOptions = {}): Promise<void> {
  const ask = opts.ask ?? ((p: number) => processStartTimeAsync(p))
  const alive = opts.alive ?? isAlive
  h.setChild({ pid, started: null })
  let wait = opts.retryMs ?? 500
  while (!h.released) {
    const started = await ask(pid)
    if (started !== null) {
      h.setChild({ pid, started })
      return
    }
    if (!alive(pid)) return
    await sleep(wait)
    wait = Math.min(wait * 2, 10_000)
  }
}

const minutes = (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`)

/** What a waiting run says about the holder: who, doing what, where, since when */
export function waitingLine(holder: Holder | null | 'unreadable', path: string, now: number = Date.now()): string {
  if (holder === 'unreadable') return `waiting for the e2e lock: ${path} is not a lock this tool wrote (it names no holder); delete it if no run holds it`
  if (holder === null) return 'waiting for the e2e lock'
  const since = holder.at > 0 ? ` since ${new Date(holder.at).toTimeString().slice(0, 8)} (${minutes(now - holder.at)} ago)` : ''
  const child = holder.child ? `, running as pid ${holder.child.pid}` : ''
  return `waiting for the e2e lock: held by pid ${holder.pid}${child}${holder.command ? ` (${holder.command})` : ''}${holder.cwd ? ` in ${holder.cwd}` : ''}${since}`
}

export type AcquireOptions = {
  file?: string
  command: string
  probe?: Probe
  /** How often a waiting run looks again */
  pollMs?: number
  /** Where lines for the person go */
  say?: (line: string) => void
  now?: () => number
  /** The old lock folder to make while the lock is held (`legacyLockDir`); null for none */
  legacyDir?: string | null
  /** Stops the wait: the promise rejects */
  signal?: AbortSignal
}

/** Waits for the lock, saying who holds it when it first waits, when the holder changes, and every minute */
export async function acquireLock(opts: AcquireOptions): Promise<Held> {
  const file = opts.file ?? lockFile()
  const now = opts.now ?? Date.now
  // A start time is asked for once per process, not at every look (on Windows it is a PowerShell process)
  const probe = cachedProbe(opts.probe ?? realProbe, now)
  const legacyDir = opts.legacyDir === undefined ? legacyLockDir() : opts.legacyDir
  const say = opts.say ?? ((line: string) => console.error(`e2e lock: ${line}`))
  const self = describeSelf(opts.command, probe, now)
  let shown = ''
  let shownAt = 0
  for (;;) {
    const r = tryAcquire(file, self, probe, legacyDir)
    for (const gone of r.tookOver) say(`the holder, pid ${gone.pid}${gone.command ? ` (${gone.command})` : ''}, is gone; taking the lock over`)
    if (r.ok) return r.held
    const line = waitingLine(r.holder, r.path, now())
    if (line.replace(/ \(\d+ (s|min) ago\)/, '') !== shown || now() - shownAt >= 60_000) {
      say(line)
      shown = line.replace(/ \(\d+ (s|min) ago\)/, '')
      shownAt = now()
    }
    await new Promise<void>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new Error('stopped while waiting for the e2e lock'))
      const timer = setTimeout(resolve, opts.pollMs ?? 1000)
      opts.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('stopped while waiting for the e2e lock'))
        },
        { once: true },
      )
    })
  }
}
