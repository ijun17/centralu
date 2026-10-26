import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '@cc/protocol'
import { Store, type QueuedRequest } from '../dev-services/store.js'
import { MailService } from '../mail/service.js'
import { ChildOwnership, pausedReportKey, reportTurnKey, type AgentStartRecord, type Delegation } from './child-ownership.js'

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
    expect(store.children.listReportMarks()).toEqual([{ sessionId: 'child', callerSessionId: 'caller' }])
    own.clearReport('child')
    expect(own.awaitingReport.has('child')).toBe(false)
    expect(store.children.listReportMarks()).toEqual([])
  })

  it('a pause is stored once per new task, and a new mark drops it', () => {
    own.markReport('child', 'caller')
    own.pauseReport('child', [{ id: 't1', description: 'dev server' }])
    own.pauseReport('child', [{ id: 't1', description: 'dev server' }, { id: 't2', description: 'watcher' }])
    expect(own.pausedReports.get('child')?.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(JSON.parse(store.settings.appSetting(pausedReportKey('child'))!)).toEqual([
      { id: 't1', description: 'dev server' },
      { id: 't2', description: 'watcher' },
    ])
    own.markReport('child', 'caller')
    expect(own.pausedReports.has('child')).toBe(false)
    expect(store.settings.appSetting(pausedReportKey('child'))).toBeNull()
    expect(own.awaitingReport.get('child')).toBe('caller')
  })

  it('adopting a mark the previous host left writes nothing', () => {
    own.adoptReport('child', 'caller', [{ id: 't1', description: 'd' }])
    expect(own.awaitingReport.get('child')).toBe('caller')
    expect(own.pausedReports.get('child')).toEqual([{ id: 't1', description: 'd' }])
    expect(store.children.listReportMarks()).toEqual([])
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
    expect(store.children.listDelegatedTurns()).toEqual([{ sessionId: 'child', callerSessionId: 'caller', told: ['card-1'], turnId }])
    own.releaseTurn('child', 'someone-else')
    expect(own.turnOwners.has('child')).toBe(true)
    own.releaseTurn('child', 'caller')
    expect(own.turnOwners.has('child')).toBe(false)
    expect(store.children.listDelegatedTurns()).toEqual([])
  })
})

