import { describe, expect, it } from 'vitest'
import { raceBound } from './with-timeout.js'

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
