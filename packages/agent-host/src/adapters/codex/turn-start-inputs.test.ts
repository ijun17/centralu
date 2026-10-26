import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * What a turn Codex starts began from (#1604). Codex merges a message sent while a turn runs into it, yet starts a turn of its
 * own for one sent just after a turn ended, or queued behind a compact or review, and a hub needs to know whose message that
 * turn is for. The first item of such a turn is the message it began from, under the client id the adapter gave `turn/start`:
 * the adapter says it with a second `working` for the turn, which the host reads with `turnStartInputs`.
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
  handlers: null as null | { onNotification: (n: { method: string; params?: unknown }) => void },
  turnStartReply: null as null | (() => Promise<unknown>),
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: { onNotification: (n: { method: string; params?: unknown }) => void }) {
      state.handlers = handlers
    }
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      if (method === 'turn/start' && state.turnStartReply) return state.turnStartReply()
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const tick = () => new Promise((r) => setTimeout(r, 0))
const NOTE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  state.requests.length = 0
  state.turnStartReply = null
})

/** The inputs the host would read as each `working` event is handled, in order */
async function session() {
  const startedFrom: (readonly string[] | null)[] = []
  const events: NormalizedEvent[] = []
  const handle: { current?: Awaited<ReturnType<InstanceType<typeof CodexAdapter>['createSession']>> } = {}
  handle.current = await new CodexAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => {
    events.push(e)
    if (e.type === 'state_change' && e.state === 'working') startedFrom.push(handle.current?.turnStartInputs?.() ?? null)
  })
  return { h: handle.current, startedFrom, events }
}

const turnStarted = (id: string) => state.handlers!.onNotification({ method: 'turn/started', params: { threadId: 't1', turn: { id } } })
const item = (turnId: string, type: string, clientId?: string) =>
  state.handlers!.onNotification({ method: 'item/started', params: { threadId: 't1', turnId, item: { type, id: `i-${type}`, ...(clientId ? { clientId } : {}) } } })
const completed = (id: string) => state.handlers!.onNotification({ method: 'turn/completed', params: { threadId: 't1', turn: { id } } })

describe('codex: the input a turn it started began from (#1604)', () => {
  it("says it as the turn opens when the message was sent just after the turn it was meant for ended", async () => {
    const { h, startedFrom } = await session()
    state.turnStartReply = async () => ({ turn: { id: 'late-2' } })
    void h.sendTracked!('a note', undefined, { id: NOTE }).catch(() => {})
    await tick()
    // Codex started a turn of its own for it: the app-server names it and its first item is the message, under the id given
    turnStarted('late-2')
    item('late-2', 'userMessage', NOTE)
    // The opening `working` says nothing yet; the one that follows the message names it
    expect(startedFrom).toEqual([null, [NOTE]])
    expect(state.requests.find((r) => r.method === 'turn/start')?.params?.clientUserMessageId).toBe(NOTE)
    completed('late-2')
    await h.dispose()
  })

  it('says every message of a batch that was queued behind a compact and ran as one turn', async () => {
    const { h, startedFrom } = await session()
    h.send('/compact')
    await tick()
    turnStarted('compact-1')
    void h.sendTracked!('first', undefined, { id: NOTE }).catch(() => {})
    void h.sendTracked!('second', undefined, { id: OTHER }).catch(() => {})
    state.turnStartReply = async () => ({ turn: { id: 'notes-2' } })
    await tick()
    completed('compact-1')
    await tick()
    turnStarted('notes-2')
    item('notes-2', 'userMessage', NOTE)
    expect(startedFrom.at(-1)).toEqual([NOTE, OTHER])
    completed('notes-2')
    await h.dispose()
  })

  it('says nothing of a message that joined a turn already running: it shows after the turn’s first item', async () => {
    const { h, startedFrom } = await session()
    state.turnStartReply = async () => ({ turn: { id: 'turn-1' } })
    h.send('long job')
    await tick()
    turnStarted('turn-1')
    item('turn-1', 'reasoning')
    void h.sendTracked!('joined', undefined, { id: NOTE }).catch(() => {})
    await tick()
    item('turn-1', 'userMessage', NOTE)
    expect(startedFrom).toEqual([null])
    completed('turn-1')
    await h.dispose()
  })

  it("says nothing of a turn the person's message started: no client id it gave", async () => {
    const { h, startedFrom } = await session()
    state.turnStartReply = async () => ({ turn: { id: 'turn-1' } })
    h.send('typed by the person')
    await tick()
    turnStarted('turn-1')
    item('turn-1', 'userMessage')
    expect(startedFrom).toEqual([null])
    completed('turn-1')
    await h.dispose()
  })
})
