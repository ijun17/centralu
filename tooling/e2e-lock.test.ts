/**
 * The e2e lock (tooling/e2e-lock.ts, tooling/with-e2e-lock.ts; #1632). It is in the OS layer, so this runs on every OS:
 * the unit cases with the OS's answers replaced, and the real ones (two runners at once, a holder killed, a run in another
 * time zone and locale) with real processes, which on Windows ask PowerShell for a start time and on Linux read `/proc`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireLock,
  cachedProbe,
  describeSelf,
  generations,
  holderGone,
  isAlive,
  legacyLockDir,
  lockFile,
  ownStart,
  parseLstart,
  procGone,
  processStartTime,
  procStamp,
  PS_ENV,
  readHolder,
  signalExit,
  startTimeCommand,
  trackChild,
  tryAcquire,
  waitingLine,
  type Attempt,
  type Holder,
  type Probe,
  type Started,
} from './e2e-lock.js'
import { eventually, SLOW } from './test-timing.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOUR = 3_600_000

let dir: string
let file: string
let legacy: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-lock-test-'))
  file = join(dir, 'lock.json')
  legacy = join(dir, 'legacy.lock')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A probe over a table of live processes: pid → start stamp */
const probeOf = (live: Record<number, Started>): Probe => ({ alive: (pid) => pid in live, startOf: (pid) => live[pid] ?? null })
const holder = (pid: number, started: Started | null, extra: Partial<Holder> = {}): Holder => ({ pid, started, at: 1_000, command: 'playwright test', cwd: '/work', ...extra })
/** Writes a lock file by hand: this holder as the given generation */
const write = (h: unknown, gen = 1) => writeFileSync(`${file}.${gen}`, JSON.stringify(h))
/** What is in the lock folder that belongs to the lock (its generations and any private file) */
const lockFiles = () => readdirSync(dir).filter((n) => n.startsWith('lock.json')).sort()
/** The holder of the lock now: the highest generation */
const top = () => {
  const all = generations(file)
  const g = all[all.length - 1]
  return g ? readHolder(g.path) : null
}
const taken = (r: Attempt) => {
  if (!r.ok) throw new Error('the lock was not taken')
  return r.held
}

