import { describe, expect, it } from 'vitest'
import { eventually, SLOW } from './test-timing.js'

/* That every limit a test sets for itself is scaled by SLOW is the lint rule `test-limits/scaled-by-slow` (tooling/eslint-test-time-limits.js, #845, #1602). */

describe('eventually', () => {
  it('returns the first truthy value the check gives', async () => {
    let n = 0
    expect(await eventually(() => (++n >= 3 ? { n } : null))).toEqual({ n: 3 })
  })

  it('tries a check that throws again, as one that returns false', async () => {
    let n = 0
    const value = await eventually(() => {
      if (++n < 3) throw new Error('not yet')
      return 'ready'
    })
    expect(value).toBe('ready')
  })

  it('gives up after its limit times SLOW, naming the last value it saw', async () => {
    const t0 = Date.now()
    await expect(eventually(() => '', 50)).rejects.toThrow(`not true within ${50 * SLOW} ms; the last value was ''`)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50 * SLOW)
  })

  it('gives up naming the last error the check threw', async () => {
    await expect(eventually(() => { throw new Error('ENOENT: pids') }, 20)).rejects.toThrow(`still failing after ${20 * SLOW} ms: ENOENT: pids`)
  })
})
