import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { HostServer } from '../packages/agent-host/src/transport/server.js'
import { RpcClient } from '../packages/platform/src/web/rpc-client.js'

/**
 * The real client against the real server over real sockets (#82). The unit tests on each side
 * use a fake for the other; these check that the two halves of the recovery contract (the host's
 * lifetime epoch and replay budget, the client's readiness, cursor and duplicate filter) actually
 * meet. Based on the shape of #91's rpc-recovery test.
 */
const delta = (text: string): NormalizedEvent => ({ type: 'message_delta', sessionId: 's', role: 'assistant', text })

function watch(rpc: RpcClient) {
  const states: string[] = []
  const texts: string[] = []
  rpc.onConnectionChange((s) => states.push(s))
  rpc.onEvent((e) => {
    if (e.type === 'message_delta') texts.push(e.text)
  })
  return { states, texts }
}

describe('real sockets: recovery across a host restart (#82)', () => {
  it('a host that came back on the same address is a resync, never a replay of its own numbers, and an in-flight mutation is not repeated', async () => {
    let mutations = 0
    let finishMutation: () => void = () => {}
    const mutationHeld = new Promise<void>((r) => (finishMutation = r))
    let host = new HostServer({
      port: 0,
      token: 'fixture',
      onRpc: async (method) => {
        if (method === 'sessions.rename') {
          mutations++
          await mutationHeld
        }
        return { ok: true }
      },
    })
    const port = await host.listen()
    const rpc = new RpcClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture', maxBackoffMs: 50 })
    const { states, texts } = watch(rpc)
    try {
      rpc.connect()
      await vi.waitFor(() => expect(rpc.connectionState).toBe('connected'))
      for (const t of ['A1', 'A2', 'A3']) host.broadcast(delta(t))
      await vi.waitFor(() => expect(texts).toEqual(['A1', 'A2', 'A3']))

      // A mutation reaches the host, and the host dies before answering
      const rename = rpc.call('sessions.rename', { sessionId: 's', name: 'new' })
      const unknown = expect(rename).rejects.toMatchObject({ code: 'connection_lost', retryable: false })
      await vi.waitFor(() => expect(mutations).toBe(1))
      await host.close()
      await unknown

      // The new lifetime numbers past the old cursor before the client is back
      host = new HostServer({
        port,
        token: 'fixture',
        onRpc: async (method) => {
          if (method === 'sessions.rename') mutations++
          return []
        },
      })
      for (const t of ['B1', 'B2', 'B3', 'B4', 'B5']) host.broadcast(delta(t))
      await host.listen()
      await vi.waitFor(() => expect(states).toContain('resync_required'))
      host.broadcast(delta('B6'))
      await vi.waitFor(() => expect(texts).toEqual(['A1', 'A2', 'A3', 'B6']))
      // The mutation whose outcome was unknown was not sent to the new host
      expect(mutations).toBe(1)
      await expect(rpc.call('sessions.list', {})).resolves.toEqual([])
    } finally {
      finishMutation()
      rpc.close()
      await host.close()
    }
  })

  it('a history too large to replay is one resync, after which the client stays ready and receives live events', async () => {
    const host = new HostServer({ port: 0, token: 'fixture', replayBudgetBytes: 4_096, onRpc: async () => [] })
    const port = await host.listen()
    const rpc = new RpcClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture', maxBackoffMs: 50 })
    const { states, texts } = watch(rpc)
    try {
      rpc.connect()
      await vi.waitFor(() => expect(rpc.connectionState).toBe('connected'))
      host.broadcast(delta('first'))
      await vi.waitFor(() => expect(texts).toEqual(['first']))

      // Drop the client's socket from the host side, and build a gap that will not fit the budget
      const before = states.length
      for (const ws of (host as unknown as { clients: Set<{ terminate(): void }> }).clients) ws.terminate()
      await vi.waitFor(() => expect(states.slice(before)).toContain('disconnected'))
      for (let i = 0; i < 10; i++) host.broadcast(delta('x'.repeat(1_000)))

      await vi.waitFor(() => expect(states.slice(before)).toEqual(['disconnected', 'connecting', 'connected', 'resync_required']))
      await expect(rpc.call('sessions.list', {})).resolves.toEqual([])
      host.broadcast(delta('live'))
      await vi.waitFor(() => expect(texts).toEqual(['first', 'live']))
      // No reconnect loop: still the one socket
      await new Promise((r) => setTimeout(r, 200))
      expect(states.slice(before)).toEqual(['disconnected', 'connecting', 'connected', 'resync_required'])
    } finally {
      rpc.close()
      await host.close()
    }
  })

  it('a small gap in the same lifetime is replayed exactly once', async () => {
    const host = new HostServer({ port: 0, token: 'fixture', onRpc: async () => [] })
    const port = await host.listen()
    const rpc = new RpcClient({ url: `ws://127.0.0.1:${port}`, token: 'fixture', maxBackoffMs: 50 })
    const { states, texts } = watch(rpc)
    try {
      rpc.connect()
      await vi.waitFor(() => expect(rpc.connectionState).toBe('connected'))
      host.broadcast(delta('1'))
      await vi.waitFor(() => expect(texts).toEqual(['1']))
      for (const ws of (host as unknown as { clients: Set<{ terminate(): void }> }).clients) ws.terminate()
      await vi.waitFor(() => expect(states).toContain('disconnected'))
      host.broadcast(delta('2'))
      host.broadcast(delta('3'))
      await vi.waitFor(() => expect(texts).toEqual(['1', '2', '3']))
      host.broadcast(delta('4'))
      await vi.waitFor(() => expect(texts).toEqual(['1', '2', '3', '4']))
      expect(states).not.toContain('resync_required')
    } finally {
      rpc.close()
      await host.close()
    }
  })
})
