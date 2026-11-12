import { describe, expect, it, vi } from 'vitest'
import { defaultLimit, eventually, SLOW } from './test-timing.js'

/* That every limit a test sets for itself is scaled by SLOW is the lint rule `test-limits/scaled-by-slow` (tooling/eslint-test-time-limits.js, #845, #1602). */

describe('SLOW and defaultLimit', () => {
  it('scales vitest’s default limit by three on Windows and on a CI runner, and by one on a developer’s own macOS or Linux machine (#368, #2203)', () => {
    expect(defaultLimit(5_000, 'win32', undefined)).toBe(15_000)
    expect(defaultLimit(5_000, 'darwin', 'true')).toBe(15_000)
    expect(defaultLimit(5_000, 'linux', '1')).toBe(15_000)
    expect(defaultLimit(5_000, 'darwin', undefined)).toBe(5_000)
    expect(defaultLimit(5_000, 'linux', '')).toBe(5_000)
    expect(defaultLimit(5_000, 'linux', '0')).toBe(5_000)
    expect(defaultLimit(5_000, 'linux', 'false')).toBe(5_000)
    // SLOW, which also scales the bounds and sleeps a test sets, follows the platform alone: a runner's would stop checking anything (#2203)
    expect(SLOW).toBe(process.platform === 'win32' ? 3 : 1)
  })

  // On Windows the default is scaled whatever CI says, so only another platform can tell the two apart
  it.skipIf(process.platform === 'win32')('is what vitest.config.ts gives a test that sets no limit: 15 s on a runner, 5 s on a developer’s machine', async () => {
    const limitWith = async (ci: string | undefined) => {
      vi.resetModules()
      vi.stubEnv('CI', ci)
      return ((await import('../vitest.config.js')).default as { test: { testTimeout: number } }).test.testTimeout
    }
    expect(await limitWith('1')).toBe(15_000)
    expect(await limitWith(undefined)).toBe(5_000)
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
