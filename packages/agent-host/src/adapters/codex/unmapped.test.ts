import { describe, expect, it, vi } from 'vitest'

/**
 * A notification method nothing handles is said once per session in host.log (#58). Measured on codex-cli 0.160.0
 * (2026-10-04): `warning` and `configWarning` arrived in an ordinary session and reached nobody (#304 maps them now),
 * and `thread/compacted` stopped arriving without a word. The line is the first place a change like that shows.
 */
const state = vi.hoisted(() => ({
  handlers: [] as { onNotification: (n: { method: string; params?: unknown }) => void }[],
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: { onNotification: (n: { method: string; params?: unknown }) => void }) {
      state.handlers.push(handlers)
    }
    request(method: string): Promise<unknown> {
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

async function session(sessionId: string) {
  await new CodexAdapter().createSession({ sessionId, cwd: '/tmp', permissionPreset: 'normal' }, () => {})
  return state.handlers.at(-1)!
}

describe('codex unmapped notification methods (#58)', () => {
  it('says a method nothing handles once per session, from any thread, and nothing for known methods', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const one = await session('aaaaaaaa-1')
      one.onNotification({ method: 'skills/changed', params: {} })
      one.onNotification({ method: 'skills/changed', params: {} })
      // A child thread's notification is filtered out of the conversation, but an unknown method is still news
      one.onNotification({ method: 'item/reasoning/textDelta', params: { threadId: 'child', delta: 'x' } })
      // Mapped by #304: no line
      one.onNotification({ method: 'warning', params: { threadId: 't1', message: 'config ignored' } })
      // Mapped, ignored by #58, and correctly ignored: no line
      one.onNotification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn-1' } } })
      one.onNotification({ method: 'thread/status/changed', params: { threadId: 't1', status: { type: 'idle' } } })
      one.onNotification({ method: 'account/updated', params: { authMode: 'chatgpt' } })
      const two = await session('bbbbbbbb-2')
      two.onNotification({ method: 'skills/changed', params: {} })

      const lines = spy.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('unmapped message type'))
      expect(lines).toEqual([
        '[codex] aaaaaaaa unmapped message type: skills/changed',
        '[codex] aaaaaaaa unmapped message type: item/reasoning/textDelta',
        '[codex] bbbbbbbb unmapped message type: skills/changed',
      ])
    } finally {
      spy.mockRestore()
    }
  })
})
