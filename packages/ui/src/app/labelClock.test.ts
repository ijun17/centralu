import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAgo } from '@cc/core'
import { DAY, HOUR, LabelClock, MINUTE, nextAgeTick, nextWaitingTick, nextResetTick, watchLabelVisibility } from './labelClock.js'
import { formatElapsed, nextElapsedTick } from '../features/session/elapsed.js'
import { formatWaiting } from '../components/primitives.jsx'

let clock: LabelClock
const remove: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  clock = new LabelClock()
  clock.setVisible(true)
})
afterEach(() => {
  remove.splice(0).forEach((unsubscribe) => unsubscribe())
  vi.useRealTimers()
})

describe('shared label clock (#615)', () => {
  it('advances a mounted response label across the reported 3h 28m wait', () => {
    const since = -(3 * HOUR + 28 * MINUTE)
    let label = ''
    remove.push(clock.subscribe((now) => nextElapsedTick(since, now), (now) => {
      label = `Waiting for response ${formatElapsed(Math.floor((now - since) / 1000))}`
    }))
    expect(label).toBe('Waiting for response 3h 28m')
    vi.advanceTimersByTime(MINUTE + 5)
    expect(label).toBe('Waiting for response 3h 29m')
  })

  it('advances last-active and approval ages together using one timer', () => {
    let last = ''
    let approval = ''
    const since = -3 * MINUTE
    const next = (now: number) => nextAgeTick(since, now)
    remove.push(clock.subscribe(next, (now) => { last = formatAgo(since, now) }))
    remove.push(clock.subscribe(next, (now) => { approval = formatWaiting(now - since) }))
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(MINUTE + 5)
    expect(last).toBe('4m ago')
    expect(approval).toBe('4m')
    expect(vi.getTimerCount()).toBe(1)
  })

  it('has no timer with no labels, after the last unmount, or with only static labels', () => {
    expect(vi.getTimerCount()).toBe(0)
    const unsubscribe = clock.subscribe((now) => nextAgeTick(0, now), vi.fn())
    expect(vi.getTimerCount()).toBe(1)
    unsubscribe()
    expect(vi.getTimerCount()).toBe(0)
    remove.push(clock.subscribe(() => null, vi.fn()))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does no work while hidden and catches up immediately on return', () => {
    const tick = vi.fn()
    remove.push(clock.subscribe((now) => nextAgeTick(0, now), tick))
    clock.setVisible(false)
    expect(vi.getTimerCount()).toBe(0)
    tick.mockClear()
    vi.advanceTimersByTime(3 * HOUR)
    expect(tick).not.toHaveBeenCalled()
    clock.setVisible(true)
    expect(tick).toHaveBeenCalledExactlyOnceWith(3 * HOUR)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('stops while the document is hidden, including labels mounted while hidden, and removes its listener', () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' as DocumentVisibilityState })
    const disconnect = watchLabelVisibility(clock, doc)
    const tick = vi.fn()
    remove.push(clock.subscribe((now) => nextAgeTick(0, now), tick))
    expect(vi.getTimerCount()).toBe(0)
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(1)
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
    tick.mockClear()
    vi.advanceTimersByTime(2 * MINUTE)
    expect(tick).not.toHaveBeenCalled()
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(tick).toHaveBeenCalledExactlyOnceWith(2 * MINUTE)
    disconnect()
    expect(vi.getTimerCount()).toBe(0)
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('continues ticking while the document stays visible', () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
    const disconnect = watchLabelVisibility(clock, doc)
    remove.push(disconnect)
    let label = ''
    remove.push(clock.subscribe((now) => nextAgeTick(-3 * MINUTE, now), (now) => { label = formatAgo(-3 * MINUTE, now) }))
    vi.advanceTimersByTime(MINUTE + 5)
    expect(label).toBe('4m ago')
  })

  it.each([
    ['last active', -30_000, nextAgeTick, (elapsed: number) => formatAgo(0, elapsed), 'just now', '1m ago'],
    ['hour age', -(2 * HOUR - 30_000), nextAgeTick, (elapsed: number) => formatAgo(0, elapsed), '1h ago', '2h ago'],
    ['response', -(10 * MINUTE + 30_000), nextElapsedTick, (elapsed: number) => formatElapsed(elapsed / 1000), '10m', '11m'],
    ['approval', -(3 * MINUTE + 30_000), nextWaitingTick, formatWaiting, '3m', '4m'],
    ['day response', -(DAY + HOUR - 30_000), nextElapsedTick, (elapsed: number) => formatElapsed(elapsed / 1000), '1d 0h', '1d 1h'],
    ['day approval', -(DAY + HOUR - 30_000), nextWaitingTick, formatWaiting, '1d 0h', '1d 1h'],
  ] as const)('advances an unaligned %s at its own timestamp boundary', (_name, since, next, format, before, after) => {
    let label = ''
    remove.push(clock.subscribe((now) => next(since, now), (now) => { label = format(now - since) }))
    expect(label).toBe(before)
    vi.advanceTimersByTime(30_004)
    expect(label).toBe(before)
    vi.advanceTimersByTime(1)
    expect(label).toBe(after)
  })

  it.each([3 * MINUTE + 30_000, DAY + HOUR + 30_000])('updates an unaligned reset countdown at its remaining-time boundary (%i)', (at) => {
    const step = at > DAY ? HOUR : MINUTE
    let count = -1
    remove.push(clock.subscribe((now) => nextResetTick(at, now), (now) => { count = Math.floor((at - now) / step) }))
    const before = count
    vi.advanceTimersByTime(30_004)
    expect(count).toBe(before)
    vi.advanceTimersByTime(1)
    expect(count).toBe(before - 1)
  })

  it('drops an exact-boundary countdown promptly and stops at the reset time', () => {
    let count = -1
    remove.push(clock.subscribe((now) => nextResetTick(MINUTE, now), (now) => { count = Math.floor((MINUTE - now) / MINUTE) }))
    expect(count).toBe(1)
    vi.advanceTimersByTime(6)
    expect(count).toBe(0)
    vi.advanceTimersByTime(MINUTE)
    expect(vi.getTimerCount()).toBe(0)
    expect(nextResetTick(NaN, 0)).toBeNull()
    expect(nextResetTick(0, 0)).toBeNull()
  })

  it('never repaints minute labels at the activity row\'s second cadence', () => {
    const minuteTick = vi.fn()
    remove.push(clock.subscribe((now) => nextAgeTick(0, now), minuteTick))
    remove.push(clock.subscribe(() => 1000, vi.fn()))
    minuteTick.mockClear()
    vi.advanceTimersByTime(59_000)
    expect(minuteTick).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1010)
    expect(minuteTick).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('uses one timer for a thousand differently timestamped ages', () => {
    const tick = vi.fn()
    for (let i = 0; i < 1000; i++) {
      remove.push(clock.subscribe((now) => nextAgeTick(-i * 17, now), tick))
    }
    tick.mockClear()
    vi.advanceTimersByTime(MINUTE + 5)
    expect(tick).toHaveBeenCalledTimes(1000)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('slows waits to hourly at a day and resumes finer steps for short turns', () => {
    vi.setSystemTime(DAY - MINUTE)
    const shown: string[] = []
    remove.push(clock.subscribe((now) => nextElapsedTick(0, now), (now) => {
      shown.push(formatElapsed(Math.floor(now / 1000)))
    }))
    vi.advanceTimersByTime(MINUTE + 5)
    expect(shown.at(-1)).toBe('1d 0h')
    const count = shown.length
    vi.advanceTimersByTime(HOUR - 1)
    expect(shown).toHaveLength(count)
    vi.advanceTimersByTime(1)
    expect(shown.at(-1)).toBe('1d 1h')
  })

  it('uses only minute steps for an offscreen short turn', () => {
    const tick = vi.fn()
    remove.push(clock.subscribe((now) => nextElapsedTick(0, now, true), tick))
    tick.mockClear()
    vi.advanceTimersByTime(MINUTE - 1)
    expect(tick).not.toHaveBeenCalled()
    vi.advanceTimersByTime(6)
    expect(tick).toHaveBeenCalledExactlyOnceWith(MINUTE + 5)
  })

  it('keeps the measured short-turn cadence and pauses it while hidden', () => {
    const shown: string[] = []
    remove.push(clock.subscribe((now) => nextElapsedTick(0, now), (now) => {
      shown.push(formatElapsed(Math.floor(now / 1000)))
    }))
    vi.advanceTimersByTime(15 * MINUTE)
    expect(shown.slice(0, 4)).toEqual(['0s', '1s', '2s', '3s'])
    expect(shown.slice(-6)).toEqual(['9m 50s', '10m', '11m', '12m', '13m', '14m'])
    expect(new Set(shown).size).toBe(shown.length)
    clock.setVisible(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('time label boundaries', () => {
  it('sweeps minute, hour and day transitions without negative delays', () => {
    for (const boundary of [0, MINUTE, HOUR, DAY, 30 * DAY]) {
      for (let offset = -100; offset <= 100; offset++) {
        const now = boundary + offset
        expect(nextAgeTick(0, now)).toBeGreaterThan(0)
        expect(nextAgeTick(0, now)).toBeLessThanOrEqual(now < HOUR ? MINUTE : HOUR)
        expect(nextElapsedTick(0, now)).toBeGreaterThan(0)
      }
    }
    expect(nextAgeTick(0, DAY)).toBe(HOUR)
    expect(formatElapsed(86400)).toBe('1d 0h')
    expect(formatWaiting(DAY + HOUR)).toBe('1d 1h')
    expect(formatAgo(0, MINUTE - 1)).toBe('just now')
    expect(formatAgo(0, MINUTE)).toBe('1m ago')
    expect(formatAgo(0, HOUR)).toBe('1h ago')
    expect(formatAgo(0, DAY)).toBe('1d ago')
    expect(formatAgo(0, 30 * DAY)).toBe('1mo ago')
  })
})
