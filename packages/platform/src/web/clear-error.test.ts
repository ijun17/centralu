import { describe, expect, it, vi } from 'vitest'
import { createWebPlatform, RpcClient } from './index.js'

class UnconnectedSocket {
  close() {}
}

describe('Done on an error against an older host (#1549)', () => {
  it('reads the answer with markRead when the host does not know sessions.clearError', async () => {
    const call = vi.spyOn(RpcClient.prototype, 'call').mockImplementation((method: string) => {
      if (method === 'sessions.clearError') return Promise.reject(new Error('Unknown method: sessions.clearError. This Centralu host does not have it'))
      return Promise.resolve({ ok: true } as never)
    })
    const platform = createWebPlatform({ token: 'test', WebSocketImpl: UnconnectedSocket as unknown as typeof WebSocket })
    try {
      await expect(platform.agents.clearError('s1', 7)).resolves.toEqual({ cleared: false })
      expect(call).toHaveBeenCalledWith('sessions.markRead', { sessionId: 's1', seq: 7 })
    } finally {
      await platform.dispose()
      call.mockRestore()
    }
  })

  it('passes a real refusal on', async () => {
    const refusal = new Error('Session not found: s1')
    const call = vi.spyOn(RpcClient.prototype, 'call').mockRejectedValue(refusal)
    const platform = createWebPlatform({ token: 'test', WebSocketImpl: UnconnectedSocket as unknown as typeof WebSocket })
    try {
      await expect(platform.agents.clearError('s1', 7)).rejects.toBe(refusal)
    } finally {
      await platform.dispose()
      call.mockRestore()
    }
  })
})
