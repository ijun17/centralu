import { describe, expect, it } from 'vitest'
import { eventually, SLOW, slowFor } from './test-timing.js'

/* That every limit a test sets for itself is scaled by SLOW is the lint rule `test-limits/scaled-by-slow` (tooling/eslint-test-time-limits.js, #845, #1602). */

describe('SLOW', () => {
  it('is three on Windows and on a CI runner, one on a developer’s own macOS or Linux machine (#368, #2203)', () => {
    expect(slowFor('win32', undefined)).toBe(3)
    expect(slowFor('darwin', 'true')).toBe(3)
    expect(slowFor('linux', '1')).toBe(3)
    expect(slowFor('darwin', undefined)).toBe(1)
    expect(slowFor('linux', '')).toBe(1)
    expect(slowFor('linux', '0')).toBe(1)
    expect(slowFor('linux', 'false')).toBe(1)
  })
})

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
