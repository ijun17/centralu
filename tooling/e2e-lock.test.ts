/**
 * The e2e lock (tooling/e2e-lock.ts, tooling/with-e2e-lock.ts; #1632). It is in the OS layer, so this runs on every OS:
 * the unit cases with the OS's answers replaced, and the real ones (two runners at once, a holder killed, a run in another
 * time zone and locale) with real processes, which on Windows ask PowerShell for a start time and on POSIX `ps`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireLock,
  cachedProbe,
  describeSelf,
  holderGone,
  isAlive,
  legacyLockDir,
  lockDir,
  lockFile,
  parseLstart,
  processStartTime,
  procGone,
  PS_ENV,
  readHolder,
  startTimeCommand,
  tryAcquire,
  waitingLine,
  type Holder,
  type Probe,
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

/** A probe over a table of live processes: pid → start time */
const probeOf = (live: Record<number, number>): Probe => ({ alive: (pid) => pid in live, startOf: (pid) => live[pid] ?? null })
const holder = (pid: number, started: number | null, extra: Partial<Holder> = {}): Holder => ({ pid, started, at: 1_000, command: 'playwright test', cwd: '/work', ...extra })
const write = (h: unknown) => writeFileSync(file, JSON.stringify(h))

describe('where the lock is and how a start time is asked', () => {
  it('is a fixed /tmp file on POSIX and the temporary folder on Windows, or the file E2E_LOCK_FILE names', () => {
    // $TMPDIR is per user on macOS and unset under ssh and cron: it cannot be where a machine-wide lock is
    expect(lockFile({}, 'darwin')).toBe(join('/tmp', 'centralu-e2e-lock.json'))
    expect(lockFile({ TMPDIR: '/var/folders/x/T/' }, 'darwin')).toBe(join('/tmp', 'centralu-e2e-lock.json'))
    expect(lockFile({ TMPDIR: '/elsewhere' }, 'linux')).toBe(join('/tmp', 'centralu-e2e-lock.json'))
    expect(lockFile({}, 'win32')).toBe(join(tmpdir(), 'centralu-e2e-lock.json'))
    expect(lockDir('linux')).toBe('/tmp')
    expect(lockDir('win32')).toBe(tmpdir())
    expect(lockFile({ E2E_LOCK_FILE: '/x/y.json' })).toBe('/x/y.json')
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
    expect(processStartTime(7, ask('Mon Oct 26 10:00:00 2026'), 'linux')).toBe(Date.UTC(2026, 9, 26, 10, 0, 0))
    expect(asked[0]).toEqual({ file: 'ps', args: ['-o', 'lstart=', '-p', '7'], env: PS_ENV })
    expect(PS_ENV).toEqual({ LC_ALL: 'C', TZ: 'UTC0' })
    // A day below ten is padded with a space
    expect(processStartTime(7, ask('Tue Oct  6 09:05:01 2026'), 'darwin')).toBe(Date.UTC(2026, 9, 6, 9, 5, 1))
    // Windows: the integer PowerShell printed
    expect(processStartTime(7, ask('1793069759858'), 'win32')).toBe(1793069759858)
    expect(processStartTime(7, ask('not a number'), 'win32')).toBeNull()
    expect(processStartTime(7, ask(null), 'win32')).toBeNull()
    expect(processStartTime(7, ask(null), 'linux')).toBeNull()
  })
  it('does not read a time written in another locale’s words, which a pinned ps never prints', () => {
    expect(parseLstart('2026년 9월 27일 일요일 10시 00분 00초')).toBeNull()
    expect(parseLstart('Mon Okt 26 10:00:00 2026')).toBeNull()
    expect(parseLstart('Mon Oct 26 10:00:00 2026')).toBe(Date.UTC(2026, 9, 26, 10, 0, 0))
  })
  it('gives the same start time for this process in any time zone and locale the asker has', () => {
    const keep = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG }
    try {
      const started = processStartTime(process.pid)
      expect(started).not.toBeNull()
      // About when this process started
      expect(Math.abs((started ?? 0) - (Date.now() - process.uptime() * 1000))).toBeLessThan(120_000)
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
        expect(Math.abs((other ?? 0) - (started ?? 0)), `${tz} ${locale}`).toBeLessThanOrEqual(2000)
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
    expect(readHolder(file)).toMatchObject({ pid: 1, started: 1 * HOUR, command: 'playwright test', cwd: '/work' })
    const second = tryAcquire(file, holder(2, 2 * HOUR), live)
    expect(second).toMatchObject({ ok: false, holder: { pid: 1 }, tookOver: [] })
    if (first.ok) first.held.release()
    expect(existsSync(file)).toBe(false)
    expect(tryAcquire(file, holder(2, 2 * HOUR), live).ok).toBe(true)
  })
  it('takes over the lock of a holder that is gone, and says whose it was', () => {
    write(holder(1, 1 * HOUR))
    const taken = tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 2: 2 * HOUR }))
    expect(taken.ok).toBe(true)
    expect(taken.tookOver.map((h) => h.pid)).toEqual([1])
    expect(readHolder(file)).toMatchObject({ pid: 2 })
  })
  it('takes it over from a pid that was reused, and not from one that is the same process', () => {
    write(holder(1, 10 * HOUR))
    expect(tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 1: 11 * HOUR, 2: 2 * HOUR })).ok).toBe(true)
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
    writeFileSync(file, 'not json')
    const r = tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 2: 2 * HOUR }))
    expect(r).toMatchObject({ ok: false, holder: 'unreadable' })
    expect(readFileSync(file, 'utf8')).toBe('not json')
    expect(waitingLine('unreadable', file)).toContain('delete it if no run holds it')
    // A start time in the old text form names no time: the holder is read, and is held while its process lives
    write({ pid: 1, started: 'Mon Oct 26 10:00:00 2026', at: 1, command: 'x', cwd: '/' })
    expect(tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 1: 1 * HOUR, 2: 2 * HOUR }))).toMatchObject({ ok: false, holder: { pid: 1, started: null } })
  })
  it('gives back only its own lock', () => {
    const live = probeOf({ 1: 1 * HOUR, 2: 2 * HOUR })
    const first = tryAcquire(file, holder(1, 1 * HOUR), live)
    // The file now names someone else (this one was taken over after it was thought gone)
    write(holder(2, 2 * HOUR))
    if (first.ok) first.held.release()
    expect(readHolder(file)).toMatchObject({ pid: 2 })
  })
  it('records the child the runner started, first without its start time and then with it, and keeps the rest', () => {
    const r = tryAcquire(file, holder(1, 1 * HOUR), probeOf({ 1: 1 * HOUR }))
    if (!r.ok) throw new Error('not taken')
    r.held.setChild({ pid: 9, started: null })
    expect(readHolder(file)).toMatchObject({ pid: 1, command: 'playwright test', child: { pid: 9, started: null } })
    r.held.setChild({ pid: 9, started: 9 * HOUR })
    expect(readHolder(file)).toMatchObject({ pid: 1, child: { pid: 9, started: 9 * HOUR } })
    r.held.release()
    expect(existsSync(file)).toBe(false)
  })
  it('puts a live lock back when the one it moved out of the way is not the stale one it judged', () => {
    // The probe calls the first holder gone, and in that moment another run takes the lock over: what is moved is live
    write(holder(1, 1 * HOUR))
    const probe: Probe = {
      alive: (pid) => {
        if (pid === 1) {
          write(holder(3, 3 * HOUR, { at: 2_000 }))
          return false
        }
        return pid === 2 || pid === 3
      },
      startOf: (pid) => ({ 2: 2 * HOUR, 3: 3 * HOUR })[pid] ?? null,
    }
    const r = tryAcquire(file, holder(2, 2 * HOUR), probe)
    expect(r).toMatchObject({ ok: false, holder: { pid: 3 } })
    expect(readHolder(file)).toMatchObject({ pid: 3 })
  })
  it('leaves no private files behind', () => {
    write(holder(1, 1 * HOUR))
    tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 2: 2 * HOUR }))
    tryAcquire(file, holder(4, 4 * HOUR), probeOf({ 2: 2 * HOUR, 4: 4 * HOUR }))
    expect(readdirSync(dir).sort()).toEqual(['lock.json'])
  })
})

