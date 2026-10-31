import { describe, expect, it, vi } from 'vitest'
import { createWebPlatform, RpcClient } from './index.js'

// No socket is opened: only the platform's choice of RPC and handling of its rejection matter.
class UnconnectedSocket {
  close() {}
}

const key = 'aabbccdd-1234-4567-8123-aabbccddeeff'

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
