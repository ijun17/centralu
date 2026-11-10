import { describe, expect, it } from 'vitest'
import { HELD_WAITS_MS, retryHeld, retryHeldSync } from './held.js'

/** The one policy for a file Windows holds for a moment (os/held.ts, #2161): a fake operation refused `n` times */

const refusal = (code: string) => Object.assign(new Error(`${code}: simulated`), { code })

function refusedTimes(code: string, n: number) {
  let calls = 0
  return {
    op: () => {
      calls++
      if (calls <= n) throw refusal(code)
      return 'done'
    },
    calls: () => calls,
  }
}

describe('retryHeldSync', () => {
  it.each(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])('tries a refusal as held (%s) again, after the policy waits, until it succeeds', (code) => {
    const f = refusedTimes(code, 3)
    const waits: number[] = []
    const said: number[] = []
    expect(retryHeldSync(f.op, (ms) => waits.push(ms), (_e, ms) => said.push(ms))).toBe('done')
    expect(f.calls()).toBe(4)
    expect(waits).toEqual(HELD_WAITS_MS.slice(0, 3))
    expect(said).toEqual(waits)
  })

  it('throws the last refusal once every wait is spent', () => {
    const f = refusedTimes('EBUSY', 99)
    const waits: number[] = []
    expect(() => retryHeldSync(f.op, (ms) => waits.push(ms))).toThrow(/EBUSY/)
    expect(waits).toEqual(HELD_WAITS_MS)
    expect(f.calls()).toBe(HELD_WAITS_MS.length + 1)
  })

  it('throws any other error at once, with no wait', () => {
    const f = refusedTimes('ENOENT', 1)
    const waits: number[] = []
    expect(() => retryHeldSync(f.op, (ms) => waits.push(ms))).toThrow(/ENOENT/)
    expect(waits).toEqual([])
  })
})

describe('retryHeld', () => {
  it('waits without blocking, and gives up as the sync form does', async () => {
    const f = refusedTimes('EPERM', 2)
    const waits: number[] = []
    const wait = async (ms: number) => void waits.push(ms)
    await expect(retryHeld(async () => f.op(), wait)).resolves.toBe('done')
    expect(waits).toEqual(HELD_WAITS_MS.slice(0, 2))
    const never = refusedTimes('EPERM', 99)
    await expect(retryHeld(async () => never.op(), wait)).rejects.toThrow(/EPERM/)
    await expect(retryHeld(async () => refusedTimes('EEXIST', 1).op(), wait)).rejects.toThrow(/EEXIST/)
  })
})
