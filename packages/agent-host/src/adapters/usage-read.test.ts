import { describe, expect, it, vi } from 'vitest'
import { localUsageReader, softRead } from './usage-read.js'

/** A read whose end the test decides, so no wall-clock wait is needed */
function gate<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const answer = <T>(value: T, provisional = false) => ({ value, provisional })

describe('a usage read that is a command run (#1623)', () => {
  it('runs the command once for an answer that is fresh, and once for two askers at the same time', async () => {
    let clock = 0
    const read = vi.fn(async () => 'plan')
    const ask = softRead({ read, fallback: () => 'none', freshMs: 1000, failMs: 1000, softMs: 50, now: () => clock })
    expect(await Promise.all([ask(), ask()])).toEqual([answer('plan'), answer('plan')])
    expect(read).toHaveBeenCalledTimes(1)
    clock = 999
    expect(await ask()).toEqual(answer('plan'))
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('answers the stale value at once and reads again behind it', async () => {
    let clock = 0
    const g = gate<string>()
    const read = vi.fn<() => Promise<string>>().mockResolvedValueOnce('old').mockReturnValueOnce(g.promise)
    const ask = softRead({ read, fallback: () => 'none', freshMs: 1000, failMs: 1000, softMs: 50, now: () => clock })
    expect(await ask()).toEqual(answer('old'))
    clock = 2000
    expect(await ask()).toEqual(answer('old'))
    expect(read).toHaveBeenCalledTimes(2)
    g.resolve('new')
    await vi.waitFor(async () => expect(await ask()).toEqual(answer('new')))
  })

  it('does not keep the asker waiting on a command that hangs: the fallback answers, marked provisional, and the read still fills the cache', async () => {
    const g = gate<string>()
    const ask = softRead({ read: () => g.promise, fallback: () => 'none', freshMs: 60_000, failMs: 1000, softMs: 10 })
    expect(await ask()).toEqual(answer('none', true))
    g.resolve('Free')
    // What the command read is kept; the fallback never was
    await vi.waitFor(async () => expect(await ask()).toEqual(answer('Free')))
  })

  it('settles: waits for the read in flight and answers what it read, final', async () => {
    const g = gate<string>()
    const read = vi.fn(() => g.promise)
    const ask = softRead({ read, fallback: () => 'none', freshMs: 60_000, failMs: 1000, softMs: 10 })
    expect(await ask()).toEqual(answer('none', true))
    const settled = ask({ settle: true })
    g.resolve('Free')
    expect(await settled).toEqual(answer('Free'))
    // One command run served the soft ask, the settle and the next ask
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('settles with the fallback, final, when the command failed: nothing is being read', async () => {
    const g = gate<string>()
    const ask = softRead({ read: () => g.promise, fallback: () => 'none', freshMs: 60_000, failMs: 1000, softMs: 10, onFail: () => {} })
    await ask()
    const settled = ask({ settle: true })
    g.reject(new Error('timed out'))
    expect(await settled).toEqual(answer('none'))
  })

  it('does not run a failed command again for a while, says it once, and is final about it', async () => {
    let clock = 0
    const onFail = vi.fn()
    const read = vi.fn(async (): Promise<string> => {
      throw new Error('spawn failed')
    })
    const ask = softRead({ read, fallback: () => 'none', freshMs: 1000, failMs: 500, softMs: 50, now: () => clock, onFail })
    expect(await ask()).toEqual(answer('none'))
    clock = 100
    expect(await ask()).toEqual(answer('none'))
    expect(read).toHaveBeenCalledTimes(1)
    expect(onFail).toHaveBeenCalledTimes(1)
    clock = 600
    await ask()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('lets how long an answer is fresh depend on the answer', async () => {
    let clock = 0
    const read = vi.fn(async () => 'out')
    const ask = softRead({ read, fallback: () => 'none', freshMs: (v) => (v === 'out' ? 10 : 1000), failMs: 1000, softMs: 50, now: () => clock })
    await ask()
    clock = 11
    await ask()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('marks a local usage answer provisional only while the command is still being read', async () => {
    const g = gate<{ plan: string | null }>()
    const ask = localUsageReader({ read: () => g.promise, fallback: () => ({ plan: null }), freshMs: 60_000, failMs: 1000, softMs: 10 })
    expect(await ask()).toEqual({ plan: null, provisional: true })
    g.resolve({ plan: 'Free' })
    expect(await ask({ settle: true })).toEqual({ plan: 'Free' })
  })
})
