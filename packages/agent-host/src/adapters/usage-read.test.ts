import { describe, expect, it, vi } from 'vitest'
import { softRead } from './usage-read.js'

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

describe('a usage read that is a command run (#1623)', () => {
  it('runs the command once for an answer that is fresh, and once for two askers at the same time', async () => {
    let clock = 0
    const read = vi.fn(async () => 'plan')
    const ask = softRead({ read, fallback: () => 'none', freshMs: 1000, failMs: 1000, softMs: 50, now: () => clock })
    expect(await Promise.all([ask(), ask()])).toEqual(['plan', 'plan'])
    expect(read).toHaveBeenCalledTimes(1)
    clock = 999
    expect(await ask()).toBe('plan')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('answers the stale value at once and reads again behind it', async () => {
    let clock = 0
    const g = gate<string>()
    const read = vi.fn<() => Promise<string>>().mockResolvedValueOnce('old').mockReturnValueOnce(g.promise)
    const ask = softRead({ read, fallback: () => 'none', freshMs: 1000, failMs: 1000, softMs: 50, now: () => clock })
    expect(await ask()).toBe('old')
    clock = 2000
    expect(await ask()).toBe('old')
    expect(read).toHaveBeenCalledTimes(2)
    g.resolve('new')
    await vi.waitFor(async () => expect(await ask()).toBe('new'))
  })

  it('does not keep the asker waiting on a command that hangs: the fallback answers, and the read still fills the cache', async () => {
    const g = gate<string>()
    const ask = softRead({ read: () => g.promise, fallback: () => 'none', freshMs: 60_000, failMs: 1000, softMs: 10 })
    expect(await ask()).toBe('none')
    g.resolve('Free')
    await vi.waitFor(async () => expect(await ask()).toBe('Free'))
  })

  it('does not run a failed command again for a while, and says it once', async () => {
    let clock = 0
    const onFail = vi.fn()
    const read = vi.fn(async (): Promise<string> => {
      throw new Error('spawn failed')
    })
    const ask = softRead({ read, fallback: () => 'none', freshMs: 1000, failMs: 500, softMs: 50, now: () => clock, onFail })
    expect(await ask()).toBe('none')
    clock = 100
    expect(await ask()).toBe('none')
    expect(read).toHaveBeenCalledTimes(1)
    expect(onFail).toHaveBeenCalledTimes(1)
    clock = 600
    await ask()
    expect(read).toHaveBeenCalledTimes(2)
  })
})
