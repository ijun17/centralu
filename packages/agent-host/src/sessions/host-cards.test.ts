import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import type { CapabilityQuestion } from '../apps/external/runtime.js'
import { Store } from '../dev-services/store.js'
import { HostCards, type HostAsk, type HostCardsHost } from './host-cards.js'

/*
 * The host's cards on their own (#428): one slot per session shared with the adapter's card, the next card raised when
 * the slot empties, and what an abort or a withdrawal leaves. The session manager's tests (app capabilities, project
 * access, start_agent cards, updates) run the same cards through real sessions.
 */

let store: Store
let meta: Map<string, SessionInfo>
let events: NormalizedEvent[]
let open: boolean
let cards: HostCards

const access: HostAsk['detail'] = { kind: 'project_access', access: 'delegate', from: { id: 'p1', name: 'One' }, to: { id: 'p2', name: 'Two', trusted: true }, text: 'One asks Two' }

beforeEach(() => {
  store = new Store()
  meta = new Map([['s', { id: 's', state: 'working', pendingApproval: null } as unknown as SessionInfo]])
  events = []
  open = false
  /** The manager's part, as far as the cards see it: a raised card takes the slot, a resolved one frees it */
  const host: HostCardsHost = {
    store: { upsertSession: () => {} } as unknown as Store,
    meta,
    emit: (e) => void events.push(e),
    autoBoundaryOpen: () => open,
    applyStateHint: (e, m) => {
      if (e.type === 'approval_request') m.pendingApproval = { requestId: e.requestId, detail: e.detail }
      if (e.type === 'state_change') m.state = e.state
    },
    settleState: (m, e) => {
      m.state = e.state
      events.push(e)
    },
    onEvent: (e) => {
      events.push(e)
      const m = e.sessionId ? meta.get(e.sessionId) : undefined
      if (!m) return
      if (e.type === 'approval_request') m.pendingApproval = { requestId: e.requestId, detail: e.detail }
      if (e.type === 'approval_resolved') {
        m.pendingApproval = null
        cards.raiseHostAsks(e.sessionId!)
      }
    },
  }
  cards = new HostCards(host)
})
afterEach(() => store.close())

const raised = () => events.filter((e) => e.type === 'approval_request').map((e) => (e as { requestId: string }).requestId)

describe('the approval slot', () => {
  it("an open auto boundary answers allow and raises nothing", async () => {
    open = true
    expect(await cards.askHost('s', access)).toBe('allow')
    expect(events).toEqual([])
  })

  it('one card at a time: the next is raised when the first is withdrawn, which answers it with nothing', async () => {
    const first = cards.askHost('s', access, undefined, { requestId: 'xp-1' })
    const second = cards.askHost('s', access, undefined, { requestId: 'xp-2' })
    expect(raised()).toEqual(['xp-1'])
    cards.withdrawHostAsk('xp-1')
    expect(await first).toBeNull()
    expect(events).toContainEqual({ type: 'approval_resolved', sessionId: 's', requestId: 'xp-1', decision: 'deny' })
    expect(raised()).toEqual(['xp-1', 'xp-2'])
    cards.withdrawHostAsk('xp-2')
    expect(await second).toBeNull()
    expect(cards.hostAsks.size).toBe(0)
  })

  it("an aborted call closes its standing card, and a card it never raised leaves no trace", async () => {
    const stop = new AbortController()
    const waiting = new AbortController()
    const asked = cards.askHost('s', access, stop.signal, { requestId: 'xp-1' })
    const queued = cards.askHost('s', access, waiting.signal, { requestId: 'xp-2' })
    waiting.abort()
    expect(await queued).toBeNull()
    stop.abort()
    expect(await asked).toBeNull()
    expect(events.filter((e) => e.type === 'approval_resolved')).toEqual([{ type: 'approval_resolved', sessionId: 's', requestId: 'xp-1', decision: 'deny' }])
    expect(raised()).toEqual(['xp-1'])
  })

  it('a card raised again between turns returns the session to its rest when it closes (#673)', () => {
    meta.get('s')!.state = 'idle'
    void cards.askHost('s', access, undefined, { requestId: 'ag-1', shown: true })
    expect(events.map((e) => e.type)).toEqual(['approval_request'])
    cards.withdrawHostAsk('ag-1')
    expect(events.map((e) => e.type)).toEqual(['approval_request', 'state_change', 'approval_resolved'])
    expect(events[1]).toEqual({ type: 'state_change', sessionId: 's', state: 'idle' })
  })
})

describe("the screen's capability questions (M4 D-4)", () => {
  const question = (origin: CapabilityQuestion['origin']): CapabilityQuestion =>
    ({ app: { appId: 'a1', projectId: 'p1' }, appName: 'App', capability: 'read', text: 'App reads', origin, askedAt: 1, expiresAt: 2 }) as CapabilityQuestion

  it('a chain started from a view asks the screen, and the answer goes back once', async () => {
    const answer = cards.askCapability(question({ kind: 'view', app: { appId: 'a1', projectId: 'p1' } } as CapabilityQuestion['origin']), new AbortController().signal)
    const [q] = cards.appQuestionList()
    expect(q).toMatchObject({ app: { appId: 'a1', projectId: 'p1', name: 'App' }, capability: 'read', origin: { appId: 'a1', projectId: 'p1' } })
    cards.answerAppQuestion(q!.id, 'allow')
    expect(await answer).toBe('allow')
    expect(events.filter((e) => e.type === 'external_app_questions_changed')).toHaveLength(2)
    expect(() => cards.answerAppQuestion(q!.id, 'deny')).toThrow('That question is no longer open — it timed out, or the app stopped waiting')
  })

  it("a session's chain raises the card in that session, and its always is an allow", async () => {
    const answer = cards.askCapability(question({ kind: 'session', sessionId: 's' } as CapabilityQuestion['origin']), new AbortController().signal)
    const [id] = raised()
    cards.hostAsks.get(id!)!.resolve('always')
    expect(await answer).toBe('allow')
  })
})
