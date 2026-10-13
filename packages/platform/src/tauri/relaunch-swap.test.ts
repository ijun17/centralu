import { describe, expect, it, vi } from 'vitest'
import { finishRelaunchSwap } from './relaunch-swap.js'
import { autoSwitch, type AutoSwitchInput } from './switch-plan.js'

type Build = AutoSwitchInput['build'] & { mode: string }
const oldHost: Build = {
  mode: 'keeper',
  relaunched: true,
  sameBuild: false,
  keeperSameBuild: false,
  busy: false,
  keepsAgents: true,
  app: { version: `0.1.0-beta.${20}`, commit: 'new' },
  host: { version: `0.1.0-beta.${19}`, commit: 'old' },
  keeper: { version: `0.1.0-beta.${19}`, commit: 'old' },
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
    const result = await ready
    expect(result.tried).toBe(true)
    expect(result.error).toBe('Standby failed')
    expect(autoSwitch({ build: { ...oldHost, swap: { phase: 'failed', startedAt: 1, target: oldHost.app! } }, autoApply: false, dismissed: false, tried: result.tried })).toBe('none')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['rejection', 'new failure', 'success', 'timeout'] as const)(
    'ignores the attached failed swap on busy broadcasts and waits for the current %s',
    async (ending) => {
      vi.useFakeTimers()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const attached: Build = {
        ...oldHost, busy: true,
        swap: { phase: 'failed', startedAt: 0, target: oldHost.host!, message: 'Previous swap failed' },
      }
      let notify!: (b: Build) => void
      let rejectRequest!: (error: Error) => void
      let resolveRequest!: () => void
      const pendingRequest = new Promise<void>((resolve, reject) => {
        resolveRequest = resolve
        rejectRequest = reject
      })
      const request = vi.fn(() => pendingRequest)
      const stop = vi.fn()
      let settled = false
      const ready = finishRelaunchSwap(attached, (cb) => {
        notify = cb
        return stop
      }, request).then((result) => {
        settled = true
        return result
      })
      try {
        await vi.advanceTimersByTimeAsync(0)
        expect(request).toHaveBeenCalledTimes(1)
        // Activity broadcasts repeat the old failure before this request's first swap report.
        for (const busy of [false, true]) {
          notify({ ...attached, busy })
          await vi.advanceTimersByTimeAsync(0)
          expect(settled, 'an old failure must not release the window onto the old host').toBe(false)
          expect(stop).not.toHaveBeenCalled()
        }
        if (ending === 'rejection') rejectRequest(new Error('Current handoff refused'))
        else if (ending === 'new failure') {
          notify({ ...attached, swap: { phase: 'failed', startedAt: 1,
            target: oldHost.app!, message: 'Current swap failed' } })
        } else if (ending === 'success') {
          notify({ ...attached, sameBuild: true, keeperSameBuild: true })
        } else await vi.advanceTimersByTimeAsync(120_000)
        const error = ending === 'rejection' ? 'Current handoff refused'
          : ending === 'new failure' ? 'Current swap failed'
          : ending === 'timeout' ? 'The host update did not finish in time' : undefined
        expect(await ready).toEqual({ tried: true, ...(error ? { error } : {}) })
        expect(stop).toHaveBeenCalledTimes(1)
      } finally {
        resolveRequest()
        vi.clearAllTimers()
        vi.useRealTimers()
        warn.mockRestore()
      }
    },
  )

  it('a rejected switch continues on the attached host and cannot auto-switch again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = vi.fn()
    const request = vi.fn(async () => { throw new Error('Keeper refused the handoff') })
    try {
      const result = await finishRelaunchSwap(oldHost, () => stop, request)
      expect(result).toEqual({ tried: true, error: 'Keeper refused the handoff' })
      expect(autoSwitch({ build: oldHost, autoApply: false, dismissed: false, tried: result.tried })).toBe('none')
      expect(stop).toHaveBeenCalledTimes(1)
      expect(request).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  it('bounds a keeper that never reports the outcome', async () => {
    vi.useFakeTimers()
    try {
      const stop = vi.fn()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ready = finishRelaunchSwap(
          oldHost,
          () => stop,
          async () => {},
        ).then(value => ({ value }), error => ({ error }))
      await vi.advanceTimersByTimeAsync(120_000)
      const result = await ready
      expect(result).toEqual({ value: { tried: true, error: 'The host update did not finish in time' } })
      expect(warn).toHaveBeenCalled()
      expect(stop).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })
})
