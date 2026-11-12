import { afterEach, describe, expect, it, vi } from 'vitest'
import { RETRY_MS, retryLadder } from './retry.js'

afterEach(() => vi.useRealTimers())

describe('retryLadder', () => {
  it('waits the steps between tries and gives up after the last', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockRejectedValue(new Error('down'))
    const gaveUp = vi.fn()
    const done = retryLadder(read, () => true, undefined, gaveUp)
    await vi.advanceTimersByTimeAsync(RETRY_MS[0] + RETRY_MS[1] + RETRY_MS[2])
    await expect(done).resolves.toBeNull()
    expect(read).toHaveBeenCalledTimes(RETRY_MS.length + 1)
    expect(gaveUp).toHaveBeenCalledOnce()
  })

  it('starts with the wait when the read already failed once, and goes on from the steps it is given', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValue('read')
    const steps = { at: 1 }
    const done = retryLadder(read, () => true, undefined, undefined, { steps, afterFailure: true })
    await vi.advanceTimersByTimeAsync(RETRY_MS[1] - 1)
    expect(read).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(done).resolves.toBe('read')
    expect(steps.at).toBe(2)
  })

  it('takes no step for a failure that lands after it was told to stop', async () => {
    const steps = { at: 0 }
    let go = true
    const done = retryLadder(async () => { go = false; throw new Error('late') }, () => go, undefined, undefined, { steps })
    await expect(done).resolves.toBeNull()
    expect(steps.at).toBe(0)
  })
})