describe('where the lock is and how a start time is asked', () => {
  it('is one fixed file: /tmp on POSIX and ProgramData on Windows, whatever TMPDIR and TEMP say, or the file E2E_LOCK_FILE names', () => {
    // $TMPDIR is per user on macOS and unset under ssh and cron; %TEMP% is what a shell or a sandbox sets for itself. Neither
    // can be where a machine-wide lock is, and `os.tmpdir()` reads both from the real environment, so they are set here
    const keep = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }
    try {
      process.env.TMPDIR = join(dir, 'per-user-tmp')
      process.env.TEMP = join(dir, 'other-temp')
      process.env.TMP = join(dir, 'other-temp')
      expect(lockFile({}, 'darwin')).toBe('/tmp/centralu-e2e-lock.json')
      expect(lockFile({}, 'linux')).toBe('/tmp/centralu-e2e-lock.json')
      expect(lockFile({ TMPDIR: '/var/folders/x/T/' }, 'darwin')).toBe('/tmp/centralu-e2e-lock.json')
      expect(lockFile({ ProgramData: 'D:\\PD', TEMP: 'E:\\t', TMP: 'E:\\t' }, 'win32')).toBe('D:\\PD\\centralu-e2e-lock.json')
      expect(lockFile({}, 'win32')).toBe('C:\\ProgramData\\centralu-e2e-lock.json')
      expect(lockFile({ E2E_LOCK_FILE: '/x/y.json' })).toBe('/x/y.json')
    } finally {
      for (const [key, value] of Object.entries(keep)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
  it('keeps the old lock folder where the shell line made it', () => {
    expect(legacyLockDir({}, 'linux')).toBe(join('/tmp', 'centralu-e2e.lock'))
    expect(legacyLockDir({}, 'win32')).toBe(join(tmpdir(), 'centralu-e2e.lock'))
    expect(legacyLockDir({ E2E_LEGACY_LOCK_DIR: '/x/old' })).toBe('/x/old')
  })
  it('asks PowerShell on Windows for milliseconds since the epoch, and ps elsewhere', () => {
    const win = startTimeCommand(4321, 'win32')
    expect(win.file).toBe('powershell.exe')
    expect(win.args.join(' ')).toContain('Get-Process -Id 4321')
    expect(win.args.join(' ')).toContain('ToUnixTimeMilliseconds()')
    for (const platform of ['linux', 'darwin'] as const) expect(startTimeCommand(4321, platform)).toEqual({ file: 'ps', args: ['-o', 'lstart=', '-p', '4321'] })
  })
  it('runs ps in UTC and the C locale whatever the asker has, and reads what it prints as a time', () => {
    const asked: { file: string; args: string[]; env: Record<string, string> }[] = []
    const ask = (out: string | null) => (file: string, args: string[], env: Record<string, string>) => (asked.push({ file, args, env }), out)
    const noProc = () => null
    expect(processStartTime(7, ask('Mon Oct 26 10:00:00 2026'), 'linux', noProc)).toBe(Date.UTC(2026, 9, 26, 10, 0, 0))
    expect(asked[0]).toEqual({ file: 'ps', args: ['-o', 'lstart=', '-p', '7'], env: PS_ENV })
    expect(PS_ENV).toEqual({ LC_ALL: 'C', TZ: 'UTC0' })
    // A day below ten is padded with a space
    expect(processStartTime(7, ask('Tue Oct  6 09:05:01 2026'), 'darwin')).toBe(Date.UTC(2026, 9, 6, 9, 5, 1))
    // Windows: the integer PowerShell printed
    expect(processStartTime(7, ask('1793069759858'), 'win32')).toBe(1793069759858)
    expect(processStartTime(7, ask('not a number'), 'win32')).toBeNull()
    expect(processStartTime(7, ask(null), 'win32')).toBeNull()
    expect(processStartTime(7, ask(null), 'linux', noProc)).toBeNull()
  })
  it('does not read a time written in another locale’s words, which a pinned ps never prints', () => {
    expect(parseLstart('2026년 9월 27일 일요일 10시 00분 00초')).toBeNull()
    expect(parseLstart('Mon Okt 26 10:00:00 2026')).toBeNull()
    expect(parseLstart('Mon Oct 26 10:00:00 2026')).toBe(Date.UTC(2026, 9, 26, 10, 0, 0))
  })
  it('on Linux is the start tick from /proc with the boot id, which a stepped clock does not move, and ps only when /proc cannot be read', () => {
    // The name can hold spaces and brackets: the fields are counted from the last `)`
    const stat = '123 (my (odd) name) S 1 123 123 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1234567 89 18446744073709551615'
    const proc = (path: string) => (path === '/proc/123/stat' ? stat : path === '/proc/sys/kernel/random/boot_id' ? 'b00t-1d\n' : null)
    expect(procStamp(123, proc)).toBe('b00t-1d:987654')
    expect(procStamp(124, proc)).toBeNull()
    expect(procStamp(123, (p) => (p.endsWith('boot_id') ? '' : stat))).toBeNull()
    expect(procStamp(123, () => '123 (x) S 1 2')).toBeNull()
    // `ps` is not asked at all, and the clock is not read: the answer is the same at any time
    const noPs = () => {
      throw new Error('ps must not be asked')
    }
    expect(processStartTime(123, noPs, 'linux', proc)).toBe('b00t-1d:987654')
    expect(processStartTime(123, () => 'Mon Oct 26 10:00:00 2026', 'linux', () => null)).toBe(Date.UTC(2026, 9, 26, 10, 0, 0))
    // macOS and Windows record the creation time, an absolute time; they are not asked for ticks
    expect(processStartTime(123, () => 'Mon Oct 26 10:00:00 2026', 'darwin', proc)).toBe(Date.UTC(2026, 9, 26, 10, 0, 0))
    if (process.platform === 'linux') expect(processStartTime(process.pid)).toMatch(/^[0-9a-f-]+:\d+$/)
  })
  it('is this process’s start time without asking PowerShell on Windows, a few hundred milliseconds from what PowerShell says', () => {
    expect(ownStart('win32', 100, 1_000_000)).toBe(900_000)
    if (process.platform === 'win32') {
      const asked = processStartTime(process.pid)
      expect(typeof asked).toBe('number')
      expect(Math.abs(Number(asked) - Number(ownStart()))).toBeLessThan(1500)
    }
  }, 60_000 * SLOW)
  it('gives the same start time for this process in any time zone and locale the asker has', () => {
    const keep = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG }
    try {
      const started = processStartTime(process.pid)
      expect(started).not.toBeNull()
      if (typeof started === 'number') {
        // About when this process started
        expect(Math.abs(started - (Date.now() - process.uptime() * 1000))).toBeLessThan(120_000)
      }
      for (const [tz, locale] of [
        ['Pacific/Auckland', 'ko_KR.UTF-8'],
        ['America/Los_Angeles', 'de_DE.UTF-8'],
        ['UTC', 'C'],
        ['Asia/Kolkata', 'ja_JP.UTF-8'],
      ] as const) {
        process.env.TZ = tz
        process.env.LC_ALL = locale
        process.env.LANG = locale
        const other = processStartTime(process.pid)
        expect(other, `${tz} ${locale}`).not.toBeNull()
        if (typeof other === 'number') expect(Math.abs(other - Number(started)), `${tz} ${locale}`).toBeLessThanOrEqual(2000)
        else expect(other).toBe(started)
      }
    } finally {
      for (const [key, value] of Object.entries(keep)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(0)).toBe(false)
    expect(isAlive(Number.NaN)).toBe(false)
  }, 60_000 * SLOW)
  it('turns a signal into the exit code a shell reports', () => {
    expect(signalExit('SIGKILL')).toBe(137)
    expect(signalExit('SIGTERM')).toBe(143)
    expect(signalExit('SIGINT')).toBe(130)
    expect(signalExit(null)).toBe(129)
    expect(signalExit('SIGNOPE')).toBe(129)
  })
})

describe('when a holder is gone', () => {
  it('is gone when its process does not exist, or the id now belongs to a process that started at another time', () => {
    const probe = probeOf({ 10: 10 * HOUR, 11: 20 * HOUR })
    expect(procGone({ pid: 10, started: 10 * HOUR }, probe)).toBe(false)
    expect(procGone({ pid: 12, started: 10 * HOUR }, probe)).toBe(true)
    // The id was reused
    expect(procGone({ pid: 11, started: 10 * HOUR }, probe)).toBe(true)
    // The same second, read twice, is the same process
    expect(procGone({ pid: 10, started: 10 * HOUR + 1000 }, probe)).toBe(false)
    // A start time that was not known when it was written, or cannot be read now, never makes a live process gone
    expect(procGone({ pid: 10, started: null }, probe)).toBe(false)
    expect(procGone({ pid: 10, started: 10 * HOUR }, { alive: () => true, startOf: () => null })).toBe(false)
  })
  it('compares a Linux stamp whole, and a stamp with a time as never gone because the two cannot be compared', () => {
    const probe = probeOf({ 10: 'boot-a:500' })
    expect(procGone({ pid: 10, started: 'boot-a:500' }, probe)).toBe(false)
    // Another start tick, or another boot: the id was reused
    expect(procGone({ pid: 10, started: 'boot-a:501' }, probe)).toBe(true)
    expect(procGone({ pid: 10, started: 'boot-b:500' }, probe)).toBe(true)
    // A stamp written where /proc could not be read, read where it can (or the other way): the process is alive, so it is held
    expect(procGone({ pid: 10, started: 10 * HOUR }, probe)).toBe(false)
    expect(procGone({ pid: 11, started: 'boot-a:500' }, probeOf({ 11: 10 * HOUR }))).toBe(false)
  })
  it('is held while its runner or the child it started is alive, and gone when both are', () => {
    const probe = probeOf({ 20: 5 * HOUR })
    const withChild = (child: number) => holder(10, 1 * HOUR, { child: { pid: child, started: 5 * HOUR } })
    expect(holderGone(holder(10, 1 * HOUR), probe)).toBe(true)
    expect(holderGone(withChild(20), probe)).toBe(false)
    expect(holderGone(withChild(21), probe)).toBe(true)
    expect(holderGone(holder(20, 5 * HOUR), probe)).toBe(false)
    // A child named before its start time is known is held while it lives
    expect(holderGone(holder(10, 1 * HOUR, { child: { pid: 20, started: null } }), probe)).toBe(false)
  })
  it('asks for a start time once per process, again after a minute or after the process was seen gone', () => {
    let asked = 0
    let now = 0
    const live = new Set([5])
    const base: Probe = { alive: (pid) => live.has(pid), startOf: () => (asked++, 3 * HOUR) }
    const probe = cachedProbe(base, () => now)
    for (let look = 0; look < 20; look++) expect(procGone({ pid: 5, started: 3 * HOUR }, probe)).toBe(false)
    expect(asked).toBe(1)
    now = 61_000
    procGone({ pid: 5, started: 3 * HOUR }, probe)
    expect(asked).toBe(2)
    // The process dies and its id is used again: the new one is asked about
    live.delete(5)
    expect(procGone({ pid: 5, started: 3 * HOUR }, probe)).toBe(true)
    live.add(5)
    procGone({ pid: 5, started: 3 * HOUR }, probe)
    expect(asked).toBe(3)
  })
})

describe('taking the lock', () => {
  it('writes who holds it, and a second run is refused while that holder lives', () => {
    const live = probeOf({ 1: 1 * HOUR, 2: 2 * HOUR })
    const first = tryAcquire(file, holder(1, 1 * HOUR), live)
    expect(first.ok).toBe(true)
    expect(top()).toMatchObject({ pid: 1, started: 1 * HOUR, command: 'playwright test', cwd: '/work' })
    const second = tryAcquire(file, holder(2, 2 * HOUR), live)
    expect(second).toMatchObject({ ok: false, holder: { pid: 1 }, tookOver: [] })
    taken(first).release()
    expect(lockFiles()).toEqual([])
    expect(tryAcquire(file, holder(2, 2 * HOUR), live).ok).toBe(true)
  })
  it('takes over the lock of a holder that is gone, says whose it was, and removes what it left', () => {
    write(holder(1, 1 * HOUR))
    const r = tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 2: 2 * HOUR }))
    expect(r.ok).toBe(true)
    expect(r.tookOver.map((h) => h.pid)).toEqual([1])
    expect(top()).toMatchObject({ pid: 2 })
    expect(lockFiles()).toEqual(['lock.json.2'])
  })
  it('takes it over from a pid that was reused, and not from one that is the same process', () => {
    write(holder(1, 10 * HOUR))
    expect(tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 1: 11 * HOUR, 2: 2 * HOUR })).ok).toBe(true)
    rmSync(`${file}.2`)
    write(holder(1, 10 * HOUR))
    expect(tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 1: 10 * HOUR, 2: 2 * HOUR }))).toMatchObject({ ok: false, holder: { pid: 1 } })
  })
  it('does not take it over while the child the runner started is alive, after the runner was killed', () => {
    write(holder(1, 1 * HOUR, { child: { pid: 3, started: 3 * HOUR } }))
    expect(tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 2: 2 * HOUR, 3: 3 * HOUR }))).toMatchObject({ ok: false, holder: { pid: 1 } })
    expect(tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 2: 2 * HOUR })).ok).toBe(true)
  })
  it('has no expiry: a holder from long ago that is alive keeps the lock', () => {
    write(holder(1, 1 * HOUR, { at: 1 }))
    expect(tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 1: 1 * HOUR, 2: 2 * HOUR }))).toMatchObject({ ok: false, holder: { pid: 1, at: 1 } })
  })
  it('leaves a file that names no holder for a person, and says so', () => {
    writeFileSync(`${file}.1`, 'not json')
    const r = tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 2: 2 * HOUR }))
    expect(r).toMatchObject({ ok: false, holder: 'unreadable', path: `${file}.1` })
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('not json')
    expect(waitingLine('unreadable', `${file}.1`)).toContain('delete it if no run holds it')
    // A stamp in a form this host does not make names a process all the same: the holder is read, and is held while its process lives
    write({ pid: 1, started: 'Mon Oct 26 10:00:00 2026', at: 1, command: 'x', cwd: '/' })
    expect(tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 1: 1 * HOUR, 2: 2 * HOUR }))).toMatchObject({ ok: false, holder: { pid: 1 } })
  })
  it('gives back only its own lock', () => {
    const live = probeOf({ 1: 1 * HOUR, 2: 2 * HOUR })
    const first = taken(tryAcquire(file, holder(1, 1 * HOUR), live))
    // The file now names someone else (this one was taken over after it was thought gone)
    write(holder(2, 2 * HOUR))
    first.release()
    expect(top()).toMatchObject({ pid: 2 })
  })
  it('records the child the runner started, first without its start time and then with it, and keeps the rest', () => {
    const held = taken(tryAcquire(file, holder(1, 1 * HOUR), probeOf({ 1: 1 * HOUR })))
    held.setChild({ pid: 9, started: null })
    expect(top()).toMatchObject({ pid: 1, command: 'playwright test', child: { pid: 9, started: null } })
    held.setChild({ pid: 9, started: 9 * HOUR })
    expect(top()).toMatchObject({ pid: 1, child: { pid: 9, started: 9 * HOUR } })
    held.release()
    expect(lockFiles()).toEqual([])
  })
  it('leaves no private files behind', () => {
    write(holder(1, 1 * HOUR))
    taken(tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 2: 2 * HOUR })))
    taken(tryAcquire(file, holder(4, 4 * HOUR), probeOf({ 4: 4 * HOUR }))) // takes over from 2, which is not in this table
    expect(lockFiles()).toEqual(['lock.json.3'])
  })

  describe('when several runs judge the same holder gone', () => {
    const live = probeOf({ 2: 2 * HOUR, 3: 3 * HOUR, 4: 4 * HOUR, 5: 5 * HOUR })

    it('lets one take it and the others see its lock, whoever looked first (three runs, all of which judged the holder gone before any of them took it)', () => {
      write(holder(1, 1 * HOUR))
      const results: Record<string, Attempt> = {}
      // C judged holder 1 gone and is about to take it; before it does, B judged it too and is about to; before that, A takes it
      const c = tryAcquire(file, holder(4, 4 * HOUR), live, null, {
        afterJudged: () => {
          results.b = tryAcquire(file, holder(3, 3 * HOUR), live, null, {
            afterJudged: () => {
              results.a = tryAcquire(file, holder(2, 2 * HOUR), live)
            },
          })
        },
      })
      expect(results.a).toMatchObject({ ok: true })
      expect(results.b).toMatchObject({ ok: false, holder: { pid: 2 } })
      expect(c).toMatchObject({ ok: false, holder: { pid: 2 }, tookOver: [] })
      // A's lock was not moved, and is the only one
      expect(top()).toMatchObject({ pid: 2, started: 2 * HOUR })
      expect(lockFiles()).toEqual(['lock.json.2'])
    })

    it('does not take a lock that was given back and taken again since it judged the old holder gone (the number it aims at is free again)', () => {
      write(holder(1, 1 * HOUR))
      const late = tryAcquire(file, holder(5, 5 * HOUR), live, null, {
        afterJudged: (judged) => {
          if (judged?.pid !== 1) return
          // Run 2 takes it over and gives it back; nothing is left, so run 3 makes generation 1 again, and it is live
          taken(tryAcquire(file, holder(2, 2 * HOUR), live)).release()
          expect(lockFiles()).toEqual([])
          taken(tryAcquire(file, holder(3, 3 * HOUR), live))
        },
      })
      // The late run made generation 2, saw a live lock below it, and withdrew
      expect(late).toMatchObject({ ok: false, holder: { pid: 3 } })
      expect(lockFiles()).toEqual(['lock.json.1'])
      expect(top()).toMatchObject({ pid: 3 })
    })

    it('withdraws when a higher generation appeared, and leaves that lock alone', () => {
      write(holder(1, 1 * HOUR))
      const late = tryAcquire(file, holder(5, 5 * HOUR), live, null, {
        afterJudged: () => write(holder(3, 3 * HOUR), 5),
      })
      expect(late).toMatchObject({ ok: false, holder: { pid: 3 } })
      expect(top()).toMatchObject({ pid: 3 })
      expect(lockFiles()).toEqual(['lock.json.1', 'lock.json.5'])
    })
  })
})

