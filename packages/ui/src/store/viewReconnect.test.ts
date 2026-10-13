import { describe, expect, it, vi } from 'vitest'
// eslint-disable-next-line no-restricted-imports -- regression tests exercise the injected mock port
import { MockPlatform } from '@cc/platform/mock'
import { viewReconnect } from './viewReconnect.js'

const lost = () => Object.assign(new Error('Connection lost'), { code: 'connection_lost' })

describe('view reconnect', () => {
  it.each(['connected', 'resync_required'] as const)(
    'waits for %s, including a reconnect before the rejection settles',
    async (state) => {
      for (const early of [false, true]) {
        const mock = new MockPlatform()
        const call = vi.fn(async () => {
          if (call.mock.calls.length > 1) return 'opened'
          mock.setConnectionState('disconnected')
          if (early) mock.setConnectionState(state)
          throw lost()
        })
        const result = viewReconnect(mock, call)
        await Promise.resolve()
        if (!early) {
          expect(call).toHaveBeenCalledTimes(1)
          mock.setConnectionState(state)
        }
        expect(await result).toBe('opened')
        expect(call).toHaveBeenCalledTimes(2)
      }
    },
  )

  it.each([0, 1, 2, 3, 4, 5])('bounds retries across %i drops', async (drops) => {
    const mock = new MockPlatform()
    const call = vi.fn(async () => {
      if (call.mock.calls.length > drops) return 'opened'
      mock.setConnectionState('disconnected')
      mock.setConnectionState('resync_required')
      throw lost()
    })
    const result = viewReconnect(mock, call)
    if (drops > 3) await expect(result).rejects.toThrow('kept disconnecting')
    else expect(await result).toBe('opened')
    expect(call).toHaveBeenCalledTimes(Math.min(drops + 1, 4))
  })

  it('bounds waiting for a host that never comes back', async () => {
    vi.useFakeTimers()
    try {
      const mock = new MockPlatform()
      const call = vi.fn(async () => {
        throw lost()
      })
      const result = expect(viewReconnect(mock, call)).rejects.toThrow('did not reconnect in time')
      await vi.advanceTimersByTimeAsync(30_000)
      await result
      expect(call).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry an application refusal', async () => {
    const call = vi.fn(async () => {
      throw new Error('Not trusted')
    })
    await expect(viewReconnect(new MockPlatform(), call)).rejects.toThrow('Not trusted')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