describe('the mailbox hears of a turn that starts (docs/plans/mailbox.md §6)', () => {
  const heard = () => {
    const turns: { sessionId: string; by: string; added: boolean; cli: boolean; source: string; ownerId?: string }[] = []
    own.onTurnStarted((sessionId, turn) => void turns.push({ sessionId, ...turn }))
    return turns
  }

  it('says whose the turn is, and the caller it is the work of: the one whose turn it is with a delegation going, else the one a report is owed to', () => {
    const turns = heard()
    own.ownTurn('a', 'caller', false)
    own.setDelegation('caller>a', delegation('caller', 'a'))
    own.noteMessage('a', 'work', false, false)
    own.turnStarted('a')
    own.markReport('b', 'owner')
    own.noteMessage('b', 'work', false, false)
    own.turnStarted('b')
    own.noteMessage('c', 'work', false, false)
    own.turnStarted('c')
    expect(turns).toEqual([
      { sessionId: 'a', by: 'work', added: false, cli: false, source: 'caller', ownerId: 'caller' },
      { sessionId: 'b', by: 'work', added: false, cli: false, source: 'caller', ownerId: 'owner' },
      { sessionId: 'c', by: 'work', added: false, cli: false, source: 'caller' },
    ])
  })

  it('names no caller for a turn given with no report asked for: it is nobody’s work to report', () => {
    const turns = heard()
    // The orchestrator’s send_to_session with reportBack false: it owns the turn’s cards, and no mark or delegation is left
    own.ownTurn('a', 'orchestrator', true)
    own.noteMessage('a', 'work', false, false)
    own.turnStarted('a')
    // And a delegation that has settled is over
    own.ownTurn('b', 'caller', false)
    own.setDelegation('caller>b', delegation('caller', 'b', { settled: true }))
    own.noteMessage('b', 'work', false, false)
    own.turnStarted('b')
    expect(turns.map((t) => t.ownerId)).toEqual([undefined, undefined])
  })

  it('says a turn no message started is the CLI’s own, the person’s message is theirs, and adding to the task is the work’s with the addition', () => {
    const turns = heard()
    own.markReport('a', 'owner')
    own.turnStarted('a')
    own.noteMessage('b', 'person', false, false)
    own.turnStarted('b')
    own.markReport('c', 'owner')
    own.noteMessage('c', 'person', false, false, true)
    own.turnStarted('c')
    expect(turns).toEqual([
      { sessionId: 'a', by: 'work', added: false, cli: true, source: 'caller', ownerId: 'owner' },
      { sessionId: 'b', by: 'person', added: false, cli: false, source: 'caller' },
      { sessionId: 'c', by: 'work', added: true, cli: false, source: 'caller', ownerId: 'owner' },
    ])
  })

  it('says what the work’s message was: a caller’s send, a report about another session, an app’s; the first of the messages of one turn says, and a stale one is forgotten', () => {
    const turns = heard()
    own.noteMessage('a', 'work', false, false, false, undefined, 'report')
    own.turnStarted('a')
    own.noteMessage('b', 'work', false, false, false, undefined, 'app')
    own.noteMessage('b', 'work', false, false, false, undefined, 'report')
    own.turnStarted('b')
    // The person’s message first, then a report: the turn is the work’s, and the report is what started it
    own.noteMessage('c', 'person', false, false)
    own.noteMessage('c', 'work', false, false, false, undefined, 'report')
    own.turnStarted('c')
    // Into a running turn, a message the tool did not take in is the next turn’s, and keeps what it was
    own.noteMessage('d', 'work', true, true, false, 'in-1', 'report')
    own.turnEnded('d', [])
    own.turnStarted('d')
    // No message at all: the CLI’s own, never the source of a message long gone
    own.noteMessage('e', 'work', false, false, false, undefined, 'report')
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
    own.turnStarted('e')
    // A message that no turn started from goes stale, and its source with it: the next message says what the next turn is
    own.noteMessage('f', 'work', false, false, false, undefined, 'report')
    vi.advanceTimersByTime(60_000)
    own.noteMessage('f', 'work', false, false, false, undefined, 'app')
    own.turnStarted('f')
    expect(turns.map((t) => [t.sessionId, t.source, t.cli])).toEqual([
      ['a', 'report', false],
      ['b', 'app', false],
      ['c', 'report', false],
      ['d', 'report', false],
      ['e', 'caller', true],
      ['f', 'app', false],
    ])
  })

  it('never breaks the turn when the mailbox fails', () => {
    own.onTurnStarted(() => {
      throw new Error('the store is busy')
    })
    expect(() => own.turnStarted('a')).not.toThrow()
    expect(own.starterOf('a')).toEqual({ by: 'work' })
  })
})

describe('the mailbox hears that a call returned an answer (docs/plans/mailbox.md §8.1)', () => {
  it('is told who read what, and never breaks the call when the mailbox fails', () => {
    const seen: unknown[] = []
    own.onAnswered((callerId, childId, how) => void seen.push([callerId, childId, how]))
    own.answered('caller', 'child', { ok: true, text: 'done' })
    own.answered('caller', 'child')
    own.answered('same', 'same', { ok: true, text: 'itself' })
    expect(seen).toEqual([
      ['caller', 'child', { ok: true, text: 'done' }],
      ['caller', 'child', undefined],
    ])
    own.onAnswered(() => {
      throw new Error('the store is busy')
    })
    expect(() => own.answered('caller', 'child', { ok: true, text: 'x' })).not.toThrow()
  })
})