describe('the old lock folder (a branch from before the runners took the lock)', () => {
  const live = probeOf({ 1: 1 * HOUR, 2: 2 * HOUR })
  it('is made while the lock is held and removed when it is given back', () => {
    const r = tryAcquire(file, holder(1, 1 * HOUR), live, legacy)
    expect(r.ok).toBe(true)
    expect(existsSync(legacy)).toBe(true)
    expect(top()).toMatchObject({ pid: 1, legacy: true })
    taken(r).release()
    expect(existsSync(legacy)).toBe(false)
    expect(lockFiles()).toEqual([])
  })
  it('is never waited for, and never removed when something else made it', () => {
    // An old shell line holds the folder around a run that holds the lock itself: waiting for it would be a deadlock
    mkdirSync(legacy)
    const r = tryAcquire(file, holder(1, 1 * HOUR), live, legacy)
    expect(r.ok).toBe(true)
    expect(top()).not.toMatchObject({ legacy: true })
    taken(r).release()
    expect(existsSync(legacy)).toBe(true)
    expect(lockFiles()).toEqual([])
  })
  it('is left alone when nothing asks for it', () => {
    const r = tryAcquire(file, holder(1, 1 * HOUR), live)
    expect(r.ok).toBe(true)
    expect(existsSync(legacy)).toBe(false)
  })
  it('is handed on by a run that takes the lock over from a killed holder that made it, and not otherwise', () => {
    mkdirSync(legacy)
    write(holder(1, 1 * HOUR, { legacy: true }))
    const r = tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 2: 2 * HOUR }), legacy)
    expect(r.ok).toBe(true)
    expect(top()).toMatchObject({ pid: 2, legacy: true })
    taken(r).release()
    expect(existsSync(legacy)).toBe(false)
    // The killed holder had not made it: the folder is not ours to remove
    mkdirSync(legacy)
    write(holder(1, 1 * HOUR))
    const other = tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 2: 2 * HOUR }), legacy)
    taken(other).release()
    expect(existsSync(legacy)).toBe(true)
  })
  it('is recorded before it is made: a holder killed between the two leaves a record that lets the next run clean up', () => {
    const held = taken(tryAcquire(file, holder(1, 1 * HOUR), live))
    let recordedWhenMade: boolean | undefined
    held.claimLegacy(
      legacy,
      false,
      (d) => {
        // This is the moment before the folder exists
        const h = top()
        recordedWhenMade ??= h !== null && h !== 'unreadable' && h.legacy === true
        mkdirSync(d, { recursive: true })
      },
    )
    expect(recordedWhenMade).toBe(true)
    held.release()
    expect(existsSync(legacy)).toBe(false)
    // A holder killed after the record and before the folder: the record names a folder that is not there, and the next run
    // makes it, owns it, and removes it
    write(holder(1, 1 * HOUR, { legacy: true }))
    const r = tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 2: 2 * HOUR }), legacy)
    expect(existsSync(legacy)).toBe(true)
    taken(r).release()
    expect(existsSync(legacy)).toBe(false)
    // A holder killed after the folder was made and before it recorded anything cannot happen: the record comes first
    expect(lockFiles()).toEqual([])
  })
  it('takes the intent back when an old shell line made the folder in the meantime', () => {
    const held = taken(tryAcquire(file, holder(1, 1 * HOUR), live))
    held.claimLegacy(
      legacy,
      false,
      (d) => {
        mkdirSync(d, { recursive: true })
        throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      },
    )
    expect(top()).not.toMatchObject({ legacy: true })
    held.release()
    expect(existsSync(legacy)).toBe(true)
  })
})

