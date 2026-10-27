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

  it('does not return a stale answer that may not stand in, and waits for the new read instead', async () => {
    let clock = 0
    const g = gate<string>()
    const read = vi.fn<() => Promise<string>>().mockResolvedValueOnce('logged out').mockReturnValueOnce(g.promise)
    const ask = softRead({ read, fallback: () => 'none', freshMs: 10, failMs: 1000, softMs: 5, now: () => clock, staleOk: (v) => v !== 'logged out' })
    expect(await ask()).toEqual(answer('logged out'))
    clock = 11
    // The new read is slower than the soft wait: provisional, not the stale "logged out" as final
    expect(await ask()).toEqual(answer('none', true))
    const settled = ask({ settle: true })
    g.resolve('Free')
    expect(await settled).toEqual(answer('Free'))
  })

  it('lets a settle wait only so long: the run goes on, the asker gets a provisional answer, and what the run reads is kept', async () => {
    const g = gate<string>()
    const read = vi.fn(() => g.promise)
    const ask = softRead({ read, fallback: () => 'none', freshMs: 60_000, failMs: 1000, softMs: 5, settleMs: 20 })
    expect(await ask()).toEqual(answer('none', true))
    expect(await ask({ settle: true })).toEqual(answer('none', true))
    g.resolve('totals')
    await vi.waitFor(async () => expect(await ask()).toEqual(answer('totals')))
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('keeps the last good answer while a refresh runs, and for as long as a refresh takes', async () => {
    let clock = 0
    const g = gate<string>()
    const read = vi.fn<() => Promise<string>>().mockResolvedValueOnce('old').mockReturnValueOnce(g.promise)
    const ask = softRead({ read, fallback: () => 'none', freshMs: 10, failMs: 1000, softMs: 5, now: () => clock })
    await ask()
    clock = 11
    // A run that takes minutes: every ask in between is the last good answer, at once, and none starts a second run
    for (clock = 11; clock < 300_000; clock += 60_000) expect(await ask()).toEqual(answer('old'))
    expect(read).toHaveBeenCalledTimes(2)
    g.resolve('new')
    await vi.waitFor(async () => expect(await ask()).toEqual(answer('new')))
  })

  it('is fresh for longer after a read that took longer', async () => {
    let clock = 0
    const read = vi.fn(async () => {
      clock += 12_000
      return 'totals'
    })
    const ask = softRead({ read, fallback: () => 'none', freshMs: (_v, took) => Math.max(60_000, took * 10), failMs: 1000, softMs: 50, now: () => clock })
    await ask()
    clock += 110_000
    await ask()
    expect(read).toHaveBeenCalledTimes(1)
    clock += 20_000
    await ask()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('stands on the answer a former process kept: returned at once, old as it is, while a read goes on behind it', async () => {
    const clock = 1_000_000
    const g = gate<string>()
    const read = vi.fn(() => g.promise)
    const ask = softRead({ read, fallback: () => 'none', freshMs: 60_000, failMs: 1000, softMs: 5, now: () => clock })
    // A day old: not fresh, so it is read again, but the asker does not wait for that (nor get the provisional fallback)
    expect(await ask({ seed: { value: 'kept', at: clock - 86_400_000 } })).toEqual(answer('kept'))
    expect(read).toHaveBeenCalledTimes(1)
    g.resolve('new')
    await vi.waitFor(async () => expect(await ask()).toEqual(answer('new')))
    // The process's own answer wins over a seed offered later
    expect(await ask({ seed: { value: 'kept', at: clock - 86_400_000 } })).toEqual(answer('new'))
  })

  it('does not read at all for a seed that is still fresh', async () => {
    const clock = 1_000_000
    const read = vi.fn(async () => 'new')
    const ask = softRead({ read, fallback: () => 'none', freshMs: 60_000, failMs: 1000, softMs: 5, now: () => clock })
    expect(await ask({ seed: { value: 'kept', at: clock - 1000 } })).toEqual(answer('kept'))
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps the seed when the read behind it fails', async () => {
    const clock = 1_000_000
    const ask = softRead({ read: async () => Promise.reject(new Error('boom')), fallback: () => 'none', freshMs: 60_000, failMs: 1000, softMs: 5, now: () => clock })
    expect(await ask({ seed: { value: 'kept', at: clock - 86_400_000 } })).toEqual(answer('kept'))
    await vi.waitFor(async () => expect(await ask()).toEqual(answer('kept')))
  })

  it('uses a local usage seed only when its totals say when they were read', async () => {
    const g = gate<{ plan: string | null }>()
    const seed = { plan: null, totals: { scope: 'all time', asOf: 5, rows: [] } }
    const ask = localUsageReader({ read: () => g.promise, fallback: () => ({ plan: null }), freshMs: 60_000, failMs: 1000, softMs: 10, now: () => 10_000_000 })
    expect(await ask({ seed })).toEqual(seed)
    // Without `asOf` nothing says how old it is, so it is not shown as an answer
    const other = localUsageReader({ read: () => g.promise, fallback: () => ({ plan: null }), freshMs: 60_000, failMs: 1000, softMs: 10 })
    expect(await other({ seed: { plan: null, totals: { scope: 'all time', rows: [] } } })).toEqual({ plan: null, provisional: true })
  })

  it('marks a local usage answer provisional only while the command is still being read', async () => {
    const g = gate<{ plan: string | null }>()
    const ask = localUsageReader({ read: () => g.promise, fallback: () => ({ plan: null }), freshMs: 60_000, failMs: 1000, softMs: 10 })
    expect(await ask()).toEqual({ plan: null, provisional: true })
    g.resolve({ plan: 'Free' })
    expect(await ask({ settle: true })).toEqual({ plan: 'Free' })
  })
})
