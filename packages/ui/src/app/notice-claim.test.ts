import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAIM_BOUND_MS, firstToRaise } from './notice-claim.js'

/**
 * The claim that one window of the machine raises a notification (#2168). Which window wins is checked with two pages
 * in e2e/notifications-windows.spec.ts; here, what a window does when IndexedDB cannot tell it.
 */
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('firstToRaise', () => {
  it('raises when there is no IndexedDB to claim in', async () => {
    vi.stubGlobal('indexedDB', undefined)
    expect(await firstToRaise('mail:m1')).toBe(true)
  })

  it('raises after its bound when IndexedDB never answers, rather than silencing every window', async () => {
    vi.useFakeTimers()
    // An open whose request never succeeds nor fails: a hung database
    const opened: string[] = []
    vi.stubGlobal('indexedDB', { open: (name: string) => (opened.push(name), {}) })
    let answer: boolean | undefined
    void firstToRaise('mail:m1').then((a) => (answer = a))
    await vi.advanceTimersByTimeAsync(CLAIM_BOUND_MS - 1)
    expect(opened).toEqual(['centralu-notices'])
    expect(answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toBe(true)
  })
})
