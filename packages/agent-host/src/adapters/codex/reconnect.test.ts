import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * Codex reconnecting on its own is not a failure, and shows while it lasts (#168, item 3).
 *
 * The sequence below is what codex-cli 0.153.4 sent on 2026-10-03 for one turn against a
 * provider whose stream closed before `response.completed` (stream_max_retries=2): two
 * `error{willRetry:true}` notices, then the final `error{willRetry:false}` and
 * `turn/completed{status:"failed"}`, both carrying the same reason. Rate-limit updates arrive
 * between the attempts, so only an item counts as "output flows again".
 */
const state = vi.hoisted(() => ({
  handlers: null as null | { onNotification: (n: { method: string; params?: unknown }) => void },
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: { onNotification: (n: { method: string; params?: unknown }) => void }) {
      state.handlers = handlers
    }
    request(method: string): Promise<unknown> {
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'th' } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const REASON = 'stream disconnected before completion: stream closed before response.completed'
const turn = { id: 'turn-1', items: [], itemsView: 'notLoaded', status: 'inProgress', error: null }
const retry = (k: number) => ({
  method: 'error',
  params: {
    error: { message: `Reconnecting... ${k}/2`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: REASON, misalignment: null },
    willRetry: true,
    threadId: 'th',
    turnId: 'turn-1',
  },
})
const userItem = { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'say hi', text_elements: [] }] }
const opening = [
  { method: 'turn/started', params: { threadId: 'th', turn } },
  { method: 'item/started', params: { item: userItem, threadId: 'th', turnId: 'turn-1' } },
  { method: 'item/completed', params: { item: userItem, threadId: 'th', turnId: 'turn-1' } },
  { method: 'account/rateLimits/updated', params: { rateLimits: {} } },
]

let spy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  spy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => spy.mockRestore())

async function session() {
  const events: NormalizedEvent[] = []
  await new CodexAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
  const play = (ns: { method: string; params?: unknown }[]) => ns.forEach((n) => state.handlers!.onNotification(n))
  return { events, play }
}

const activities = (events: NormalizedEvent[]) =>
  events.filter((e): e is Extract<NormalizedEvent, { type: 'activity' }> => e.type === 'activity').map((e) => e.activity)

describe('codex reconnecting on its own (#168)', () => {
  it('the measured failing turn shows retrying once, and leaves one marker with the final reason', async () => {
    const { events, play } = await session()
    play([
      ...opening,
      retry(1),
      { method: 'account/rateLimits/updated', params: { rateLimits: {} } },
      retry(2),
      { method: 'thread/status/changed', params: { threadId: 'th', status: { type: 'systemError' } } },
      {
        method: 'error',
        params: { error: { message: REASON, codexErrorInfo: 'other', additionalDetails: null, misalignment: null }, willRetry: false, threadId: 'th', turnId: 'turn-1' },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'th', turn: { ...turn, status: 'failed', error: { message: REASON, codexErrorInfo: 'other', additionalDetails: null, misalignment: null } } },
      },
    ])

    expect(activities(events)).toEqual(['retrying'])
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ error: { message: REASON } })
  })

  it('once output flows again, the retrying indication gives way — and no marker is left', async () => {
    const { events, play } = await session()
    play([
      ...opening,
      retry(1),
      { method: 'account/rateLimits/updated', params: { rateLimits: {} } },
      { method: 'item/started', params: { item: { type: 'reasoning', id: 'r1', summary: [], content: [] }, threadId: 'th', turnId: 'turn-1' } },
      { method: 'item/agentMessage/delta', params: { threadId: 'th', turnId: 'turn-1', itemId: 'm1', delta: 'hi' } },
      { method: 'turn/completed', params: { threadId: 'th', turn: { ...turn, status: 'completed' } } },
    ])

    expect(activities(events)).toEqual(['retrying', null])
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'turn_complete', sessionId: 's1' })
  })

  it('a reconnect in the middle of compacting puts "compacting" back, not an ordinary wait', async () => {
    const { events, play } = await session()
    play([
      { method: 'turn/started', params: { threadId: 'th', turn } },
      { method: 'item/started', params: { item: { type: 'contextCompaction', id: 'c1' }, threadId: 'th', turnId: 'turn-1' } },
      retry(1),
      { method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'c1' }, threadId: 'th', turnId: 'turn-1' } },
    ])

    expect(activities(events)).toEqual(['compacting', 'retrying', 'compacting', null])
  })
})
