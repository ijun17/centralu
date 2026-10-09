import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * The bug where stop did not work (dogfooding 2026-09-07: "only the tool call stops, and a few
 * seconds later it starts again").
 *
 * The measured cause was one line — `turn/interrupt` was sent with only threadId, and the server
 * **rejected** it with `Invalid request: missing field \`turnId\`` (-32600). That rejection was
 * only piped into an error event, and the turn ran to completion. So there is exactly one thing
 * checked here: **which turn does the stop command point at.**
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
  handlers: null as null | {
    onNotification: (n: { method: string; params?: unknown }) => void
    onServerRequest: (r: { id: number | string; method: string; params?: unknown }) => void
  },
  /** The turn to load into the turn/start response (the test decides whether the notification or the response comes first) */
  startTurnId: null as string | null,
  /** When set, the turn/start response waits until the test calls it */
  holdStart: null as null | ((release: () => void) => void),
  /** What the adapter answered to the server's requests */
  responses: [] as { id: number | string; result: unknown }[],
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: NonNullable<typeof state.handlers>) {
      state.handlers = handlers
    }
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      if (method === 'turn/start' && state.startTurnId) {
        const res = { turn: { id: state.startTurnId } }
        const hold = state.holdStart
        if (hold) return new Promise((resolve) => hold(() => resolve(res)))
        return Promise.resolve(res)
      }
      return Promise.resolve({})
    }
    notify(): void {}
    respond(id: number | string, result: unknown): void {
      state.responses.push({ id, result })
    }
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const tick = () => new Promise((r) => setTimeout(r, 0))
const interrupts = () => state.requests.filter((r) => r.method === 'turn/interrupt')

beforeEach(() => {
  state.requests.length = 0
  state.responses.length = 0
  state.startTurnId = null
  state.holdStart = null
})

async function session(events: NormalizedEvent[] = []) {
  const adapter = new CodexAdapter()
  return adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
}

