/**
 * The e2e lock (#1632): one run of `pnpm e2e`, `pnpm ux`, `pnpm perf` or `pnpm perf:memory` per machine at a time.
 *
 * Two runs share ports and browsers and fail each other in ways that look like flakes. The lock used to be a line in each
 * agent's shell (`until mkdir /tmp/centralu-e2e.lock …`), and `/tmp` is a different folder in Git Bash, WSL and PowerShell,
 * so two runs overlapped; a run that was killed left the folder behind and every later run waited for ever. Now the
 * runners take it (tooling/with-e2e-lock.ts), in a folder every shell on the machine sees (`lockDir`).
 *
 * The lock is one file naming its holder: the runner's process id and that process's start time, and the command it
 * runs (a Playwright process the runner started is named too, since a runner that is killed does not take its child
 * with it on every OS). A holder is gone when its process does not exist, or exists with another start time (the id was
 * reused). Only then is the lock taken over, and it says so. There is no expiry by time: a run that takes an hour holds it
 * for an hour. While it waits, a run prints who holds it.
 *
 * Taking it is atomic: the file is written whole under a private name and then hard-linked to the lock's name, which
 * fails if the name exists, so no one reads a lock half written. A stale lock is moved aside by rename (one mover wins)
 * and read again before it is removed, and put back if it turned out to be someone's live lock.
 *
 * It asks the OS what no Node API tells: when a process started (`ps` on POSIX, PowerShell on Windows). This module is in
 * the OS layer (tooling/os-layer.js), and its tests run on every OS.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A process, told apart from another that got its id later: the time it started, as milliseconds since the epoch (UTC) */
export type Proc = { pid: number; started: number | null }
/** What the lock file says: the runner, what it runs, the child it started, and whether it made the old lock folder (`legacyLockDir`) */
export type Holder = Proc & { at: number; command: string; cwd: string; child?: Proc; legacy?: boolean }

/** The OS's answers about other processes; replaced in tests */
export type Probe = {
  alive: (pid: number) => boolean
  startOf: (pid: number) => number | null
}

/**
 * The folder the lock is in. On POSIX a fixed `/tmp`: `os.tmpdir()` follows `$TMPDIR`, which macOS sets per user and not at
 * all under ssh, cron or `env -i`, so two runs on one machine would not see each other's lock. On Windows Node's temporary
 * folder, the same from every shell (Git Bash's `/tmp` is that folder). A WSL shell and native Windows are two machines to
 * this lock: WSL's `/tmp` is not Windows' temporary folder, so a run in each does not wait for the other.
 */
export const lockDir = (platform: NodeJS.Platform = process.platform): string => (platform === 'win32' ? tmpdir() : '/tmp')

/** The lock's file: `E2E_LOCK_FILE` when set (the tests), otherwise in `lockDir()` */
export const lockFile = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string => env.E2E_LOCK_FILE || join(lockDir(platform), 'centralu-e2e-lock.json')

/**
 * The folder the shell line this replaced made (`until mkdir /tmp/centralu-e2e.lock …`). A branch cut before the runners took
 * the lock still runs bare Playwright behind only that line, so while a run holds the lock it makes this folder too, and
 * removes it when it gives the lock back, only if it made it. It never waits for it: an old line in a new checkout holds it
 * itself around a run that holds the lock, and waiting would be a deadlock. A run that waits for this folder is not protected
 * from an old run in the other direction. To be removed once no branch is left that has the line (a follow-up of #1632).
 */
export const legacyLockDir = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string => env.E2E_LEGACY_LOCK_DIR || join(lockDir(platform), 'centralu-e2e.lock')

/** How the start time is asked: the program and its arguments, per platform */
export function startTimeCommand(pid: number, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32') {
    // Milliseconds since the epoch, an integer: the answer does not follow the user's locale or time zone
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`] }
  }
  return { file: 'ps', args: ['-o', 'lstart=', '-p', String(pid)] }
}

/** The error code (`ENOENT`, `EPERM`) of what was thrown, when it has one */
const code = (err: unknown): string | undefined => (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined)

/** Runs a program with this environment added to the process's, and returns what it printed, or null when it failed; replaced in tests */
export type Run = (file: string, args: string[], env: Record<string, string>) => string | null

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Mon Oct 26 10:00:00 2026` (`ps -o lstart=` in the C locale, in UTC) as milliseconds since the epoch; null if it is not that */
export function parseLstart(text: string): number | null {
  const m = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim())
  const month = m ? MONTHS.indexOf(m[1] ?? '') : -1
  if (!m || month < 0) return null
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
}

