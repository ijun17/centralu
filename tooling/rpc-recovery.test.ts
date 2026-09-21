import { describe, expect, it, vi } from 'vitest'
import { HostServer } from '../packages/agent-host/src/transport/server.js'
import { RpcClient } from '../packages/platform/src/web/rpc-client.js'

describe('real socket recovery across host lifetimes', () => {
  it('replaces an identical endpoint, resyncs, and never repeats an uncertain mutation', async () => {
    let mutations = 0
    let completeMutation: () => void = () => {}
    const mutationFinished = new Promise<void>((resolve) => { completeMutation = resolve })
    let server = new HostServer({ port: 0, token: 'fixture', onRpc: async () => {
      mutations++
      await mutationFinished
      return { ok: true }
    } })
    const port = await server.listen()
    const rpc = new RpcClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture', maxBackoffMs: 20 })
    const states: string[] = []
    const messages: string[] = []
    rpc.onConnectionChange((s) => states.push(s))
    rpc.onEvent((e) => { if (e.type === 'message_delta') messages.push(e.text) })
    try {
      rpc.connect()
      await vi.waitFor(() => expect(rpc.connectionState).toBe('connected'))
      server.broadcast({ type: 'message_delta', sessionId: 's', role: 'assistant', text: 'before' })
      await vi.waitFor(() => expect(messages).toEqual(['before']))
      const call = rpc.call('sessions.rename', { sessionId: 's', name: 'new' })
      const rejection = expect(call).rejects.toMatchObject({ code: 'connection_lost' })
      await vi.waitFor(() => expect(mutations).toBe(1))
      await server.close()
      await rejection
      server = new HostServer({ port, token: 'fixture', onRpc: async () => { mutations++; return [] } })
      await server.listen()
      await vi.waitFor(() => expect(states).toContain('resync_required'))
      server.broadcast({ type: 'message_delta', sessionId: 's', role: 'assistant', text: 'after' })
      await vi.waitFor(() => expect(messages).toEqual(['before', 'after']))
      expect(mutations).toBe(1)
      await expect(rpc.call('sessions.list', {})).resolves.toEqual([])
      expect(mutations).toBe(2)
    } finally {
      completeMutation()
      rpc.close()
      await server.close()
    }
  })
})

describe('real client oversized history recovery', () => {
  it('resyncs once, remains ready and delivers later live events instead of reconnect looping', async () => {
    const server = new HostServer({ port: 0, token: 'fixture', maxBufferedBytes: 600, onRpc: async () => [] })
    server.broadcast({ type: 'message_delta', sessionId: 's', role: 'assistant', text: 'x'.repeat(1000) })
    const port = await server.listen()
    const rpc = new RpcClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture', maxBackoffMs: 20 })
    const states: string[] = []
    const messages: string[] = []
    rpc.onConnectionChange((state) => states.push(state))
    rpc.onEvent((event) => { if (event.type === 'message_delta') messages.push(event.text) })
    try {
      rpc.connect()
      await vi.waitFor(() => expect(states).toContain('resync_required'))
      await expect(rpc.call('sessions.list', {})).resolves.toEqual([])
      server.broadcast({ type: 'message_delta', sessionId: 's', role: 'assistant', text: 'live' })
      await vi.waitFor(() => expect(messages).toEqual(['live']))
      expect(states).toEqual(['connecting', 'resync_required'])
      expect(rpc.connectionState).toBe('connected')
    } finally {
      rpc.close()
      await server.close()
    }
  })
})