describe('codex stop — must point at the running turn to work', () => {
  it('takes the turn turn/started reported as the target', async () => {
    const h = await session()
    h.send('a long-running task')
    await tick()
    state.handlers!.onNotification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn-7' } } })

    h.interrupt()
    expect(interrupts()[0]?.params).toEqual({ threadId: 't1', turnId: 'turn-7' })
  })

  it('stops even when the response arrives before the notification — the case of pressing it very quickly', async () => {
    state.startTurnId = 'turn-9'
    const h = await session()
    h.send('a long-running task')
    await tick()
    await tick()

    h.interrupt()
    expect(interrupts()[0]?.params).toEqual({ threadId: 't1', turnId: 'turn-9' })
  })

  it('a stop after the turn has ended sends nothing anywhere — stopping an ended turn would just come back rejected', async () => {
    const h = await session()
    h.send('a quick task')
    await tick()
    state.handlers!.onNotification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn-7' } } })
    state.handlers!.onNotification({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn-7' } } })

    h.interrupt()
    expect(interrupts()).toHaveLength(0)
  })

  /*
   * A short turn can end before its own turn/start response arrives. Taking the id from that late response made the
   * finished turn the target of the next Stop, which sent turn/interrupt for a dead turn and showed "Could not stop".
   */
  it('a turn/start response that arrives after its turn ended does not bring the turn back as the target', async () => {
    state.startTurnId = 'turn-5'
    let release: () => void = () => {}
    state.holdStart = (r) => (release = r)
    const h = await session()
    h.send('a quick task')
    await tick()
    state.handlers!.onNotification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn-5' } } })
    state.handlers!.onNotification({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn-5' } } })
    release()
    await tick()

    h.interrupt()
    expect(interrupts()).toHaveLength(0)
  })

  it('stays quiet when pressed on a session that has never sent anything', async () => {
    const h = await session()
    h.interrupt()
    expect(interrupts()).toHaveLength(0)
  })
})

/**
 * An approval card closes when Codex ends its request. Codex ends a request itself when its turn is interrupted or
 * ends, and says so with `serverRequest/resolved`; the card used to stay open with no `approval_resolved`, and an
 * answer went to a request id nobody was waiting on.
 */
describe('codex approval cards close with their request', () => {
  const approval = (id: number, threadId = 't1', turnId = 'turn-7') => ({
    id,
    method: 'item/commandExecution/requestApproval',
    params: { threadId, turnId, itemId: `item-${id}`, command: 'rm -rf build' },
  })
  const asked = (events: NormalizedEvent[]) =>
    events.filter((e): e is Extract<NormalizedEvent, { type: 'approval_request' }> => e.type === 'approval_request').map((e) => e.requestId)
  const closed = (events: NormalizedEvent[]) =>
    events.filter((e): e is Extract<NormalizedEvent, { type: 'approval_resolved' }> => e.type === 'approval_resolved').map((e) => e.requestId)

  async function running(events: NormalizedEvent[]) {
    const h = await session(events)
    h.send('a long-running task')
    await tick()
    state.handlers!.onNotification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn-7' } } })
    return h
  }

  it('Stop with a card open refuses it to Codex and closes the card, so a late answer reaches nothing', async () => {
    const events: NormalizedEvent[] = []
    const h = await running(events)
    state.handlers!.onServerRequest(approval(41))
    const [card] = asked(events)

    h.interrupt()
    expect(closed(events)).toEqual([card])
    expect(events.find((e) => e.type === 'approval_resolved')).toMatchObject({ decision: 'deny' })
    expect(state.responses).toEqual([{ id: 41, result: { decision: 'decline' } }])
    expect(interrupts()).toHaveLength(1)
    expect(h.respondApproval(card!, 'allow')).toBe(false)
    expect(state.responses).toHaveLength(1)
  })

  it('serverRequest/resolved closes the card it names, and only that one', async () => {
    const events: NormalizedEvent[] = []
    const h = await running(events)
    state.handlers!.onServerRequest(approval(41))
    state.handlers!.onServerRequest(approval(42))
    const [first, second] = asked(events)

    state.handlers!.onNotification({ method: 'serverRequest/resolved', params: { threadId: 't1', requestId: 41 } })
    expect(closed(events)).toEqual([first])
    expect(h.respondApproval(first!, 'allow')).toBe(false)
    expect(state.responses).toEqual([])
    expect(h.respondApproval(second!, 'allow')).toBe(true)
  })

  it('the resolved notice for a card we answered closes nothing twice', async () => {
    const events: NormalizedEvent[] = []
    const h = await running(events)
    state.handlers!.onServerRequest(approval(41))
    h.respondApproval(asked(events)[0]!, 'allow')
    state.handlers!.onNotification({ method: 'serverRequest/resolved', params: { threadId: 't1', requestId: 41 } })
    expect(closed(events)).toHaveLength(1)
  })

  it("a turn that ends closes its own cards, and a child thread's card stays open until its own turn ends", async () => {
    const events: NormalizedEvent[] = []
    const h = await running(events)
    state.handlers!.onServerRequest(approval(41))
    state.handlers!.onServerRequest(approval(42, 'child-1', 'child-turn'))
    const [parent, child] = asked(events)

    state.handlers!.onNotification({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn-7' } } })
    expect(closed(events)).toEqual([parent])

    state.handlers!.onNotification({ method: 'turn/completed', params: { threadId: 'child-1', turn: { id: 'child-turn' } } })
    expect(closed(events)).toEqual([parent, child])
    expect(h.respondApproval(child!, 'allow')).toBe(false)
  })

  it("Stop leaves a child thread's card open: stopping the parent's turn does not stop the child", async () => {
    const events: NormalizedEvent[] = []
    const h = await running(events)
    state.handlers!.onServerRequest(approval(42, 'child-1', 'child-turn'))
    h.interrupt()
    expect(closed(events)).toEqual([])
    expect(state.responses).toEqual([])
  })
})