/** When `pid` started, as milliseconds since the epoch, the same whatever the asker's time zone and locale; null when the OS cannot say (no such process, no `ps`) */
export function processStartTime(pid: number, ask: Run = run, platform: NodeJS.Platform = process.platform): number | null {
  const { file, args } = startTimeCommand(pid, platform)
  const out = ask(file, args, platform === 'win32' ? {} : PS_ENV)
  if (out === null) return null
  if (platform === 'win32') {
    const ms = Number(out)
    return Number.isFinite(ms) && ms > 0 ? ms : null
  }
  return parseLstart(out)
}

/** `ps` rounds to the second and derives the time from the boot time, which can move by a second: starts this close are the same process */
export const START_TOLERANCE_MS = 2000
const sameStart = (a: number, b: number) => Math.abs(a - b) <= START_TOLERANCE_MS

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

export const realProbe: Probe = { alive: isAlive, startOf: (pid) => processStartTime(pid) }

/** Is this process gone: no such id, or the id now belongs to a process that started at another time? */
export function procGone(p: Proc, probe: Probe): boolean {
  if (!probe.alive(p.pid)) return true
  if (p.started === null) return false // it was not known when it was written: only its absence tells
  const now = probe.startOf(p.pid)
  return now !== null && !sameStart(now, p.started)
}

/**
 * A probe that asks for a start time only when it has none for that process yet, or the one it has is a minute old. A
 * waiting run looks at the lock every second, and on Windows a start time is a PowerShell process; an id is reused only
 * after its process has died, which `alive` shows, and that forgets the answer.
 */