describe('naming the child', () => {
  it('names it at once without a start time, asks again until the start time is known, and stops when it is gone or the lock was given back', async () => {
    const held = taken(tryAcquire(file, holder(1, 1 * HOUR), probeOf({ 1: 1 * HOUR })))
    const answers: (Started | null)[] = [null, null, 7 * HOUR]
    let asked = 0
    const first = trackChild(held, 9, { ask: () => Promise.resolve(answers[asked++] ?? null), alive: () => true, retryMs: 1 })
    // Before the first answer, before anything is awaited: the child is in the lock
    expect(top()).toMatchObject({ pid: 1, child: { pid: 9, started: null } })
    await first
    expect(asked).toBe(3)
    expect(top()).toMatchObject({ child: { pid: 9, started: 7 * HOUR } })
    // A child that is gone before its start time was known stays named, and the asking ends
    let gone = 0
    await trackChild(held, 10, { ask: () => (gone++, Promise.resolve(null)), alive: () => false, retryMs: 1 })
    expect(gone).toBe(1)
    expect(top()).toMatchObject({ child: { pid: 10, started: null } })
    // A lock given back ends the asking, too
    let more = 0
    const loop = trackChild(held, 11, { ask: () => (more++, Promise.resolve(null)), alive: () => true, retryMs: 1 })
    await eventually(() => more > 2 || undefined, 5_000)
    held.release()
    await loop
  })
})

