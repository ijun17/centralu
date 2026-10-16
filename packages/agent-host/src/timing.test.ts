import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { durationText, raceBound, raceTimeout, waitForEvent, waitForExit, withTimeout } from './timing.js'

/** Each bounded wait clears its timer however the race ends (#428): a finished wait held one for the whole bound */
afterEach(() => {
  vi.useRealTimers()
})

describe('withTimeout', () => {
  it('answers the value and leaves no timer behind', async () => {
    vi.useFakeTimers()
    await expect(withTimeout(Promise.resolve(7), 60_000)).resolves.toBe(7)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects with the stage named and the bound said', async () => {
    vi.useFakeTimers()
    const p = withTimeout(new Promise(() => {}), 150, 'Starting claude')
    vi.advanceTimersByTime(150)
    await expect(p).rejects.toThrow('Starting claude did not finish within 150ms')
    expect(durationText(150_000)).toBe('150s')
  })
})

describe('raceTimeout', () => {
  it('answers the value, or the fallback once the bound has passed, and leaves no timer behind', async () => {
    vi.useFakeTimers()
    await expect(raceTimeout(Promise.resolve('ready'), 3000, 'pending')).resolves.toBe('ready')
    expect(vi.getTimerCount()).toBe(0)
    const late = raceTimeout(new Promise(() => {}), 3000, 'pending')
    vi.advanceTimersByTime(3000)
    await expect(late).resolves.toBe('pending')
  })

  it('passes a rejection on', async () => {
    await expect(raceTimeout(Promise.reject(new Error('boom')), 3000, null)).rejects.toThrow('boom')
  })
})

describe('waitForEvent and waitForExit', () => {
  it('takes its listeners and its timer away whether the event came or not', async () => {
    vi.useFakeTimers()
    const e = new EventEmitter()
    const fired = waitForEvent(e, ['end', 'close'], 1000)
    e.emit('close')
    await expect(fired).resolves.toBe(true)
    expect(e.listenerCount('end') + e.listenerCount('close')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const missed = waitForEvent(e, 'end', 1000)
    vi.advanceTimersByTime(1000)
    await expect(missed).resolves.toBe(false)
    expect(e.listenerCount('end')).toBe(0)
  })

  it('a process ended by a signal has ended, though it has no exit code', async () => {
    const p = Object.assign(new EventEmitter(), { exitCode: null, signalCode: 'SIGTERM' as const })
    await expect(waitForExit(p, 60_000)).resolves.toBe(true)
  })
})

/** The bounded waits of the delegation, child, start-request and handoff calls (#428), on their own */
describe('raceBound', () => {
  const never = new Promise<never>(() => {})

  it('answers the outcome, the bound, or the first wake, and never rejects at the bound', async () => {
    expect(await raceBound(Promise.resolve('done'), 1_000)).toBe('done')
    expect(await raceBound(never, 5)).toBe('bound')
    expect(await raceBound(never, 1_000, undefined, Promise.resolve('asked' as const))).toBe('asked')
  })

  it('a signal aborted before the call answers at once, not at the bound', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const t0 = Date.now()
    expect(await raceBound(never, 60_000, ctl.signal)).toBe('aborted')
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('an abort during the wait answers, and the listener is gone once it settles', async () => {
    const ctl = new AbortController()
    const removed: string[] = []
    const signal = Object.assign(ctl.signal, {})
    const remove = signal.removeEventListener.bind(signal)
    signal.removeEventListener = ((type: string, l: EventListenerOrEventListenerObject) => (removed.push(type), remove(type, l))) as typeof signal.removeEventListener
    const r = raceBound(never, 60_000, signal)
    ctl.abort()
    expect(await r).toBe('aborted')
    expect(removed).toEqual(['abort'])
  })
})