describe('the old lock folder (a branch from before the runners took the lock)', () => {
  const live = probeOf({ 1: 1 * HOUR, 2: 2 * HOUR })
  it('is made while the lock is held and removed when it is given back', () => {
    const r = tryAcquire(file, holder(1, 1 * HOUR), live, legacy)
    expect(r.ok).toBe(true)
    expect(existsSync(legacy)).toBe(true)
    expect(readHolder(file)).toMatchObject({ pid: 1, legacy: true })
    if (r.ok) r.held.release()
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(file)).toBe(false)
  })
  it('is never waited for, and never removed when something else made it', () => {
    // An old shell line holds the folder around a run that holds the lock itself: waiting for it would be a deadlock
    mkdirSync(legacy)
    const r = tryAcquire(file, holder(1, 1 * HOUR), live, legacy)
    expect(r.ok).toBe(true)
    expect(readHolder(file)).not.toMatchObject({ legacy: true })
    if (r.ok) r.held.release()
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(file)).toBe(false)
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
    expect(readHolder(file)).toMatchObject({ pid: 2, legacy: true })
    if (r.ok) r.held.release()
    expect(existsSync(legacy)).toBe(false)
    // The killed holder had not made it: the folder is not ours to remove
    mkdirSync(legacy)
    write(holder(1, 1 * HOUR))
    const other = tryAcquire(file, holder(2, 2 * HOUR), probeOf({ 2: 2 * HOUR }), legacy)
    if (other.ok) other.held.release()
    expect(existsSync(legacy)).toBe(true)
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
    setTimeout(() => rmSync(file), 150)
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
    const done = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    // A killed runner's child keeps its pipes open, so `close` waits for it; `exit` does not
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    return { child, done, exited, stderr: () => err }
  }
  const logLine = (id: string, what: string) => `require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'log.txt'))}, '${id} ${what}\\n')`

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
      expect(existsSync(file)).toBe(false)
      expect(existsSync(legacy)).toBe(false)
    },
    90_000 * SLOW,
  )

  it(
    'does not take a live lock over because the second run has another time zone and locale',
    async () => {
      const run = (id: string, env: Record<string, string>) => runner(`${logLine(id, 'start')}; setTimeout(() => { ${logLine(id, 'end')} }, 2500)`, env)
      // The holder is in one zone and locale, and the runs that wait are in others: the writer of the lock and the reader differ
      const a = run('a', { TZ: 'Pacific/Auckland', LC_ALL: 'ko_KR.UTF-8', LANG: 'ko_KR.UTF-8' })
      await eventually(() => existsSync(file) || undefined, 60_000)
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
        const h = readHolder(file)
        return h !== null && h !== 'unreadable' && h.child ? h : undefined
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
      if (process.platform === 'win32') {
        // Node on Windows puts the processes it starts in a job that ends with it: nothing runs on, and the lock is free
        await eventually(() => !isAlive(childPid) || undefined, 30_000)
      } else {
        // On POSIX the child runs on, and the lock is still held until it is gone too
        const whileChildRuns = tryAcquire(file, { pid: process.pid, started: processStartTime(process.pid), at: Date.now(), command: 'probe', cwd: ROOT })
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
      expect(existsSync(file)).toBe(false)
      expect(existsSync(legacy)).toBe(false)
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
      expect(existsSync(file)).toBe(false)
      // A command that kills itself with SIGKILL: 137 where signals exist (Windows reports an exit code for it)
      const killed = runner("process.kill(process.pid, 'SIGKILL'); setInterval(() => {}, 1000)")
      const code = await killed.done
      if (process.platform === 'win32') expect(code).not.toBe(0)
      else expect(code).toBe(137)
      expect(existsSync(file)).toBe(false)
    },
    90_000 * SLOW,
  )

  it(
    'ends with 143 on a SIGTERM while it waits, and gives nothing back that it did not hold',
    async () => {
      const holderRun = runner('setInterval(() => {}, 1000)')
      await eventually(() => existsSync(file) || undefined, 60_000)
      const waiting = runner('process.exit(0)')
      await eventually(() => waiting.stderr().includes('held by pid') || undefined, 60_000)
      process.kill(waiting.child.pid ?? 0, 'SIGTERM')
      const code = await waiting.done
      if (process.platform === 'win32') expect(code).not.toBe(0)
      else expect(code).toBe(143)
      // The holder still holds it
      expect(readHolder(file)).toMatchObject({ pid: holderRun.child.pid })
      holderRun.child.kill()
    },
    120_000 * SLOW,
  )
})
