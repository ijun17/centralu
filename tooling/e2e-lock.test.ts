/**
 * The e2e lock (tooling/e2e-lock.ts, tooling/with-e2e-lock.ts; #1632). It is in the OS layer, so this runs on every OS:
 * the unit cases with the OS's answers replaced, and the real ones (two runners at once, a holder killed) with real
 * processes, which on Windows ask PowerShell for a start time and on POSIX `ps`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireLock,
  holderGone,
  isAlive,
  lockFile,
  processStartTime,
  procGone,
  readHolder,
  startTimeCommand,
  tryAcquire,
  waitingLine,
  type Holder,
  type Probe,
} from './e2e-lock.js'
import { eventually, SLOW } from './test-timing.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-lock-test-'))
  file = join(dir, 'lock.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A probe over a table of live processes: pid → start time */
const probeOf = (live: Record<number, string>): Probe => ({ alive: (pid) => pid in live, startOf: (pid) => live[pid] ?? null })
const holder = (pid: number, started: string | null, extra: Partial<Holder> = {}): Holder => ({ pid, started, at: 1_000, command: 'playwright test', cwd: '/work', ...extra })
const write = (h: unknown) => writeFileSync(file, JSON.stringify(h))

describe('where the lock is and how a start time is asked', () => {
  it('is a file in the temporary folder Node resolves, or the one E2E_LOCK_FILE names', () => {
    expect(lockFile({})).toBe(join(tmpdir(), 'centralu-e2e-lock.json'))
    expect(lockFile({ E2E_LOCK_FILE: '/x/y.json' })).toBe('/x/y.json')
  })
  it('asks PowerShell on Windows, in UTC, and ps in the C locale elsewhere', () => {
    const win = startTimeCommand(4321, 'win32')
    expect(win.file).toBe('powershell.exe')
    expect(win.args.join(' ')).toContain('Get-Process -Id 4321')
    expect(win.args.join(' ')).toContain('ToUniversalTime().ToString(')
    for (const platform of ['linux', 'darwin'] as const) expect(startTimeCommand(4321, platform)).toEqual({ file: 'ps', args: ['-o', 'lstart=', '-p', '4321'] })
    const asked: string[] = []
    expect(processStartTime(7, (f, a) => (asked.push(f, ...a), 'Mon Oct 26 10:00:00 2026'), 'linux')).toBe('Mon Oct 26 10:00:00 2026')
    expect(asked).toEqual(['ps', '-o', 'lstart=', '-p', '7'])
    expect(processStartTime(7, () => null, 'win32')).toBeNull()
  })
  it('reads this OS: the start time of this process is the same each time, and a process that is gone has none', () => {
    const first = processStartTime(process.pid)
    expect(first).not.toBeNull()
    expect(processStartTime(process.pid)).toBe(first)
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(0)).toBe(false)
    expect(isAlive(Number.NaN)).toBe(false)
  }, 30_000 * SLOW)
})

describe('when a holder is gone', () => {
  it('is gone when its process does not exist, or the id now belongs to a process that started at another time', () => {
    const probe = probeOf({ 10: 'Mon 10:00', 11: 'Tue 09:00' })
    expect(procGone({ pid: 10, started: 'Mon 10:00' }, probe)).toBe(false)
    expect(procGone({ pid: 12, started: 'Mon 10:00' }, probe)).toBe(true)
    // The id was reused
    expect(procGone({ pid: 11, started: 'Mon 10:00' }, probe)).toBe(true)
    // A start time that was not known when it was written, or cannot be read now, never makes a live process gone
    expect(procGone({ pid: 10, started: null }, probe)).toBe(false)
    expect(procGone({ pid: 10, started: 'Mon 10:00' }, { alive: () => true, startOf: () => null })).toBe(false)
  })
  it('is held while its runner or the child it started is alive, and gone when both are', () => {
    const probe = probeOf({ 20: 'a' })
    const withChild = (child: number) => holder(10, 'x', { child: { pid: child, started: 'a' } })
    expect(holderGone(holder(10, 'x'), probe)).toBe(true)
    expect(holderGone(withChild(20), probe)).toBe(false)
    expect(holderGone(withChild(21), probe)).toBe(true)
    expect(holderGone(holder(20, 'a'), probe)).toBe(false)
  })
})

