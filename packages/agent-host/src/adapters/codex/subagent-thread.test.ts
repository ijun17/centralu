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
 * arrive on our own connection, differing only in threadId — confirmed from source, then measured
 * live for #222 (codex-cli 0.153.4 and 0.160.0; scripts/probe-codex-subagent.mts).
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
    handle.send('a long-running task')
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

/*
 * The shapes and order measured live (scripts/probe-codex-subagent.mts, codex-cli 0.160.0, 2026-10-03): the parent's
 * spawnAgent item starts with `receiverThreadIds: []`, the child's first notification arrives in the same millisecond
 * as the spawnAgent `item/completed` that names it, and before it; then the child's items arrive with its threadId.
 */
describe("what a codex child agent did is kept under the spawnAgent card that launched it (#222)", () => {
  const CHILD = '01a0fefe-fb63-7651-8db6-90b34dc90f00'
  const SPAWN = 'exec-91551a68-2713-4d0f-b31c-91da3ce6a2f1'
  const spawn = (method: 'item/started' | 'item/completed', threadId = 'parent-thread', id = SPAWN, receivers = [CHILD]) => ({
    threadId,
    turnId: 't',
    item: {
      type: 'collabAgentToolCall', id, tool: 'spawnAgent', status: method === 'item/started' ? 'inProgress' : 'completed',
      senderThreadId: threadId, receiverThreadIds: method === 'item/started' ? [] : receivers,
      prompt: 'Run the shell command `echo pong-from-child`, then reply with exactly the word pong.',
      model: null, reasoningEffort: null, agentsStates: {},
    },
  })
  const childRun = (threadId = CHILD) => [
    ['item/started', { threadId, turnId: 'c', item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Run …' }] } }],
    ['item/completed', { threadId, turnId: 'c', item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Run …' }] } }],
    ['item/started', { threadId, turnId: 'c', item: { type: 'reasoning', id: 'rs_1', summary: [], content: [] } }],
    ['item/reasoning/summaryTextDelta', { threadId, turnId: 'c', itemId: 'rs_1', delta: '**Confirming', summaryIndex: 0 }],
    ['item/completed', { threadId, turnId: 'c', item: { type: 'reasoning', id: 'rs_1', summary: ["**Confirming exact 'pong' response**"], content: [] } }],
    ['item/started', { threadId, turnId: 'c', item: { type: 'commandExecution', id: 'exec-cmd', command: "/bin/zsh -lc 'echo pong-from-child'", cwd: '/tmp', status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null } }],
    ['item/completed', { threadId, turnId: 'c', item: { type: 'commandExecution', id: 'exec-cmd', command: "/bin/zsh -lc 'echo pong-from-child'", cwd: '/tmp', status: 'completed', aggregatedOutput: 'pong-from-child\n', exitCode: 0, durationMs: 0 } }],
    ['item/agentMessage/delta', { threadId, turnId: 'c', itemId: 'msg_1', delta: 'pong' }],
    ['item/completed', { threadId, turnId: 'c', item: { type: 'agentMessage', id: 'msg_1', text: 'pong', phase: 'final_answer' } }],
    ['turn/completed', { threadId, turn: { id: 'c', status: 'completed' } }],
  ] as const
  const steps = (events: NormalizedEvent[], parent = SPAWN) =>
    events.flatMap((e) => (e.type === 'subagent_event' && e.parentCallId === parent ? [e.step] : []))
  const expected = [
    { type: 'reasoning_delta', sessionId: 's1', text: "**Confirming exact 'pong' response**" },
    {
      type: 'tool_call', sessionId: 's1', callId: 'exec-cmd',
      summary: { tool: 'Bash', title: "/bin/zsh -lc 'echo pong-from-child'", readOnly: false, paths: [] },
      input: { command: "/bin/zsh -lc 'echo pong-from-child'", cwd: '/tmp' },
    },
    { type: 'tool_result', sessionId: 's1', callId: 'exec-cmd', ok: true, summary: 'pong-from-child\n', output: 'pong-from-child\n' },
    { type: 'message_delta', sessionId: 's1', role: 'assistant', text: 'pong', messageId: 'msg_1' },
  ]

  it('keeps the child\'s reasoning, command and reply, in order, tagged with the spawnAgent item', async () => {
    const { events, notify } = await session()
    notify('item/started', spawn('item/started'))
    notify('item/completed', spawn('item/completed'))
    for (const [method, params] of childRun()) notify(method, params)
    expect(steps(events)).toEqual(expected)
  })

  it('keeps what the child sent before the spawnAgent card named it — held, then replayed when the link arrives', async () => {
    const { events, notify } = await session()
    notify('item/started', spawn('item/started'))
    const run = childRun()
    for (const [method, params] of run.slice(0, 5)) notify(method, params)
    expect(steps(events)).toEqual([])
    notify('item/completed', spawn('item/completed'))
    for (const [method, params] of run.slice(5)) notify(method, params)
    expect(steps(events)).toEqual(expected)
  })

  it('the child\'s steps add nothing to the parent\'s conversation and do not end its turn', async () => {
    const { events, notify } = await session()
    notify('item/started', spawn('item/started'))
    notify('item/completed', spawn('item/completed'))
    for (const [method, params] of childRun()) notify(method, params)
    expect(events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result').map((e) => (e as { callId: string }).callId)).toEqual([SPAWN, SPAWN])
    expect(events.filter((e) => e.type === 'message_delta' || e.type === 'turn_complete')).toEqual([])
  })

  it('the spawnAgent card reads as the work handed to the child, and is recognised as a launch card', async () => {
    const { events, notify } = await session()
    notify('item/started', spawn('item/started'))
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({
      callId: SPAWN,
      summary: { tool: 'spawnAgent', title: 'Run the shell command `echo pong-from-child`, then reply with exactly the word pong.' },
    })
  })

  it('a child that spawns its own keeps that one\'s steps under its own spawnAgent card', async () => {
    const GRANDCHILD = 'grandchild-thread'
    const { events, notify } = await session()
    notify('item/completed', spawn('item/completed'))
    notify('item/started', spawn('item/started', CHILD, 'exec-nested'))
    notify('item/completed', spawn('item/completed', CHILD, 'exec-nested', [GRANDCHILD]))
    for (const [method, params] of childRun(GRANDCHILD)) notify(method, params)
    expect(steps(events).map((s) => s.type === 'tool_call' || s.type === 'tool_result' ? `${s.type}:${s.callId}` : s.type)).toEqual([
      'tool_call:exec-nested',
      'tool_result:exec-nested',
    ])
    expect(steps(events, 'exec-nested')).toEqual(expected)
  })

  it('lets go of what no spawnAgent card ever named once the parent\'s turn ends', async () => {
    const { events, notify } = await session()
    for (const [method, params] of childRun().slice(0, 7)) notify(method, params)
    notify('turn/completed', { threadId: 'parent-thread', turn: { id: 'p', status: 'completed' } })
    notify('item/completed', spawn('item/completed'))
    expect(steps(events)).toEqual([])
  })
})
