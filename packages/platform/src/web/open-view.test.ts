import { describe, expect, it, vi } from 'vitest'
import { createWebPlatform, RpcClient } from './index.js'

// No socket is opened: only the platform's choice of RPC and handling of its rejection matter.
class UnconnectedSocket {
  close() {}
}

const key = 'aabbccdd-1234-4567-8123-aabbccddeeff'

describe('recovering a view on an older linked host', () => {
  it('reports the uncertain home outcome without repeating the original open', async () => {
    const call = vi.spyOn(RpcClient.prototype, 'call').mockRejectedValue(new Error('Unknown method: apps.recoverView. This Centralu host does not have it'))
    const platform = createWebPlatform({ token: 'test', WebSocketImpl: UnconnectedSocket as unknown as typeof WebSocket })
    try {
      await expect(platform.apps.openView('notes', null, 'm1', key, true)).rejects.toThrow('home tool may or may not have run')
      expect(call).toHaveBeenCalledTimes(1)
      expect(call).toHaveBeenCalledWith('apps.recoverView', { appId: 'notes', projectId: null, machine: 'm1', lease: true, openKey: key })
    } finally {
      await platform.dispose()
      call.mockRestore()
    }
  })

  it('preserves a real application refusal', async () => {
    const refusal = new Error('This app is not trusted')
    const call = vi.spyOn(RpcClient.prototype, 'call').mockRejectedValue(refusal)
    const platform = createWebPlatform({ token: 'test', WebSocketImpl: UnconnectedSocket as unknown as typeof WebSocket })
    try {
      await expect(platform.apps.openView('notes', null, 'm1', key, true)).rejects.toBe(refusal)
      expect(call).toHaveBeenCalledTimes(1)
    } finally {
      await platform.dispose()
      call.mockRestore()
    }
  })
})
