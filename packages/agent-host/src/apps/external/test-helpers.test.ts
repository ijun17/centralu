import { describe, expect, it } from 'vitest'
import { until } from './test-helpers.js'
import { SLOW } from '../../../../../tooling/test-timing.js'

describe('until', () => {
  it('returns the value once the test holds, a falsy one too', async () => {
    let n = 0
    // A process gone is `alive(pid) === false`
    expect(await until(() => ++n < 3, (stillThere) => stillThere === false)).toBe(false)
  })

  it('scales a limit the caller gives by SLOW, and names the last value when it runs out', async () => {
    await expect(until(() => 1, (v) => v === 2, 20)).rejects.toThrow(`still failing after ${20 * SLOW} ms: the last value was 1`)
  })
})