describe('the mailbox hears that a session is done with work it gave', () => {
  it('is told who deleted whose work, and never breaks the delete when the mailbox fails', () => {
    const seen: unknown[] = []
    own.onFinishedWith((callerId, childId) => void seen.push([callerId, childId]))
    own.finishedWith('caller', 'child')
    own.finishedWith('same', 'same')
    expect(seen).toEqual([['caller', 'child']])
    own.onFinishedWith(() => {
      throw new Error('the store is busy')
    })
    expect(() => own.finishedWith('caller', 'child')).not.toThrow()
  })
})

describe('the mailbox counts the work a session handed on', () => {
  it('is asked for the owner and the session, is 0 without a mailbox, and never breaks a report when the mailbox fails', () => {
    expect(own.waitingOn('caller', 'child')).toBe(0)
    const seen: unknown[] = []
    own.onWaitingOn((ownerId, childId) => {
      seen.push([ownerId, childId])
      return 2
    })
    expect(own.waitingOn('caller', 'child')).toBe(2)
    expect(seen).toEqual([['caller', 'child']])
    own.onWaitingOn(() => {
      throw new Error('the store is busy')
    })
    expect(own.waitingOn('caller', 'child')).toBe(0)
  })
})

describe('queued requests', () => {
  it('enqueue answers the place; a delivery is marked and ends when its turn starts', () => {
    expect(own.enqueue(request('q1', 'busy', 'a'))).toBe(1)
    expect(own.enqueue(request('q2', 'busy', 'b'))).toBe(2)
    own.startDelivering('busy', 'q1')
    expect(own.delivering.get('busy')).toBe('q1')
    expect(store.children.listQueuedRequests().find((r) => r.id === 'q1')?.deliveringAt).toEqual(expect.any(Number))
    own.queuedTurnStarted('busy')
    expect(own.delivering.has('busy')).toBe(false)
    expect(own.queued.get('busy')?.map((r) => r.id)).toEqual(['q2'])
    expect(store.children.listQueuedRequests().map((r) => r.id)).toEqual(['q2'])
  })

  it('dropping the request being delivered ends its delivery; an empty queue goes', () => {
    own.enqueue(request('q1', 'busy', 'a'))
    own.startDelivering('busy', 'q1')
    expect(own.dropQueued((r) => r.callerSessionId === 'a').map((r) => r.id)).toEqual(['q1'])
    expect(own.delivering.has('busy')).toBe(false)
    expect(own.queued.has('busy')).toBe(false)
    expect(store.children.listQueuedRequests()).toEqual([])
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

describe('restoring what the previous host left (#646, #676, #677)', () => {
  const at = (id: string, state: SessionInfo['state']) => ({ id, state }) as SessionInfo
  const sessions = new Map([
    ['kept-working', at('kept-working', 'working')],
    ['kept-paused', at('kept-paused', 'idle')],
    ['kept-idle', at('kept-idle', 'idle')],
    ['gone-process', at('gone-process', 'idle')],
    ['caller', at('caller', 'idle')],
  ])
  const kept = new Set(['kept-working', 'kept-paused', 'kept-idle'])

  it("keeps the report marks a kept session still owes, a paused one's too, and drops the rest from the store", () => {
    for (const id of ['kept-working', 'kept-paused', 'kept-idle', 'gone-process']) store.children.setReportMark(id, 'caller')
    store.children.setReportMark('kept-working-no-caller', 'nobody')
    store.settings.setAppSetting(pausedReportKey('kept-paused'), JSON.stringify([{ id: 't1', description: 'dev server' }]))
    store.settings.setAppSetting(pausedReportKey('gone-process'), '[]')
    own.restoreReports(sessions, kept)
    expect([...own.awaitingReport].sort()).toEqual([['kept-paused', 'caller'], ['kept-working', 'caller']])
    expect(own.pausedReports.get('kept-paused')).toEqual([{ id: 't1', description: 'dev server' }])
    expect(store.children.listReportMarks().map((r) => r.sessionId).sort()).toEqual(['kept-paused', 'kept-working'])
    expect(store.settings.appSetting(pausedReportKey('gone-process'))).toBeNull()
  })

  describe('a session at rest that waits for threads it handed on (§6)', () => {
    const HOST = 'hub-aaaaaaaa'
    /** The caller gave 'kept-idle' work; in it, 'kept-idle' handed a part on to 'helper' */
    const handedOn = () => {
      const mail = new MailService(store.mail, { hostId: () => HOST })
      const addr = (id: string) => mail.sessionAddress(id)
      const work = mail.recordDelegation(addr('caller'), { assignee: addr('kept-idle'), task: 'Land it', origin: 'start_agent' }).thread
      const part = mail.recordDelegation(addr('kept-idle'), { assignee: addr('helper'), task: 'The tests', origin: 'start_agent', parentId: work.id }).thread
      store.children.setReportMark('kept-idle', 'caller')
      return { mail, addr, work, part }
    }

    it('keeps its mark with the swap: the threads are in the store, and the turn their end starts ends under this host', () => {
      handedOn()
      own.restoreReports(sessions, kept)
      expect(own.awaitingReport.get('kept-idle')).toBe('caller')
      expect(store.children.listReportMarks()).toEqual([{ sessionId: 'kept-idle', callerSessionId: 'caller' }])
    })

    /** Whether a fresh host, started now with these sessions kept, still owes the report */
    let lastHost = own
    const owed = (keptNow: ReadonlySet<string> = kept, sessionsNow: ReadonlyMap<string, SessionInfo> = sessions) => {
      store.children.setReportMark('kept-idle', 'caller')
      lastHost = new ChildOwnership(store)
      lastHost.restoreReports(sessionsNow, keptNow)
      return lastHost.awaitingReport.get('kept-idle') === 'caller'
    }

    it('drops it when nothing is going: the helper’s thread is over, or nobody is on it', () => {
      const { mail, addr, part } = handedOn()
      // Going, it is kept
      expect(owed()).toBe(true)
      mail.update(part.id, addr('kept-idle'), { state: 'done', outcome: 'finished' })
      expect(owed()).toBe(false)
      const other = handedOn()
      expect(owed()).toBe(true)
      other.mail.sessionGone('helper')
      expect(owed()).toBe(false)
    })

    it('drops it when the work itself is over, whatever its helper does', () => {
      const { mail, addr, work } = handedOn()
      expect(owed()).toBe(true)
      mail.update(work.id, addr('caller'), { state: 'done', outcome: 'dropped' })
      expect(owed()).toBe(false)
    })

    it('keeps it for a session with no process too (asleep, or the host was quit): the work is the helpers’, and their report wakes it', () => {
      const { mail, addr, part } = handedOn()
      store.settings.setAppSetting(pausedReportKey('kept-idle'), JSON.stringify([{ id: 't1', description: 'dev server' }]))
      expect(owed(new Set())).toBe(true)
      // What its process held went with it
      expect(store.settings.appSetting(pausedReportKey('kept-idle'))).toBeNull()
      expect(lastHost.pausedReports.has('kept-idle')).toBe(false)
      // With nothing going, a session whose process was not kept loses its mark as it did
      mail.update(part.id, addr('kept-idle'), { state: 'done', outcome: 'finished' })
      expect(owed(new Set())).toBe(false)
      expect(store.children.listReportMarks()).toEqual([])
    })

    it('drops it when the caller is gone: nobody is left to be told', () => {
      handedOn()
      expect(owed()).toBe(true)
      const withoutCaller = new Map([...sessions].filter(([id]) => id !== 'caller'))
      expect(owed(kept, withoutCaller)).toBe(false)
      expect(owed(new Set(), withoutCaller)).toBe(false)
      // A kept session's pause on its own background work is dropped with it
      store.settings.setAppSetting(pausedReportKey('kept-idle'), JSON.stringify([{ id: 't1', description: 'dev server' }]))
      expect(owed()).toBe(true)
      store.settings.setAppSetting(pausedReportKey('kept-idle'), JSON.stringify([{ id: 't1', description: 'dev server' }]))
      expect(owed(kept, withoutCaller)).toBe(false)
    })

    it('does not keep it for a session that is in a turn and whose process was not kept: the turn was lost with the host', () => {
      handedOn()
      expect(owed(new Set())).toBe(true)
      const working = new Map(sessions).set('kept-idle', at('kept-idle', 'working'))
      expect(owed(new Set(), working)).toBe(false)
    })

    it('reads the latest thread of the pair: an old one that is done does not hide the new one that is going', () => {
      const { mail, addr, work } = handedOn()
      mail.update(work.id, addr('caller'), { state: 'done', outcome: 'finished' })
      expect(owed()).toBe(false)
      const next = mail.recordDelegation(addr('caller'), { assignee: addr('kept-idle'), task: 'More work', origin: 'start_agent' }).thread
      expect(next.id).not.toBe(work.id)
      mail.recordDelegation(addr('kept-idle'), { assignee: addr('helper2'), task: 'Its part', origin: 'start_agent', parentId: next.id })
      expect(owed()).toBe(true)
    })
  })

  it('keeps the delegated turn of a kept session still in it, ending with that turn', () => {
    store.children.setDelegatedTurn('kept-working', 'caller', 'turn-1')
    store.children.setDelegatedTurnTold('kept-working', ['card-1'])
    store.children.setDelegatedTurn('kept-idle', 'caller', 'turn-2')
    own.restoreTurns(sessions, kept)
    expect(own.turnOwners.get('kept-working')).toEqual({ callerId: 'caller', untilTurnEnd: true, told: new Set(['card-1']), turnId: 'turn-1' })
    expect(own.turnOwners.has('kept-idle')).toBe(false)
    expect(store.children.listDelegatedTurns().map((r) => r.sessionId)).toEqual(['kept-working'])
  })

  it('keeps every queued request whose sessions exist, delivers a half-delivered one again, and reads an old row', () => {
    own.enqueue(request('q1', 'kept-idle', 'caller'))
    own.enqueue(request('q2', 'kept-idle', 'nobody'))
    own.enqueue({ ...request('q3', 'gone-process', 'caller'), via: 'ask_project' })
    store.children.markQueuedDelivering('q1', 5)
    ;(store as unknown as { db: { prepare(sql: string): { run(): void } } }).db.prepare("UPDATE queued_requests SET opened_by_auto = NULL WHERE id = 'q3'").run()
    const next = new ChildOwnership(store)
    const read: string[] = []
    next.restoreQueued(sessions, (r) => (read.push(r.id), true))
    expect(next.queued.get('kept-idle')?.map((r) => [r.id, r.deliveringAt])).toEqual([['q1', null]])
    expect(next.queued.get('gone-process')?.map((r) => [r.id, r.openedByAuto])).toEqual([['q3', true]])
    expect(read).toEqual(['q3'])
    expect(store.children.listQueuedRequests().map((r) => [r.id, r.deliveringAt]).sort()).toEqual([['q1', null], ['q3', null]])
  })
})

/*
 * Whose a turn is (#1377): recorded when it starts, from the message it started with, and read when it ends. The rows are
 * the issue's table; the host-level runs (paused-reports, report-marks) go through the manager.
 */
describe('whose a turn is', () => {
  it("the person at rest: the next turn is theirs; none recorded or the CLI's own: the work's", () => {
    own.noteMessage('s', 'person', false, true)
    own.turnStarted('s')
    expect(own.turnEnded('s')).toEqual({ by: 'person' })
    // No message: the CLI started it (the work's tasks ended)
    own.turnStarted('s')
    expect(own.turnEnded('s')).toEqual({ by: 'work' })
    // A turn never started reads as the work's: what an older build left
    expect(own.turnEnded('s')).toEqual({ by: 'work' })
  })

  it("a caller's, an app's or Centralu's message makes it the work's, also with the person's behind it", () => {
    own.noteMessage('s', 'work', false, true)
    own.noteMessage('s', 'person', false, true)
    own.turnStarted('s')
    expect(own.turnEnded('s')).toEqual({ by: 'work', wrote: true })
  })

  it('the person into a running turn of the work: noted; into their own: nothing; "add to the task": noted as such', () => {
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    own.noteMessage('s', 'person', true, true)
    // Decided at the turn's end: a tool that takes every message into the running turn (no list of what it took)
    own.noteMessage('s', 'person', true, true, true)
    expect(own.turnEnded('s')).toEqual({ by: 'work', wrote: true, added: true })
    own.noteMessage('s', 'person', false, true)
    own.turnStarted('s')
    own.noteMessage('s', 'person', true, true)
    expect(own.turnEnded('s')).toEqual({ by: 'person' })
  })

  // The tool names the inputs a turn took (Claude's result): a message it did not take is the next turn's
  it("a message the turn did not take in is the next turn's, theirs; one it took in is noted on this", () => {
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    own.noteMessage('s', 'person', true, true, false, 'in')
    own.noteMessage('s', 'person', true, true, false, 'held')
    expect(own.turnEnded('s', ['in'])).toEqual({ by: 'work', wrote: true })
    own.turnStarted('s')
    expect(own.turnEnded('s', ['held'])).toEqual({ by: 'person' })
  })

  it('a tool that cannot name them (null) takes none in; naming none (an empty list) takes none in either', () => {
    for (const taken of [null, []] as const) {
      own.noteMessage('s', 'work', false, true)
      own.turnStarted('s')
      own.noteMessage('s', 'person', true, true, false, 'm')
      expect(own.turnEnded('s', taken)).toEqual({ by: 'work' })
      own.turnStarted('s')
      expect(own.turnEnded('s')).toEqual({ by: 'person' })
    }
  })

  it("a person's message into their own turn that was not taken in is theirs after it too, and the caller's is the work's", () => {
    own.noteMessage('s', 'person', false, true)
    own.turnStarted('s')
    own.noteMessage('s', 'person', true, true, false, 'again')
    expect(own.turnEnded('s', [])).toEqual({ by: 'person' })
    own.turnStarted('s')
    expect(own.turnEnded('s', ['again'])).toEqual({ by: 'person' })
    own.noteMessage('s', 'person', false, true)
    own.turnStarted('s')
    own.noteMessage('s', 'work', true, true, false, 'caller')
    expect(own.turnEnded('s', [])).toEqual({ by: 'person' })
    own.turnStarted('s')
    expect(own.turnEnded('s')).toEqual({ by: 'work' })
  })

  it("messages not yet taken in are kept for the next host, with the turn's starter", () => {
    own.markReport('s', 'caller')
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    own.noteMessage('s', 'person', true, true, false, 'held')
    expect(JSON.parse(store.settings.appSetting(reportTurnKey('s'))!)).toEqual({ by: 'work', pending: [{ id: 'held', by: 'person' }] })
    const next = new ChildOwnership(store)
    next.adoptReport('s', 'caller', null)
    expect(next.turnEnded('s', [])).toEqual({ by: 'work' })
    next.turnStarted('s')
    expect(next.turnEnded('s', ['held'])).toEqual({ by: 'person' })
  })

  it("add to the task, at rest, makes the turn the work's, noted as their addition", () => {
    own.noteMessage('s', 'person', false, true, true)
    own.turnStarted('s')
    expect(own.turnEnded('s')).toEqual({ by: 'work', added: true })
  })

  it("a tool that holds a message for the turn after: the running turn stays as it was, and the next is the person's", () => {
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    own.noteMessage('s', 'person', true, false)
    expect(own.turnEnded('s')).toEqual({ by: 'work' })
    own.turnStarted('s')
    expect(own.turnEnded('s')).toEqual({ by: 'person' })
  })

  it('taking the session over makes the running turn theirs', () => {
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    own.takeTurn('s')
    expect(own.turnEnded('s')).toEqual({ by: 'person' })
  })

  it('is kept in the store while a report is owed, read back by the next host, and dropped with the report', () => {
    own.noteMessage('s', 'person', false, true)
    own.turnStarted('s')
    expect(store.settings.appSetting(reportTurnKey('s'))).toBeNull()
    // The mark is set during their turn: the turn is kept from then on
    own.markReport('s', 'caller')
    expect(JSON.parse(store.settings.appSetting(reportTurnKey('s'))!)).toEqual({ by: 'person' })
    const next = new ChildOwnership(store)
    next.adoptReport('s', 'caller', null)
    expect(next.starterOf('s')).toEqual({ by: 'person' })
    own.clearReport('s')
    expect(store.settings.appSetting(reportTurnKey('s'))).toBeNull()
  })

  it("a message that no turn started from goes stale, and the next message starts afresh", () => {
    vi.useFakeTimers()
    own.noteMessage('s', 'person', false, true)
    // The tool answered it itself (a command that is not a turn); a caller's message comes later
    vi.advanceTimersByTime(20_000)
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    expect(own.turnEnded('s')).toEqual({ by: 'work' })
    // And a turn that starts from a stale note reads as the CLI's own
    own.noteMessage('s', 'person', false, true)
    vi.advanceTimersByTime(20_000)
    own.turnStarted('s')
    expect(own.turnEnded('s')).toEqual({ by: 'work' })
  })

  it("two messages before the turn starts make one turn: the work's if either is", () => {
    own.noteMessage('s', 'person', false, true)
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    expect(own.turnEnded('s')).toEqual({ by: 'work', wrote: true })
    own.noteMessage('s', 'work', false, true)
    own.noteMessage('s', 'person', false, true, true)
    own.turnStarted('s')
    expect(own.turnEnded('s')).toEqual({ by: 'work', added: true })
    own.noteMessage('s', 'person', false, true)
    own.noteMessage('s', 'person', false, true)
    own.turnStarted('s')
    expect(own.turnEnded('s')).toEqual({ by: 'person' })
  })

  it("a turn's end takes its record down, and an unreadable one reads as nothing", () => {
    own.markReport('s', 'caller')
    own.turnStarted('s')
    expect(store.settings.appSetting(reportTurnKey('s'))).not.toBeNull()
    own.turnEnded('s')
    expect(store.settings.appSetting(reportTurnKey('s'))).toBeNull()
    store.settings.setAppSetting(reportTurnKey('t'), 'not json')
    const next = new ChildOwnership(store)
    next.adoptReport('t', 'caller', null)
    expect(next.starterOf('t')).toBeUndefined()
  })
})

// #1604: a sender's note into a running turn that the tool runs as the next turn is named back by the turn that opens
describe('what a turn that opens ran for', () => {
  const note = { seq: 7, from: { sessionId: '_hub-orchestrator', name: 'Parent' } }

  it('names the sender and row of the note the turn opens for, once', () => {
    own.noteInputOrigin('s', 'note-id', note)
    expect(own.takeInputOrigin('s', ['other-id', 'note-id'])).toEqual(note)
    expect(own.takeInputOrigin('s', ['note-id'])).toBeUndefined()
  })

  it('names nothing for a turn the tool opens with no input of a sender, or when the tool does not say', () => {
    own.noteInputOrigin('s', 'note-id', note)
    expect(own.takeInputOrigin('s', [])).toBeUndefined()
    expect(own.takeInputOrigin('s', null)).toBeUndefined()
    expect(own.takeInputOrigin('s', undefined)).toBeUndefined()
    expect(own.takeInputOrigin('s', ['note-id'])).toEqual(note)
  })

  it('forgets a note the turn it went into took in: no later turn opens for it', () => {
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    own.noteMessage('s', 'work', true, true, false, 'note-id')
    own.noteInputOrigin('s', 'note-id', note)
    own.turnEnded('s', ['note-id'])
    expect(own.takeInputOrigin('s', ['note-id'])).toBeUndefined()
  })

  it('keeps a note the turn did not take in, for the turn the tool runs it as', () => {
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    own.noteMessage('s', 'work', true, true, false, 'note-id')
    own.noteInputOrigin('s', 'note-id', note)
    own.turnEnded('s', [])
    expect(own.takeInputOrigin('s', ['note-id'])).toEqual(note)
  })

  it('takes off every note given before the last one a turn names: the tool runs them in order, and says only the last of a batch', () => {
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) own.noteInputOrigin('s', id, { ...note, seq: 10 + i })
    expect(own.takeInputOrigin('s', ['c'])).toEqual({ ...note, seq: 12 })
    // None of the batch is left, and the one given after it still is
    expect(own.takeInputOrigin('s', ['a'])).toBeUndefined()
    expect(own.takeInputOrigin('s', ['b'])).toBeUndefined()
    expect(own.takeInputOrigin('s', ['d'])).toEqual({ ...note, seq: 13 })
  })

  it("takes off a batch a turn took in at its end too, and keeps what was given after the last it names", () => {
    own.noteInputOrigin('s', 'task', { ...note, seq: 1 })
    own.noteInputOrigin('s', 'note-1', { ...note, seq: 2 })
    own.noteInputOrigin('s', 'note-2', { ...note, seq: 3 })
    own.turnEnded('s', ['note-1'])
    expect(own.takeInputOrigin('s', ['task'])).toBeUndefined()
    expect(own.takeInputOrigin('s', ['note-2'])).toEqual({ ...note, seq: 3 })
  })

  it('also names a message given at rest, for the turn the tool opens for it after another', () => {
    own.noteInputOrigin('s', 'at-rest', { ...note, seq: 5 })
    expect(own.takeInputOrigin('s', ['at-rest'])).toEqual({ ...note, seq: 5 })
  })

  it('keeps what a tool that does not name its inputs may still run as a turn after the one it was sent into', () => {
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    own.noteMessage('s', 'work', true, true, false, 'note-id')
    own.noteInputOrigin('s', 'note-id', note)
    // Codex: every message sent to a running turn is taken to have joined it, yet one it ran as a turn after is named when that turn opens
    own.turnEnded('s', undefined)
    expect(own.takeInputOrigin('s', ['note-id'])).toEqual(note)
  })

  it('keeps them across a host swap: a host that takes over the session still says whose message the turn it runs is for', () => {
    own.noteInputOrigin('s', 'note-id', note)
    const next = new ChildOwnership(store)
    expect(next.takeInputOrigin('s', ['note-id'])).toEqual(note)
    // And what it took off stays off for the one after it
    expect(new ChildOwnership(store).takeInputOrigin('s', ['note-id'])).toBeUndefined()
  })

  it('keeps the most recent sixty-four a session was given, not every one for the life of the session', () => {
    for (let i = 0; i < 70; i++) own.noteInputOrigin('s', `id-${i}`, { ...note, seq: i })
    expect(new ChildOwnership(store).takeInputOrigin('s', ['id-0'])).toBeUndefined()
    expect(new ChildOwnership(store).takeInputOrigin('s', ['id-69'])).toEqual({ ...note, seq: 69 })
  })

  it('says where the running turn and the one before it began, for a hub to read the answer of that turn', () => {
    own.noteTurnStart('s', 4)
    expect(own.turnStartOf('s')).toEqual({ since: 4 })
    own.noteTurnStart('s', 9)
    expect(own.turnStartOf('s')).toEqual({ since: 9, before: 4 })
  })
})
