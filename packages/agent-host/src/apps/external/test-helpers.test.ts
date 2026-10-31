import { afterEach, describe, expect, it, vi } from 'vitest'
import { until } from './test-helpers.js'
import { SLOW } from '../../../../../tooling/test-timing.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('until', () => {
  it('returns the value once the test holds, a falsy one too', async () => {
    let n = 0
    // A process gone is `alive(pid) === false`
    expect(await until(() => ++n < 3, (stillThere) => stillThere === false)).toBe(false)
  })

  it('scales a limit the caller gives by SLOW, and names the last value when it runs out', async () => {
    await expect(until(() => 1, (v) => v === 2, 20)).rejects.toThrow(`still failing after ${20 * SLOW} ms: the last value was 1`)
  })

  it('without a limit, waits out a process start that takes a loaded machine 5 s, and still gives up on a hang', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const started = until(() => Date.now() - t0 >= 5_000 * SLOW, (up) => up)
    await vi.advanceTimersByTimeAsync(5_100 * SLOW)
    await expect(started).resolves.toBe(true)

    const hung = until(() => 'stopped', (s) => s === 'running')
    const failed = expect(hung).rejects.toThrow(/still failing after \d+ ms: the last value was 'stopped'/)
    await vi.advanceTimersByTimeAsync(30_000 * SLOW)
    await failed
  })
})