describe('taking the lock', () => {
  it('writes who holds it, and a second run is refused while that holder lives', () => {
    const live = probeOf({ 1: 'a', 2: 'b' })
    const first = tryAcquire(file, holder(1, 'a'), live)
    expect(first.ok).toBe(true)
    expect(readHolder(file)).toMatchObject({ pid: 1, started: 'a', command: 'playwright test', cwd: '/work' })
    const second = tryAcquire(file, holder(2, 'b'), live)
    expect(second).toMatchObject({ ok: false, holder: { pid: 1 }, tookOver: [] })
    if (first.ok) first.held.release()
    expect(existsSync(file)).toBe(false)
    expect(tryAcquire(file, holder(2, 'b'), live).ok).toBe(true)
  })
  it('takes over the lock of a holder that is gone, and says whose it was', () => {
    write(holder(1, 'a'))
    const taken = tryAcquire(file, holder(2, 'b'), probeOf({ 2: 'b' }))
    expect(taken.ok).toBe(true)
    expect(taken.tookOver.map((h) => h.pid)).toEqual([1])
    expect(readHolder(file)).toMatchObject({ pid: 2 })
  })
  it('takes it over from a pid that was reused, and not from one that is the same process', () => {
    write(holder(1, 'Mon 10:00'))
    expect(tryAcquire(file, holder(2, 'b'), probeOf({ 1: 'Tue 11:00', 2: 'b' })).ok).toBe(true)
    write(holder(1, 'Mon 10:00'))
    expect(tryAcquire(file, holder(2, 'b'), probeOf({ 1: 'Mon 10:00', 2: 'b' }))).toMatchObject({ ok: false, holder: { pid: 1 } })
  })
  it('does not take it over while the child the runner started is alive, after the runner was killed', () => {
    write(holder(1, 'a', { child: { pid: 3, started: 'c' } }))
    expect(tryAcquire(file, holder(2, 'b'), probeOf({ 2: 'b', 3: 'c' }))).toMatchObject({ ok: false, holder: { pid: 1 } })
    expect(tryAcquire(file, holder(2, 'b'), probeOf({ 2: 'b' })).ok).toBe(true)
  })
  it('has no expiry: a holder from long ago that is alive keeps the lock', () => {
    write(holder(1, 'a', { at: 1 }))
    expect(tryAcquire(file, holder(2, 'b'), probeOf({ 1: 'a', 2: 'b' }))).toMatchObject({ ok: false, holder: { pid: 1, at: 1 } })
  })
  it('leaves a file that names no holder for a person, and says so', () => {
    writeFileSync(file, 'not json')
    const r = tryAcquire(file, holder(2, 'b'), probeOf({ 2: 'b' }))
    expect(r).toMatchObject({ ok: false, holder: 'unreadable' })
    expect(readFileSync(file, 'utf8')).toBe('not json')
    expect(waitingLine('unreadable', file)).toContain('delete it if no run holds it')
  })
  it('gives back only its own lock', () => {
    const live = probeOf({ 1: 'a', 2: 'b' })
    const first = tryAcquire(file, holder(1, 'a'), live)
    // The file now names someone else (this one was taken over after it was thought gone)
    write(holder(2, 'b'))
    if (first.ok) first.held.release()
    expect(readHolder(file)).toMatchObject({ pid: 2 })
  })
  it('records the child the runner started, and keeps the rest', () => {
    const r = tryAcquire(file, holder(1, 'a'), probeOf({ 1: 'a' }))
    if (!r.ok) throw new Error('not taken')
    r.held.setChild({ pid: 9, started: 'z' })
    expect(readHolder(file)).toMatchObject({ pid: 1, command: 'playwright test', child: { pid: 9, started: 'z' } })
    r.held.release()
    expect(existsSync(file)).toBe(false)
  })
  it('puts a live lock back when the one it moved out of the way is not the stale one it judged', () => {
    // The probe calls the first holder gone, and in that moment another run takes the lock over: what is moved is live
    write(holder(1, 'a'))
    const probe: Probe = {
      alive: (pid) => {
        if (pid === 1) {
          write(holder(3, 'c', { at: 2_000 }))
          return false
        }
        return pid === 2 || pid === 3
      },
      startOf: (pid) => ({ 2: 'b', 3: 'c' })[pid] ?? null,
    }
    const r = tryAcquire(file, holder(2, 'b'), probe)
    expect(r).toMatchObject({ ok: false, holder: { pid: 3 } })
    expect(readHolder(file)).toMatchObject({ pid: 3 })
  })
  it('leaves no private files behind', () => {
    write(holder(1, 'a'))
    tryAcquire(file, holder(2, 'b'), probeOf({ 2: 'b' }))
    tryAcquire(file, holder(4, 'd'), probeOf({ 2: 'b', 4: 'd' }))
    expect(readdirSync(dir).sort()).toEqual(['lock.json'])
  })
})

