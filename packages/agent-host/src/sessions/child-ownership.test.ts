import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store, type QueuedRequest } from '../dev-services/store.js'
import { ChildOwnership, pausedReportKey, type AgentStartRecord, type Delegation } from './child-ownership.js'

/*
 * The ownership state on its own (#428): each change writes its store mirror, and an owner change moves every map in
 * one call. The session manager's tests (handoff-children, report-marks, busy-requests, delegated-cards) cover the
 * same state through the tools.
 */

let store: Store
let own: ChildOwnership

beforeEach(() => {
  store = new Store()
  own = new ChildOwnership(store)
})
afterEach(() => {
  own.stopSettling()
  store.close()
  vi.useRealTimers()
})

const delegation = (callerId: string, sessionId: string, extra: Partial<Delegation> = {}): Delegation =>
  ({ callerId, sessionId, target: { id: 'p', name: 'p', path: '/p' }, settled: false, ...extra }) as unknown as Delegation

const start = (requestId: string, callerId: string, extra: Partial<AgentStartRecord> = {}): AgentStartRecord => ({
  req: { requestId, callerId, projectId: 'p', tool: 'claude', task: 't', detail: { kind: 'agent_start', tool: 'claude', text: 't' } as never },
  detached: false,
  done: Promise.resolve(),
  end: () => {},
  ...extra,
})

const request = (id: string, sessionId: string, callerSessionId: string): QueuedRequest => ({
  id, sessionId, callerSessionId, via: 'agent_session', text: id, queuedAt: Date.now(), openedByAuto: false,
})

describe('report marks', () => {
  it('a mark is stored with it, and clearing takes both down', () => {
    own.markReport('child', 'caller')
    expect(own.awaitingReport.get('child')).toBe('caller')
    expect(store.listReportMarks()).toEqual([{ sessionId: 'child', callerSessionId: 'caller' }])
    own.clearReport('child')
    expect(own.awaitingReport.has('child')).toBe(false)
    expect(store.listReportMarks()).toEqual([])
  })

  it('a pause is stored once per new task, and a new mark drops it', () => {
    own.markReport('child', 'caller')
    own.pauseReport('child', [{ id: 't1', description: 'dev server' }])
    own.pauseReport('child', [{ id: 't1', description: 'dev server' }, { id: 't2', description: 'watcher' }])
    expect(own.pausedReports.get('child')?.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(JSON.parse(store.appSetting(pausedReportKey('child'))!)).toEqual([
      { id: 't1', description: 'dev server' },
      { id: 't2', description: 'watcher' },
    ])
    own.markReport('child', 'caller')
    expect(own.pausedReports.has('child')).toBe(false)
    expect(store.appSetting(pausedReportKey('child'))).toBeNull()
    expect(own.awaitingReport.get('child')).toBe('caller')
  })

  it('adopting a mark the previous host left writes nothing', () => {
    own.adoptReport('child', 'caller', [{ id: 't1', description: 'd' }])
    expect(own.awaitingReport.get('child')).toBe('caller')
    expect(own.pausedReports.get('child')).toEqual([{ id: 't1', description: 'd' }])
    expect(store.listReportMarks()).toEqual([])
  })

  it('unpausing ends the settle timer, and stopSettling ends them all', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    own.pauseReport('a', [])
    own.settleAfter('a', setTimeout(() => fired.push('a'), 10))
    own.settleAfter('b', setTimeout(() => fired.push('b'), 10))
    own.unpauseReport('a')
    own.stopSettling()
    vi.advanceTimersByTime(20)
    expect(fired).toEqual([])
  })
})

describe('delegated turns', () => {
  it('a turn is stored, released only by its own caller when one is named, and told cards are stored', () => {
    own.ownTurn('child', 'caller', false)
    const turnId = own.turnOwners.get('child')!.turnId
    own.markTurnTold('child', 'card-1')
    expect(store.listDelegatedTurns()).toEqual([{ sessionId: 'child', callerSessionId: 'caller', told: ['card-1'], turnId }])
    own.releaseTurn('child', 'someone-else')
    expect(own.turnOwners.has('child')).toBe(true)
    own.releaseTurn('child', 'caller')
    expect(own.turnOwners.has('child')).toBe(false)
    expect(store.listDelegatedTurns()).toEqual([])
  })
})

describe('queued requests', () => {
  it('enqueue answers the place; a delivery is marked and ends when its turn starts', () => {
    expect(own.enqueue(request('q1', 'busy', 'a'))).toBe(1)
    expect(own.enqueue(request('q2', 'busy', 'b'))).toBe(2)
    own.startDelivering('busy', 'q1')
    expect(own.delivering.get('busy')).toBe('q1')
    expect(store.listQueuedRequests().find((r) => r.id === 'q1')?.deliveringAt).toEqual(expect.any(Number))
    own.queuedTurnStarted('busy')
    expect(own.delivering.has('busy')).toBe(false)
    expect(own.queued.get('busy')?.map((r) => r.id)).toEqual(['q2'])
    expect(store.listQueuedRequests().map((r) => r.id)).toEqual(['q2'])
  })

  it('dropping the request being delivered ends its delivery; an empty queue goes', () => {
    own.enqueue(request('q1', 'busy', 'a'))
    own.startDelivering('busy', 'q1')
    expect(own.dropQueued((r) => r.callerSessionId === 'a').map((r) => r.id)).toEqual(['q1'])
    expect(own.delivering.has('busy')).toBe(false)
    expect(own.queued.has('busy')).toBe(false)
    expect(store.listQueuedRequests()).toEqual([])
  })
})