describe('waiting for it', () => {
  it('says who holds it, what it runs, where and since when', () => {
    const line = waitingLine(holder(1234, 1 * HOUR, { at: Date.parse('2026-10-27T10:00:00'), command: 'playwright test e2e/panel.spec.ts', cwd: '/work/a', child: { pid: 1300, started: 3 * HOUR } }), file, Date.parse('2026-10-27T10:05:00'))
    expect(line).toContain('held by pid 1234, running as pid 1300 (playwright test e2e/panel.spec.ts) in /work/a since ')
    expect(line).toContain('(5 min ago)')
  })
  it('names the command on one line, as it was typed: runs of white space are one space', () => {
    const self = describeSelf('playwright   test\n  --config  e2e/x.ts\ttwo', probeOf({}))
    expect(self.command).toBe('playwright test --config e2e/x.ts two')
    expect(waitingLine({ ...self, pid: 5 }, file)).toContain('(playwright test --config e2e/x.ts two)')
    const long = describeSelf(`node -e ${'x '.repeat(200)}`, probeOf({}))
    expect(long.command).toHaveLength(160)
    expect(long.command.endsWith('...')).toBe(true)
  })
  it('waits until the holder gives it back, saying once who holds it', async () => {
    const live = probeOf({ 1: 1 * HOUR })
    write(holder(1, 1 * HOUR))
    const said: string[] = []
    setTimeout(() => rmSync(`${file}.1`), 150)
    const held = await acquireLock({ file, command: 'x', probe: live, pollMs: 20, say: (l) => said.push(l), legacyDir: null })
    expect(held.holder.pid).toBe(process.pid)
    expect(said.filter((l) => l.includes('held by pid 1'))).toHaveLength(1)
    held.release()
  })
  it('takes over from a holder that is gone, with a line saying so, and can be stopped while it waits', async () => {
    write(holder(1, 1 * HOUR))
    const said: string[] = []
    const held = await acquireLock({ file, command: 'x', probe: { alive: (pid) => pid === process.pid, startOf: () => 5 * HOUR }, pollMs: 20, say: (l) => said.push(l), legacyDir: null })
    expect(said).toEqual([expect.stringContaining('pid 1')])
    expect(said[0]).toContain('is gone; taking the lock over')
    // Held by a live process: the wait ends when it is stopped
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 100)
    await expect(acquireLock({ file, command: 'y', probe: { alive: () => true, startOf: () => 5 * HOUR }, pollMs: 20, say: () => {}, signal: stop.signal, legacyDir: null })).rejects.toThrow('stopped while waiting')
    held.release()
  })
})

