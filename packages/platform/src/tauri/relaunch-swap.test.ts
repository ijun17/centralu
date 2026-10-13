import { describe, expect, it, vi } from 'vitest'
import { finishRelaunchSwap } from './relaunch-swap.js'
import type { AutoSwitchInput } from './switch-plan.js'

type Build = AutoSwitchInput['build'] & { mode: string }
const oldHost: Build = {
  mode: 'keeper',
  relaunched: true,
  sameBuild: false,
  keeperSameBuild: false,
  busy: false,
  keepsAgents: true,
  app: { version: '0.1.0-beta.20', commit: 'new' },
  host: { version: '0.1.0-beta.19', commit: 'old' },
  keeper: { version: '0.1.0-beta.19', commit: 'old' },
}

describe('Apply now before the new window opens its panels', () => {
  it('attaches to the keeper, swaps its older host, then allows the window to open panels', async () => {
    const order: string[] = ['attach to keeper']
    let notify!: (b: Build) => void
    const stop = vi.fn()
    const ready = finishRelaunchSwap(
      oldHost,
      (cb) => {
        notify = cb
        return stop
      },
      async () => {
        order.push('request swap')
      },
    ).then(() => order.push('open panels'))
    await Promise.resolve()
    expect(order).toEqual(['attach to keeper', 'request swap'])
    notify({ ...oldHost, swap: { phase: 'draining', startedAt: 1, target: oldHost.app! } })
    expect(order).toHaveLength(2)
    notify({ ...oldHost, sameBuild: true, keeperSameBuild: true })
    await ready
    expect(order).toEqual(['attach to keeper', 'request swap', 'open panels'])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'does not start a swap in an ordinary or already-updated window (%s)',
    async (sameBuild) => {
      const request = vi.fn()
      await finishRelaunchSwap(
        { ...oldHost, relaunched: sameBuild, sameBuild, keeperSameBuild: sameBuild },
        vi.fn(),
        request,
      )
      expect(request).not.toHaveBeenCalled()
    },
  )

  it('a failed swap lets the existing build and its error bar be shown without repeating the switch', async () => {
    let notify!: (b: Build) => void
    const request = vi.fn(async () => {})
    const ready = finishRelaunchSwap(
      oldHost,
      (cb) => {
        notify = cb
        return () => {}
      },
      request,
    )
    await Promise.resolve()
    notify({
      ...oldHost,
      swap: { phase: 'failed', startedAt: 1, target: oldHost.app!, message: 'Standby failed' },
    })
    await ready
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('bounds a keeper that never reports the outcome', async () => {
    vi.useFakeTimers()
    try {
      const stop = vi.fn()
      const ready = expect(
        finishRelaunchSwap(
          oldHost,
          () => stop,
          async () => {},
        ),
      ).rejects.toThrow('did not finish in time')
      await vi.advanceTimersByTimeAsync(120_000)
      await ready
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
