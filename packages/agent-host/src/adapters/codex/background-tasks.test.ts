import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * A Codex session's background work: its child agents (#290).
 *
 * The notifications are the measured ones (scripts/probe-codex-background.mts, codex-cli 0.160.0, gpt-5.6-luna,
 * 2026-10-04), in the measured order, with the parent's thread renamed to the id the fake client hands out:
 *
 *   child   thread/status/changed {idle}        ← before the link
 *   parent  item/completed spawnAgent           ← names the child in receiverThreadIds
 *   child   thread/status/changed {active}
 *   child   turn/started
 *   …
 *   child   thread/status/changed {idle}        ← turn/interrupt on the child's own turn
 *   child   turn/completed {interrupted}
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
  handlers: null as null | { onNotification: (n: { method: string; params?: unknown }) => void; onExit: (code: number | null, expected: boolean) => void },
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: NonNullable<typeof state.handlers>) {
      state.handlers = handlers
    }
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: PARENT } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const PARENT = '01a106a6-19e6-7681-bb90-7dbef8f34ead'
const CHILD = '01a106a6-350f-7623-aa9f-7a34ef243049'
const SPAWN = 'exec-8cea33c7-30d9-4474-aabf-f646efa4d5cb'
const CHILD_TURN = '01a106a6-3533-7132-a235-6e2f07d035ab'
const PROMPT = 'Run the shell command `sleep 193; echo child-done`, then reply with exactly the word done.'

const { CodexAdapter } = await import('./index.js')

beforeEach(() => {
  state.requests.length = 0
})

const status = (threadId: string, type: string) => ['thread/status/changed', { threadId, status: type === 'active' ? { type, activeFlags: [] } : { type } }] as const
const spawned = [
  'item/completed',
  {
    item: {
      type: 'collabAgentToolCall',
      id: SPAWN,
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: PARENT,
      receiverThreadIds: [CHILD],
      prompt: PROMPT,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      agentsStates: { [CHILD]: { status: 'pendingInit', message: null } },
    },
    threadId: PARENT,
    turnId: '01a106a6-1a14-7e50-b5eb-906c25a37f02',
  },
] as const
const childTurn = (s: string) => ({ threadId: CHILD, turn: { id: CHILD_TURN, items: [], itemsView: 'notLoaded', status: s, error: null } })
const launched = [status(CHILD, 'idle'), spawned, status(CHILD, 'active'), ['turn/started', childTurn('inProgress')] as const]

async function session() {
  const events: NormalizedEvent[] = []
  const handle = await new CodexAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
  const notify = (steps: readonly (readonly [string, unknown])[]) => {
    for (const [method, params] of steps) state.handlers!.onNotification({ method, params })
  }
  return { handle, events, notify }
}
const lastTasks = (events: NormalizedEvent[]) =>
  events.filter((e) => e.type === 'background_tasks').at(-1) as Extract<NormalizedEvent, { type: 'background_tasks' }> | undefined

describe('a Codex session reports its child agents as background work (#290)', () => {
  it('declares that it reports background work', () => {
    expect(new CodexAdapter().capabilities.backgroundTasks).toBe(true)
  })

  it('a child is listed once its launch call names it, with the prompt, and says the parent\'s interrupt leaves it running', async () => {
    const { events, notify, handle } = await session()
    notify(launched.slice(0, 1))
    // A status from a thread no launch call named yet lists nothing
    expect(events.filter((e) => e.type === 'background_tasks')).toEqual([])
    notify(launched.slice(1))
    expect(lastTasks(events)?.live).toEqual([
      {
        id: CHILD,
        kind: 'agent',
        description: PROMPT,
        parentCallId: SPAWN,
        stopsWithTurn: false,
        stoppable: true,
        status: 'running',
      },
    ])
    await handle.dispose()
  })

  it('a child active before the link is listed the moment the link arrives', async () => {
    const { events, notify, handle } = await session()
    notify([status(CHILD, 'active'), ['turn/started', childTurn('inProgress')], spawned])
    expect(lastTasks(events)?.live.map((t) => t.id)).toEqual([CHILD])
    await handle.dispose()
  })

  it('stopping a child interrupts the child\'s own turn, and the interrupted turn ends it as stopped', async () => {
    const { events, notify, handle } = await session()
    notify(launched)
    await handle.stopBackgroundTask?.(CHILD)
    expect(state.requests.filter((r) => r.method === 'turn/interrupt')).toEqual([
      { method: 'turn/interrupt', params: { threadId: CHILD, turnId: CHILD_TURN } },
    ])
    notify([status(CHILD, 'idle'), ['turn/completed', childTurn('interrupted')]])
    expect(lastTasks(events)).toMatchObject({ live: [], ended: [{ id: CHILD, status: 'stopped', parentCallId: SPAWN }] })
    await handle.dispose()
  })

  it('a child that finishes its turn ends as completed, and one with a failed turn as failed', async () => {
    const { events, notify, handle } = await session()
    notify(launched)
    notify([['turn/completed', childTurn('completed')], status(CHILD, 'idle')])
    expect(lastTasks(events)?.ended?.[0]).toMatchObject({ id: CHILD, status: 'completed' })
    notify([status(CHILD, 'active'), ['turn/started', childTurn('inProgress')]])
    expect(lastTasks(events)?.live.map((t) => t.id)).toEqual([CHILD])
    notify([['turn/completed', { threadId: CHILD, turn: { id: CHILD_TURN, status: 'failed', error: { message: 'stream disconnected' } } }]])
    expect(lastTasks(events)?.ended?.[0]).toMatchObject({ status: 'failed', summary: 'stream disconnected' })
    await handle.dispose()
  })

  it('a child with no running turn cannot be stopped, and asking says so', async () => {
    const { notify, handle } = await session()
    notify(launched)
    notify([['turn/completed', childTurn('completed')]])
    await expect(handle.stopBackgroundTask!(CHILD)).rejects.toThrow(/no running turn/)
    await handle.dispose()
  })

  it('closing the session ends every child still running as stopped — they lived in that app-server', async () => {
    const { events, notify, handle } = await session()
    notify(launched)
    await handle.dispose()
    expect(lastTasks(events)).toMatchObject({ live: [], ended: [{ id: CHILD, status: 'stopped' }] })
  })

  it('an app-server that dies takes its children with it, and says so once', async () => {
    const { events, notify } = await session()
    notify(launched)
    state.handlers!.onExit(1, false)
    expect(lastTasks(events)).toMatchObject({ live: [], ended: [{ id: CHILD, status: 'stopped' }] })
    expect(events.filter((e) => e.type === 'background_tasks' && e.ended?.length)).toHaveLength(1)
  })
})