describe('who takes it', () => {
  it('is each of the four commands, and no document tells anyone to wrap them in a shell line any more', () => {
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    for (const name of ['e2e', 'ux', 'perf', 'perf:memory']) expect(scripts[name], name).toContain('tooling/with-e2e-lock.ts')
    // The command Playwright runs is still the one each script named
    expect(scripts.e2e).toContain('playwright test --config e2e/playwright.config.ts')
    expect(scripts.ux).toContain('playwright test --config e2e/ux/playwright.config.ts')
    expect(scripts.perf).toContain('playwright test perf- --config e2e/playwright.config.ts --workers=1')
    expect(scripts['perf:memory']).toContain('node --import tsx e2e/perf-memory.mts')
    for (const doc of ['AGENTS.md', 'CONTRIBUTING.md', 'docs/ux-metrics.md', 'e2e/perf-memory.mts', 'docs/spikes/2026-10-memory-heavy-store.md']) expect(readFileSync(join(ROOT, doc), 'utf8'), doc).not.toMatch(/until mkdir|rmdir \/tmp\/centralu-e2e/)
  })
  it('is explained where every session reads it: the runners’ own lock, WSL against native Windows, and the one direction the old folder protects', () => {
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
    expect(agents).toMatch(/WSL/)
    expect(agents).toMatch(/native Windows/)
    const contributing = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8')
    expect(contributing).toMatch(/WSL/)
    expect(contributing).toMatch(/old[^.]*centralu-e2e\.lock[^.]*(one direction|does not stop)/)
  })
})

