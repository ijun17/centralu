import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElapsedClock, formatElapsed, msUntilNextStep } from './elapsed.js'

/**
 * Elapsed time is a number that answers "did it stop?"
 * If 3 seconds and 3 minutes look the same, showing it is pointless.
 */
describe('formatElapsed', () => {
  it('under 10 seconds, by the second', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(9)).toBe('9s')
  })
  it('under 1 minute, by five seconds', () => {
    expect(formatElapsed(10)).toBe('10s')
    expect(formatElapsed(14)).toBe('10s')
    expect(formatElapsed(37)).toBe('35s')
    expect(formatElapsed(59)).toBe('55s')
  })
  it('up to 10 minutes, in minutes and tens of seconds: it keeps moving, and claims no precision it does not show', () => {
    expect(formatElapsed(60)).toBe('1m 0s')
    expect(formatElapsed(125)).toBe('2m 0s')
    expect(formatElapsed(139)).toBe('2m 10s')
    expect(formatElapsed(599)).toBe('9m 50s')
  })
  it('from 10 minutes, in minutes', () => {
    expect(formatElapsed(600)).toBe('10m')
    expect(formatElapsed(3599)).toBe('59m')
  })
  it('from 1 hour, in hours and minutes', () => {
    expect(formatElapsed(3600)).toBe('1h 0m')
    expect(formatElapsed(7860)).toBe('2h 11m')
  })
})

describe('when the count next changes', () => {
  it('is the next whole step of the turn, not of the wall clock', () => {
    expect(msUntilNextStep(1_000, 1_000)).toBe(1_000)
    expect(msUntilNextStep(1_000, 1_400)).toBe(600)
    expect(msUntilNextStep(0, 12_000)).toBe(3_000)
    expect(msUntilNextStep(0, 65_000)).toBe(5_000)
    expect(msUntilNextStep(0, 600_000)).toBe(60_000)
    expect(msUntilNextStep(0, 59_999)).toBe(1)
  })
  it('out of view, is the next whole minute', () => {
    expect(msUntilNextStep(0, 5_000, true)).toBe(55_000)
  })
})

describe('the clock behind the count (#364)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  /** The shown text after each tick, over `ms` of a turn that began at 0 */
  function run(ms: number, view: { hidden?: boolean; offscreen?: boolean } = {}) {
    const shown: string[] = []
    const clock = new ElapsedClock(() => shown.push(formatElapsed(Math.floor(Date.now() / 1000))))
    clock.update({ startedAt: 0, hidden: view.hidden ?? false, offscreen: view.offscreen ?? false })
    vi.advanceTimersByTime(ms)
    return { shown, clock }
  }

  it('re-reads the time once per change of the shown count: by the second, then by 5 s, by 10 s, by the minute', () => {
    const { shown, clock } = run(15 * 60_000)
    // 9 seconds, 10 fives up to a minute, 54 tens up to 10 minutes, 5 minutes after it
    expect(shown).toHaveLength(9 + 10 + 54 + 5)
    // Every re-read shows something new, and lands on the step it is for
    expect(new Set(shown).size).toBe(shown.length)
    expect(shown.slice(0, 3)).toEqual(['1s', '2s', '3s'])
    expect(shown.slice(8, 11)).toEqual(['9s', '10s', '15s'])
    expect(shown.slice(17, 21)).toEqual(['50s', '55s', '1m 0s', '1m 10s'])
    expect(shown.slice(-6)).toEqual(['9m 50s', '10m', '11m', '12m', '13m', '14m'])
    clock.dispose()
  })

  it('is never more than a step behind while it can be seen', () => {
    const shown: number[] = []
    const clock = new ElapsedClock(() => shown.push(Date.now()))
    clock.update({ startedAt: 0, hidden: false, offscreen: false })
    let lastRead = 0
    for (let t = 0; t < 20 * 60_000; t += 250) {
      vi.advanceTimersByTime(250)
      lastRead = shown.at(-1) ?? 0
      const seconds = Math.floor(Date.now() / 1000)
      const step = seconds < 10 ? 1 : seconds < 60 ? 5 : seconds < 600 ? 10 : 60
      expect(Date.now() - lastRead).toBeLessThanOrEqual(step * 1000 + 5)
    }
    clock.dispose()
  })

  it('does not run while the window is hidden, and shows the current count the moment it is shown', () => {
    const { shown, clock } = run(5 * 60_000, { hidden: true })
    expect(shown).toEqual([])
    clock.update({ startedAt: 0, hidden: false, offscreen: false })
    expect(shown).toEqual(['5m 0s'])
    // The clock reads a few ms past each step
    vi.advanceTimersByTime(10_010)
    expect(shown).toEqual(['5m 0s', '5m 10s'])
    clock.dispose()
  })

  it('moves only by the minute while scrolled out of view, and catches up the moment it is back', () => {
    const { shown, clock } = run(3 * 60_000 + 30_000, { offscreen: true })
    expect(shown).toEqual(['1m 0s', '2m 0s', '3m 0s'])
    clock.update({ startedAt: 0, hidden: false, offscreen: false })
    expect(shown.at(-1)).toBe('3m 30s')
    clock.dispose()
  })

  it('stops when the turn ends and when it is thrown away', () => {
    const { shown, clock } = run(3_010)
    expect(shown).toEqual(['1s', '2s', '3s'])
    clock.update({ startedAt: null, hidden: false, offscreen: false })
    vi.advanceTimersByTime(60_000)
    expect(shown).toHaveLength(3)
    clock.update({ startedAt: 0, hidden: false, offscreen: false })
    clock.dispose()
    vi.advanceTimersByTime(60_000)
    expect(shown).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
  })
})