export function cachedProbe(probe: Probe, now: () => number = Date.now, ttlMs = 60_000): Probe {
  const known = new Map<number, { at: number; value: number | null }>()
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

const asProc = (v: unknown): Proc | null => {
  if (typeof v !== 'object' || v === null) return null
  const pid = field(v, 'pid')
  const started = field(v, 'started')
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? { pid, started: typeof started === 'number' && Number.isFinite(started) ? started : null } : null
}

const field = (v: unknown, name: string): unknown => {
  if (typeof v !== 'object' || v === null) return undefined
  const value: unknown = Reflect.get(v, name)
  return value
}

/** The holder a lock file names; null when the file is not there or says nothing usable (`'unreadable'`) */
export function readHolder(file: string): Holder | null | 'unreadable' {
  let text = ''
  for (let attempt = 0; ; attempt++) {
    try {
      text = readFileSync(file, 'utf8')
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

const sameHolder = (a: Holder | null | 'unreadable', b: Holder): boolean => a !== null && a !== 'unreadable' && a.pid === b.pid && a.started === b.started && a.at === b.at

export type Held = { release: () => void; setChild: (child: Proc) => void; claimLegacy: (dir: string, inherit: boolean) => void; holder: Holder }
export type Attempt = { ok: true; held: Held; tookOver: Holder[] } | { ok: false; holder: Holder | null | 'unreadable'; tookOver: Holder[] }

/** The holder a runner writes for itself */
export function describeSelf(command: string, probe: Probe = realProbe, now: () => number = Date.now): Holder {
  // One line, and short enough to print: a `node -e` script can be long
  const line = command.replace(/\s+/g, ' ').trim()
  return { pid: process.pid, started: probe.startOf(process.pid), at: now(), command: line.length > 160 ? `${line.slice(0, 157)}...` : line, cwd: process.cwd() }
}

/** Writes `holder` whole under a private name and links it to `file`; fails with EEXIST when the lock is held */
function linkNew(file: string, holder: Holder): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const data = JSON.stringify(holder)
  writeFileSync(tmp, data)
  try {
    try {
      linkSync(tmp, file)
    } catch (err) {
      // A folder that has no hard links (a FAT or network volume as the temporary folder): create the file in one call; it is empty for an instant
      if (code(err) !== 'EPERM' && code(err) !== 'ENOTSUP' && code(err) !== 'EXDEV' && code(err) !== 'ENOSYS') throw err
      writeFileSync(file, data, { flag: 'wx' })
    }
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // gone already
    }
  }
}

/**
 * Moves a lock that was judged stale out of the way. Only one mover can rename it; the one that did reads what it moved,
 * and if that is not the holder that was judged (someone took the lock in between), links it back.
 */
function reap(file: string, judged: Holder): boolean {
  const aside = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.gone`
  try {
    renameSync(file, aside)
  } catch {
    return false // someone else moved it, or it is gone
  }
  const moved = readHolder(aside)
  let removed = true
  if (!sameHolder(moved, judged)) {
    removed = false
    try {
      linkSync(aside, file)
    } catch {
      // The name was taken again meanwhile: that holder keeps it, and the one we moved is lost. Two such steps in a row are what this cannot prevent.
    }
  }
  try {
    unlinkSync(aside)
  } catch {
    // gone already
  }
  return removed
}

/** One try at the lock: taken, or who holds it. A holder that is gone is taken over (it is in `tookOver`) */
export function tryAcquire(file: string, self: Holder, probe: Probe = realProbe, legacyDir: string | null = null): Attempt {
  const tookOver: Holder[] = []
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      linkNew(file, self)
      const h = held(file, self)
      if (legacyDir !== null) h.claimLegacy(legacyDir, tookOver.some((t) => t.legacy === true))
      return { ok: true, tookOver, held: h }
    } catch (err) {
      if (code(err) !== 'EEXIST') throw err
    }
    const holder = readHolder(file)
    if (holder === null) continue // released between the two calls
    // A file that names no holder is not ours to remove: a person looks at it
    if (holder === 'unreadable' || !holderGone(holder, probe)) return { ok: false, holder, tookOver }
    if (reap(file, holder)) tookOver.push(holder)
  }
  return { ok: false, holder: readHolder(file), tookOver }
}

function held(file: string, self: Holder): Held {
  let current = self
  let released = false
  let legacyMade: string | null = null
  const ours = () => sameHolder(readHolder(file), current)
  /** Replaces the lock file with this record (atomically), when the lock is still ours */
  const replace = (next: Holder) => {
    if (released || !ours()) return
    const data = JSON.stringify(next)
    // Replacing the file can be refused for an instant while another run is reading it (Windows): try again
    for (let attempt = 0; attempt < 40; attempt++) {
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        writeFileSync(tmp, data)
        renameSync(tmp, file)
        current = next
        return
      } catch {
        try {
          unlinkSync(tmp)
        } catch {
          // nothing written
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
    }
  }
  return {
    get holder() {
      return current
    },
    // The child the runner started, so that the lock is not free while it runs on after a runner that was killed
    setChild(child) {
      replace({ ...current, child })
    },
    // The old lock folder (legacyLockDir), made while this lock is held and recorded, so that a run that takes this one over
    // from a killed holder can remove what the holder left (`inherit`)
    claimLegacy(dir, inherit) {
      if (inherit) {
        try {
          rmdirSync(dir)
        } catch {
          // not there, or not empty
        }
      }
      try {
        mkdirSync(dir)
      } catch {
        return // there already: an old shell line holds it, and it is not ours to remove
      }
      legacyMade = dir
      replace({ ...current, legacy: true })
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
      if (!own) return
      try {
        unlinkSync(file)
      } catch {
        // gone already
      }
    },
  }
}

const minutes = (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`)

/** What a waiting run says about the holder: who, doing what, where, since when */
export function waitingLine(holder: Holder | null | 'unreadable', file: string, now: number = Date.now()): string {
  if (holder === 'unreadable') return `waiting for the e2e lock: ${file} is not a lock this tool wrote (it names no holder); delete it if no run holds it`
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
    const line = waitingLine(r.holder, file, now())
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
