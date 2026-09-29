import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * A Codex subagent is **a different thread** (the codex side of #98).
 *
 * The multi_agent feature is on by default in codex (features/src/lib.rs: key "multi_agent",
 * Stage::Stable, default_enabled: true), and the model starts a child thread with spawn_agent.
 * The app-server attaches that thread's listener to **every initialized connection** whenever a
 * new thread is created (app-server/src/lib.rs: thread_created_rx ->
 * try_attach_thread_listener(thread_id, initialized_connection_ids)). The only place that
 * announces "a new thread was created" is agent spawning
 * (notify_thread_created in core/src/agent/control/spawn.rs). So a child thread's notifications
 * arrive on our own connection, differing only in threadId — this path was confirmed from source
 * and has not yet been re-verified by running it.
 *
 * Our adapter used not to look at threadId. A child's tool calls and text would go into the
 * parent's conversation, the child's turn/started would become the turn stop targets, and the
 * child's turn/completed would flip the parent to "finished."
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
  handlers: null as null | { onNotification: (n: { method: string; params?: unknown }) => void },
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: { onNotification: (n: { method: string; params?: unknown }) => void }) {
      state.handlers = handlers
    }
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'parent-thread' } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  state.requests.length = 0
})

async function session() {
  const events: NormalizedEvent[] = []
  const adapter = new CodexAdapter()
  const handle = await adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
  return { handle, events, notify: (method: string, params: unknown) => state.handlers!.onNotification({ method, params }) }
}

const command = (threadId: string, id: string, cmd: string) => ({
  threadId,
  turnId: 'x',
  item: { type: 'commandExecution', id, command: cmd, status: 'inProgress' },
})

describe("a codex child thread's notifications are not the parent session's conversation (#98)", () => {
  it("a child's tool calls and text do not create a line in the parent's conversation", async () => {
    const { events, notify } = await session()
    notify('item/started', command('parent-thread', 'call_parent', 'git status'))
    notify('item/started', command('child-thread', 'call_child', 'rg boundaries'))
    notify('item/agentMessage/delta', { threadId: 'child-thread', turnId: 'x', itemId: 'm1', delta: 'child report' })
    notify('item/agentMessage/delta', { threadId: 'parent-thread', turnId: 'x', itemId: 'm2', delta: 'parent answer' })

    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as { callId: string }).callId)).toEqual(['call_parent'])
    expect(events.filter((e) => e.type === 'message_delta').map((e) => (e as { text: string }).text)).toEqual(['parent answer'])
  })

  it("the parent does not finish when the child's turn ends — stop targets the parent's own turn", async () => {
    const { handle, events, notify } = await session()
    handle.send('오래 걸리는 일')
    await tick()
    notify('turn/started', { threadId: 'parent-thread', turn: { id: 'turn-parent' } })
    notify('turn/started', { threadId: 'child-thread', turn: { id: 'turn-child' } })
    notify('turn/completed', { threadId: 'child-thread', turn: { id: 'turn-child', status: 'completed' } })

    expect(events.some((e) => e.type === 'turn_complete')).toBe(false)
    handle.interrupt()
    expect(state.requests.filter((r) => r.method === 'turn/interrupt').map((r) => r.params)).toEqual([
      { threadId: 'parent-thread', turnId: 'turn-parent' },
    ])
  })
})
