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

describe('the result of opening a view', () => {
  const opened = { instanceId: 'i1', tool: 'home', resourceUri: 'ui://home', toolInput: {}, runId: 'r1' }

  it('is carried through as the app gave it, and a result that is no MCP result becomes a failed one', async () => {
    const good = { content: [{ type: 'text', text: 'hi' }], structuredContent: { n: 1 } }
    const call = vi.spyOn(RpcClient.prototype, 'call')
    const platform = createWebPlatform({ token: 'test', WebSocketImpl: UnconnectedSocket as unknown as typeof WebSocket })
    try {
      call.mockResolvedValueOnce({ ...opened, toolResult: good })
      expect((await platform.apps.openView('notes', null, undefined, undefined)).toolResult).toBe(good)
      call.mockResolvedValueOnce({ ...opened, toolResult: { content: ['not an object'] } })
      const bad = await platform.apps.openView('notes', null, undefined, undefined)
      expect(bad.toolResult).toEqual({ content: [{ type: 'text', text: 'The app answered with a result this window cannot read' }], isError: true })
      expect(bad.instanceId).toBe('i1')
      // Recovering an open (older host, same variable) is checked the same way
      call.mockResolvedValueOnce({ ...opened, toolResult: { content: [null] } })
      const recovered = await platform.apps.openView('notes', null, undefined, key, true)
      expect(recovered.toolResult).toEqual({ content: [{ type: 'text', text: 'The app answered with a result this window cannot read' }], isError: true })
    } finally {
      await platform.dispose()
      call.mockRestore()
    }
  })
})