describe('the runners (real processes)', () => {
  const started: ChildProcess[] = []
  const pids: number[] = []
  afterEach(() => {
    for (const c of started.splice(0)) c.kill()
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid)
      } catch {
        // gone
      }
    }
  })

  /** `tooling/with-e2e-lock.ts node -e <script>` on this lock file, with this environment added */
  function runner(script: string, env: Record<string, string> = {}) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tooling/with-e2e-lock.ts', 'node', '-e', script], {
      cwd: ROOT,
      env: { ...process.env, E2E_LOCK_FILE: file, E2E_LEGACY_LOCK_DIR: legacy, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    started.push(child)
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.stdout.on('data', () => {})
    const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })))
    const done = result.then((r) => r.code)
    // A killed runner's child keeps its pipes open, so `close` waits for it; `exit` does not
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    return { child, done, result, exited, stderr: () => err }
  }
  const logLine = (id: string, what: string) => `require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'log.txt'))}, '${id} ${what}\\n')`
  const win = process.platform === 'win32'

  it(
    'lets two runs started together go one after the other, and the second says who it waits for',
    async () => {
      const run = (id: string) => runner(`${logLine(id, 'start')}; setTimeout(() => { ${logLine(id, 'end')} }, 1500)`)
      const a = run('a')
      const b = run('b')
      expect(await Promise.all([a.done, b.done])).toEqual([0, 0])
      const log = readFileSync(join(dir, 'log.txt'), 'utf8').trim().split('\n')
      // Never interleaved: each run ends before the other starts
      expect(log).toHaveLength(4)
      expect(log[0]?.split(' ')[0]).toBe(log[1]?.split(' ')[0])
      expect(log[2]?.split(' ')[0]).toBe(log[3]?.split(' ')[0])
      expect(log.map((l) => l.split(' ')[1])).toEqual(['start', 'end', 'start', 'end'])
      const waiter = log[0]?.startsWith('a') ? b : a
      const first = log[0]?.startsWith('a') ? a : b
      expect(waiter.stderr()).toMatch(/waiting for the e2e lock: held by pid \d+/)
      expect(waiter.stderr()).toContain(`pid ${first.child.pid}`)
      expect(lockFiles()).toEqual([])
      expect(existsSync(legacy)).toBe(false)
    },
    90_000 * SLOW,
  )

  it(
    'lets six runs started over one stale lock go one after the other, and exactly one of them takes it over',
    async () => {
      // A lock whose holder is a process that has ended
      const dead = spawnSync(process.execPath, ['-e', '0']).pid
      write(holder(dead, 123 * HOUR, { at: 5_000, command: 'a run that was killed' }))
      const run = (id: string) => runner(`${logLine(id, 'start')}; setTimeout(() => { ${logLine(id, 'end')} }, 600)`)
      const runs = ['a', 'b', 'c', 'd', 'e', 'f'].map(run)
      expect(await Promise.all(runs.map((r) => r.done))).toEqual([0, 0, 0, 0, 0, 0])
      const log = readFileSync(join(dir, 'log.txt'), 'utf8').trim().split('\n')
      // Each run ended before the next one started
      expect(log.map((l) => l.split(' ')[1])).toEqual(['start', 'end', 'start', 'end', 'start', 'end', 'start', 'end', 'start', 'end', 'start', 'end'])
      for (let i = 0; i < log.length; i += 2) expect(log[i]?.split(' ')[0]).toBe(log[i + 1]?.split(' ')[0])
      // One taken over the dead holder's lock; the others waited for a live one
      expect(runs.filter((r) => r.stderr().includes(`the holder, pid ${dead}`))).toHaveLength(1)
      expect(lockFiles()).toEqual([])
    },
    120_000 * SLOW,
  )

  it(
    'does not take a live lock over because the second run has another time zone and locale',
    async () => {
      const run = (id: string, env: Record<string, string>) => runner(`${logLine(id, 'start')}; setTimeout(() => { ${logLine(id, 'end')} }, 2500)`, env)
      // The holder is in one zone and locale, and the runs that wait are in others: the writer of the lock and the reader differ
      const a = run('a', { TZ: 'Pacific/Auckland', LC_ALL: 'ko_KR.UTF-8', LANG: 'ko_KR.UTF-8' })
      await eventually(() => lockFiles().length > 0 || undefined, 60_000)
      const b = run('b', { TZ: 'UTC', LC_ALL: 'C', LANG: 'C' })
      const c = run('c', { TZ: 'America/Los_Angeles', LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' })
      expect(await Promise.all([a.done, b.done, c.done])).toEqual([0, 0, 0])
      const log = readFileSync(join(dir, 'log.txt'), 'utf8').trim().split('\n')
      // Three runs, one after another: nobody ran alongside a live holder
      expect(log.map((l) => l.split(' ')[1])).toEqual(['start', 'end', 'start', 'end', 'start', 'end'])
      for (let i = 0; i < log.length; i += 2) expect(log[i]?.split(' ')[0]).toBe(log[i + 1]?.split(' ')[0])
      for (const r of [a, b, c]) expect(r.stderr()).not.toContain('taking the lock over')
    },
    120_000 * SLOW,
  )

  it(
    'takes the lock over from a run that was killed with its child, and not while its child still runs',
    async () => {
      const long = runner('setInterval(() => {}, 1000)')
      const seen = await eventually(() => {
        const h = top()
        return h !== null && h !== 'unreadable' && h.child?.started != null ? h : undefined
      }, 60_000)
      if (!seen) throw new Error('the runner wrote no holder')
      const held = seen
      expect(held.pid).toBe(long.child.pid)
      expect(existsSync(legacy)).toBe(true)
      const childPid = held.child?.pid ?? 0
      pids.push(childPid)
      // The runner is killed
      process.kill(held.pid, 'SIGKILL')
      await long.exited
      if (win) {
        // Node on Windows puts the processes it starts in a job that ends with it: nothing runs on, and the lock is free
        await eventually(() => !isAlive(childPid) || undefined, 30_000)
      } else {
        // On POSIX the child runs on, and the lock is still held until it is gone too
        const whileChildRuns = tryAcquire(file, describeSelf('probe'))
        expect(whileChildRuns.ok).toBe(false)
        process.kill(childPid, 'SIGKILL')
        await eventually(() => !isAlive(childPid) || undefined, 30_000)
      }
      // The killed run left the old lock folder behind; a run that starts now takes the lock over, hands the folder on and removes it
      expect(existsSync(legacy)).toBe(true)
      const next = runner(logLine('next', 'ran'))
      expect(await next.done).toBe(0)
      expect(next.stderr()).toContain(`the holder, pid ${held.pid}`)
      expect(next.stderr()).toContain('is gone; taking the lock over')
      expect(readFileSync(join(dir, 'log.txt'), 'utf8')).toBe('next ran\n')
      expect(lockFiles()).toEqual([])
      expect(existsSync(legacy)).toBe(false)
    },
    120_000 * SLOW,
  )

  it(
    'keeps the lock held when the runner is killed between starting its command and learning when it started',
    async () => {
      // A runner whose question about the start time is never answered: what is in the lock is what the first record said
      const script = `
        import { spawn } from 'node:child_process'
        import { acquireLock, trackChild } from './tooling/e2e-lock.ts'
        const held = await acquireLock({ command: 'driver', legacyDir: null })
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        void trackChild(held, child.pid, { ask: () => new Promise(() => {}) })
        console.log('child ' + child.pid)
        setInterval(() => {}, 1000)
      `
      const driver = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: ROOT, env: { ...process.env, E2E_LOCK_FILE: file }, stdio: ['ignore', 'pipe', 'inherit'] })
      started.push(driver)
      let out = ''
      driver.stdout.on('data', (d: Buffer) => (out += d.toString()))
      const exited = new Promise<void>((resolve) => driver.on('exit', () => resolve()))
      const childPid = Number(await eventually(() => /child (\d+)/.exec(out)?.[1], 60_000))
      pids.push(childPid)
      // Named, with no start time
      expect(top()).toMatchObject({ pid: driver.pid, child: { pid: childPid, started: null } })
      process.kill(driver.pid ?? 0, 'SIGKILL')
      await exited
      if (win) {
        // The job object ended the child with the driver
        await eventually(() => !isAlive(childPid) || undefined, 30_000)
        taken(tryAcquire(file, describeSelf('probe'))).release()
      } else {
        // The command is still running: the next run waits for it, and takes the lock when it is gone
        const wait = tryAcquire(file, describeSelf('probe'))
        expect(wait).toMatchObject({ ok: false, holder: { pid: driver.pid, child: { pid: childPid } } })
        process.kill(childPid, 'SIGKILL')
        await eventually(() => !isAlive(childPid) || undefined, 30_000)
        taken(tryAcquire(file, describeSelf('probe'))).release()
      }
      expect(lockFiles()).toEqual([])
    },
    120_000 * SLOW,
  )

  it(
    'makes the old lock folder while it runs, and leaves one it did not make',
    async () => {
      const long = runner(`require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'up'))}, ''); setTimeout(() => {}, 1500)`)
      await eventually(() => existsSync(join(dir, 'up')) || undefined, 60_000)
      expect(existsSync(legacy)).toBe(true)
      expect(await long.done).toBe(0)
      expect(existsSync(legacy)).toBe(false)
      // An old shell line holds it: the run does not wait for it, and does not remove it
      mkdirSync(legacy)
      const r = runner(logLine('r', 'ran'))
      expect(await r.done).toBe(0)
      expect(readFileSync(join(dir, 'log.txt'), 'utf8')).toBe('r ran\n')
      expect(existsSync(legacy)).toBe(true)
    },
    90_000 * SLOW,
  )

  it(
    'hands back the command’s exit code, and 128 plus the signal for a command a signal ended',
    async () => {
      const r = runner('process.exit(7)')
      expect(await r.done).toBe(7)
      expect(lockFiles()).toEqual([])
      // A command that kills itself with SIGKILL: 137 where there are signals; Windows ends the process with exit code 1
      const killed = runner("process.kill(process.pid, 'SIGKILL'); setInterval(() => {}, 1000)")
      expect(await killed.done).toBe(win ? 1 : 137)
      expect(lockFiles()).toEqual([])
    },
    90_000 * SLOW,
  )

  it(
    'ends with 143 on a SIGTERM while it waits (Windows has no signal: the process is ended outright), and gives nothing back that it did not hold',
    async () => {
      const holderRun = runner('setInterval(() => {}, 1000)')
      await eventually(() => lockFiles().length > 0 || undefined, 60_000)
      const waiting = runner('process.exit(0)')
      await eventually(() => waiting.stderr().includes('held by pid') || undefined, 60_000)
      process.kill(waiting.child.pid ?? 0, 'SIGTERM')
      expect(await waiting.result).toEqual(win ? { code: 1, signal: null } : { code: 143, signal: null })
      // The holder still holds it
      expect(top()).toMatchObject({ pid: holderRun.child.pid })
      holderRun.child.kill()
    },
    120_000 * SLOW,
  )

  it(
    'passes a SIGTERM that reaches it while the command runs on to the command, ends with 143, and gives the lock back',
    async () => {
      const running = runner('setInterval(() => {}, 1000)')
      await eventually(() => {
        const h = top()
        return h !== null && h !== 'unreadable' && h.child ? true : undefined
      }, 60_000)
      process.kill(running.child.pid ?? 0, 'SIGTERM')
      // Windows has no signal: the runner is ended outright, and its job object ends the command
      expect(await running.result).toEqual(win ? { code: 1, signal: null } : { code: 143, signal: null })
      if (!win) {
        expect(lockFiles()).toEqual([])
        expect(existsSync(legacy)).toBe(false)
      }
    },
    120_000 * SLOW,
  )
})