describe('waiting for it', () => {
  it('says who holds it, what it runs, where and since when', () => {
    const line = waitingLine(holder(1234, 'a', { at: Date.parse('2026-10-27T10:00:00'), command: 'playwright test e2e/panel.spec.ts', cwd: '/work/a', child: { pid: 1300, started: 'c' } }), file, Date.parse('2026-10-27T10:05:00'))
    expect(line).toContain('held by pid 1234, running as pid 1300 (playwright test e2e/panel.spec.ts) in /work/a since ')
    expect(line).toContain('(5 min ago)')
  })
  it('waits until the holder gives it back, saying once who holds it', async () => {
    const live = probeOf({ 1: 'a' })
    write(holder(1, 'a'))
    const said: string[] = []
    setTimeout(() => rmSync(file), 150)
    const held = await acquireLock({ file, command: 'x', probe: live, pollMs: 20, say: (l) => said.push(l) })
    expect(held.holder.pid).toBe(process.pid)
    expect(said.filter((l) => l.includes('held by pid 1'))).toHaveLength(1)
    held.release()
  })
  it('takes over from a holder that is gone, with a line saying so, and can be stopped while it waits', async () => {
    write(holder(1, 'a'))
    const said: string[] = []
    const held = await acquireLock({ file, command: 'x', probe: { alive: (pid) => pid === process.pid, startOf: () => 's' }, pollMs: 20, say: (l) => said.push(l) })
    expect(said).toEqual([expect.stringContaining('pid 1')])
    expect(said[0]).toContain('is gone; taking the lock over')
    // Held by a live process: the wait ends when it is stopped
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 100)
    await expect(acquireLock({ file, command: 'y', probe: { alive: () => true, startOf: () => 's' }, pollMs: 20, say: () => {}, signal: stop.signal })).rejects.toThrow('stopped while waiting')
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
    for (const doc of ['AGENTS.md', 'CONTRIBUTING.md', 'docs/ux-metrics.md', 'e2e/perf-memory.mts']) expect(readFileSync(join(ROOT, doc), 'utf8'), doc).not.toMatch(/until mkdir|centralu-e2e.lock/)
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

  /** `tooling/with-e2e-lock.ts node -e <script>` on this lock file */
  function runner(script: string) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tooling/with-e2e-lock.ts', 'node', '-e', script], { cwd: ROOT, env: { ...process.env, E2E_LOCK_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    },
    90_000 * SLOW,
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
      // A run that starts now takes the lock over, and says so
      const next = runner(logLine('next', 'ran'))
      expect(await next.done).toBe(0)
      expect(next.stderr()).toContain(`the holder, pid ${held.pid}`)
      expect(next.stderr()).toContain('is gone; taking the lock over')
      expect(readFileSync(join(dir, 'log.txt'), 'utf8')).toBe('next ran\n')
      expect(existsSync(file)).toBe(false)
    },
    120_000 * SLOW,
  )

  it('hands back the command\'s exit code, and the lock', async () => {
    const r = runner('process.exit(7)')
    expect(await r.done).toBe(7)
    expect(existsSync(file)).toBe(false)
  }, 60_000 * SLOW)
})