describe('moveOwner', () => {
  it('moves every map for the moving children, and leaves what is not theirs', () => {
    own.markReport('c1', 'from')
    own.markReport('stays', 'from')
    own.ownTurn('c1', 'from', false)
    own.ownTurn('stays', 'from', false)
    const d1 = delegation('from', 'c1', { agent: true })
    const d2 = delegation('from', 'c2')
    const kept = delegation('from', 'stays')
    own.setDelegation('from>c1', d1)
    own.setDelegation('from>proj>c2', d2)
    own.setDelegation('from>stays', kept)
    const note = { run: d1, waiters: 0, told: false }
    own.setObserverNote('from>c1', note)
    own.enqueue(request('q1', 'c1', 'from'))
    own.setLinkedReport('c2', { orchestratorId: 'from', busy: false })
    const made = start('r-made', 'from', { ended: { childId: 'c1' } })
    const open = start('r-open', 'from')
    own.addAgentStart(made)
    own.addAgentStart(open)

    own.moveOwner('from', 'to', { sessions: ['c1', 'c2'], armReports: ['c2'], starts: [open], queued: true }, () => {})

    expect([...own.awaitingReport]).toEqual([['c1', 'to'], ['stays', 'from'], ['c2', 'to']])
    expect(own.turnOwners.get('c1')?.callerId).toBe('to')
    expect(own.turnOwners.get('stays')?.callerId).toBe('from')
    expect([...own.delegations.keys()].sort()).toEqual(['from>stays', 'to>c1', 'to>proj>c2'])
    expect(d1.callerId).toBe('to')
    expect(kept.callerId).toBe('from')
    expect(own.observerNotes.get('to>c1')).toBe(note)
    expect(own.observerNotes.has('from>c1')).toBe(false)
    expect(own.queued.get('c1')?.[0]?.callerSessionId).toBe('to')
    expect(own.linkedReports.get('c2')?.orchestratorId).toBe('to')
    expect(made.req.callerId).toBe('to')
    // The open request's caller is the card mover's to change, with its card
    expect(open.req.callerId).toBe('from')
    expect(open.detached).toBe(true)
    expect([...own.handedOver]).toEqual([
      ['c1', { from: 'from', to: 'to' }],
      ['c2', { from: 'from', to: 'to' }],
      ['r-open', { from: 'from', to: 'to' }],
    ])
  })

  it('a removed original keeps the requests it queued', () => {
    own.enqueue(request('q1', 'c1', 'from'))
    own.moveOwner('from', 'to', { sessions: ['c1'], armReports: [], starts: [], queued: false }, () => {})
    expect(own.queued.get('c1')?.[0]?.callerSessionId).toBe('from')
  })

  it('the cards move after the maps and before the handover is recorded; then the waits on what moved end', () => {
    const order: string[] = []
    const d = delegation('from', 'c1', { leaving: new Set([() => order.push('delegation wait ended')]) })
    own.setDelegation('from>c1', d)
    const open = start('r-open', 'from', { leaving: new Set([() => order.push('start wait ended')]) })
    own.addAgentStart(open)
    own.moveOwner('from', 'to', { sessions: ['c1'], armReports: [], starts: [open], queued: true }, () => {
      order.push(`cards: delegation ${own.delegations.has('to>c1') ? 'moved' : 'not moved'}, handover ${own.handedOver.size}`)
    })
    expect(order).toEqual(['cards: delegation moved, handover 0', 'delegation wait ended', 'start wait ended'])
  })
})

describe('forgetting a session', () => {
  it('drops what a handoff gave from it or to it, and the observer notes on either side', () => {
    own.recordHandedOver('c1', 'gone', 'heir')
    own.recordHandedOver('c2', 'other', 'gone')
    own.recordHandedOver('gone', 'x', 'y')
    own.recordHandedOver('c3', 'other', 'heir')
    own.forgetHandedOver('gone')
    expect([...own.handedOver.keys()]).toEqual(['c3'])

    const run = delegation('a', 'b')
    own.setObserverNote('gone>s', { run, waiters: 0, told: false })
    own.setObserverNote('o>gone', { run, waiters: 0, told: false })
    own.setObserverNote('o>s', { run, waiters: 0, told: false })
    own.dropObserverNotesOf('gone')
    expect([...own.observerNotes.keys()]).toEqual(['o>s'])
  })

  it('drops a delegation or note only while it is the one named', () => {
    const a = delegation('c', 's')
    const b = delegation('c', 's')
    own.setDelegation('k', b)
    own.dropDelegation('k', a)
    expect(own.delegations.get('k')).toBe(b)
    own.dropDelegation('k', b)
    expect(own.delegations.has('k')).toBe(false)
    const note = { run: a, waiters: 0, told: false }
    own.setObserverNote('k', { run: b, waiters: 0, told: false })
    own.dropObserverNote('k', note)
    expect(own.observerNotes.has('k')).toBe(true)
  })
})
