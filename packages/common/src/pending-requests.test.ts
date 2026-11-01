import { describe, expect, it, vi } from 'vitest'
import { PendingRequests } from './pending-requests.js'

describe('PendingRequests', () => {
  it('settles each request once, by its id, and its timer goes with it', async () => {
    vi.useFakeTimers()
    try {
      const p = new PendingRequests<number>()
      const a = p.wait(1, 1000, 'no answer for 1')
      const b = p.wait('x-2', 1000, 'no answer for 2')
      expect(p.resolve('1', 10)).toBe(true)
      expect(p.resolve(1, 11)).toBe(false)
      await expect(a).resolves.toBe(10)
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(1000)
      await expect(b).rejects.toThrow('no answer for 2')
      expect(p.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects every waiting request at once, with one reason', async () => {
    const p = new PendingRequests()
    const all = [p.wait(1, 60_000, ''), p.wait(2, 60_000, '')]
    p.rejectAll(new Error('the other side is gone'))
    for (const w of all) await expect(w).rejects.toThrow('the other side is gone')
    expect(p.size).toBe(0)
  })
})

describe('PendingRequests timeout error', () => {
  it('rejects with the error a function makes, so a code or retryable survives', async () => {
    vi.useFakeTimers()
    try {
      const p = new PendingRequests()
      const w = p.wait(1, 1000, () => Object.assign(new Error('no answer'), { retryable: true }))
      const seen = w.catch((e: unknown) => e)
      vi.advanceTimersByTime(1000)
      expect(await seen).toMatchObject({ message: 'no answer', retryable: true })
      expect(p.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
