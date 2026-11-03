import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionLiveDefaults, type SessionInfo } from '@cc/protocol'
import { Store, type QueuedRequest } from '../dev-services/store.js'
import type { MailSessions } from '../mail/delivery.js'
import { hostMail, type HostMailSessions } from '../mail/host-mail.js'
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

/** Session 's' in the store, so its rows can be written (#1639: a host reads the held messages back from them) */
const seedSession = () => {
  store.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  store.sessions.upsertSession({
    id: 's', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 's', autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })
}
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

  it('says what the work’s message was: a caller’s send, a report about another session, an app’s; the oldest message says, and the input the tool names says again', () => {
    const turns = heard()
    own.noteMessage('a', 'work', false, false, false, undefined, 'report')
    own.turnStarted('a')
    own.noteMessage('b', 'work', false, false, false, undefined, 'app')
    own.noteMessage('b', 'work', false, false, false, undefined, 'report')
    own.turnStarted('b')
    // The person’s message first, then a report: the turn opens as the person’s, and the tool names the report, so it ran for both (#1639)
    own.noteMessage('c', 'person', false, false, false, 'c-1')
    own.noteMessage('c', 'work', false, false, false, 'c-2', 'report')
    own.turnStarted('c')
    own.turnNamed('c', ['c-2'])
    // Into a running turn, a message the tool did not take in is the next turn’s, and keeps what it was
    own.noteMessage('d', 'work', true, true, false, 'in-1', 'report')
    own.turnEnded('d', [])
    own.turnStarted('d')
    // No message at all: the CLI’s own
    own.turnStarted('e')
    // A message a Stop dropped says nothing of the next turn
    own.noteMessage('f', 'work', false, false, false, undefined, 'report')
    own.dropInputOrigins('f')
    own.noteMessage('f', 'work', false, false, false, undefined, 'app')
    own.turnStarted('f')
    expect(turns.map((t) => [t.sessionId, t.source, t.cli])).toEqual([
      ['a', 'report', false],
      ['b', 'app', false],
      ['c', 'caller', false],
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

  describe('a session at rest that waits for tasks it handed on (§6, §9.4)', () => {
    const HOST = 'hub-aaaaaaaa'
    /** What the host's mail reads of its sessions: nothing of it is asked here but the turn a task is written in */
    const mailSessions: HostMailSessions = {
      sessionInfo: () => undefined,
      listSessions: () => [],
      canReadMail: () => true,
      orchestratorId: () => null,
      orchestratorAsks: () => null,
      mailCommand: () => false,
      keptInTurn: () => false,
      oldOwes: () => true,
      mailSessions: () => ({ receiver: () => ({ atRest: false }), deliver: async () => {}, note: () => {} }) as unknown as MailSessions,
    }
    /**
     * The caller gave 'kept-idle' a task; in the turn of that task, 'kept-idle' handed a part on to `helper` (a task whose cause is the caller's
     * task), and the old path owes 'kept-idle' the helper's report (its report mark)
     */
    const handedOn = (helper = 'helper', text = 'Land it') => {
      const m = hostMail(store, mailSessions, { hostId: HOST })
      const addr = (id: string) => m.service.sessionAddress(id)
      const work = m.service.task(addr('caller'), addr('kept-idle'), { text, origin: 'start_agent', delivered: true })
      m.turns.beginOther('kept-idle', 'caller', work.id, 'caller')
      const part = m.service.task(addr('kept-idle'), addr(helper), { text: `${text}: the tests`, origin: 'start_agent', delivered: true })
      expect(part.causeId).toBe(work.id)
      store.children.setReportMark('kept-idle', 'caller')
      helperMarks.add(helper)
      return { m, addr, work, part }
    }
    /** The helpers whose report marks the store holds before each start; a start drops the marks of sessions it does not have */
    const helperMarks = new Set<string>()
    beforeEach(() => helperMarks.clear())

    /** Whether a fresh host, started now with these sessions kept, still owes the report */
    let lastHost = own
    const owed = (keptNow: ReadonlySet<string> = kept, sessionsNow: ReadonlyMap<string, SessionInfo> = sessions) => {
      store.children.setReportMark('kept-idle', 'caller')
      for (const helper of helperMarks) store.children.setReportMark(helper, 'kept-idle')
      lastHost = new ChildOwnership(store)
      lastHost.restoreReports(sessionsNow, keptNow)
      return lastHost.awaitingReport.get('kept-idle') === 'caller'
    }

    it('keeps its mark with the swap: the tasks are in the store, and the turn their end starts ends under this host', () => {
      handedOn()
      for (const helper of helperMarks) store.children.setReportMark(helper, 'kept-idle')
      own.restoreReports(sessions, kept)
      expect(own.awaitingReport.get('kept-idle')).toBe('caller')
      expect(store.children.listReportMarks()).toEqual([{ sessionId: 'kept-idle', callerSessionId: 'caller' }])
    })

    it('drops it when nothing is owed: the helper reported, is gone, or the old path no longer owes its report', () => {
      const { m, part } = handedOn()
      // Owed, it is kept
      expect(owed()).toBe(true)
      m.service.report(part.id, { outcome: 'finished', body: 'tests written' })
      expect(owed()).toBe(false)
      const other = handedOn()
      expect(owed()).toBe(true)
      other.m.service.partyGone(other.addr('helper'))
      expect(owed()).toBe(false)
      handedOn('helper3')
      expect(owed()).toBe(true)
      // The helper's report mark went (its turn ended with no host to report it): the old path owes nothing, so the task is not waited on
      helperMarks.clear()
      expect(owed()).toBe(false)
    })

    it('drops it when the work itself is over, whatever its helper does', () => {
      const { m, work } = handedOn()
      expect(owed()).toBe(true)
      m.service.report(work.id, { outcome: 'stopped', reason: 'taken_over', body: 'dropped' })
      expect(owed()).toBe(false)
    })

    it('keeps it for a session with no process too (asleep, or the host was quit): the work is the helpers’, and their report wakes it', () => {
      const { m, part } = handedOn()
      store.settings.setAppSetting(pausedReportKey('kept-idle'), JSON.stringify([{ id: 't1', description: 'dev server' }]))
      expect(owed(new Set())).toBe(true)
      // What its process held went with it
      expect(store.settings.appSetting(pausedReportKey('kept-idle'))).toBeNull()
      expect(lastHost.pausedReports.has('kept-idle')).toBe(false)
      // With nothing owed, a session whose process was not kept loses its mark as it did
      m.service.report(part.id, { outcome: 'finished', body: 'tests written' })
      helperMarks.clear()
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

    it('reads the newest task of the pair: an old one that is reported does not hide the new one that is owed', () => {
      const { m, work } = handedOn()
      m.service.report(work.id, { outcome: 'finished', body: 'landed' })
      // Its helper's task is still unsettled, but it was handed on in work that is over
      expect(owed()).toBe(false)
      const next = handedOn('helper2', 'More work')
      expect(next.work.id).not.toBe(work.id)
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

  it("a caller's, an app's or Centralu's message makes it the work's, also with the person's behind it when the tool names the last of them", () => {
    own.noteMessage('s', 'work', false, true, false, 'w')
    own.noteMessage('s', 'person', false, true, false, 'p')
    own.turnStarted('s')
    own.turnNamed('s', ['p'])
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

  it('naming none (an empty list) takes none in, and the message is the next turn’s; a tool that cannot name them (null) is done with them all (#1639)', () => {
    for (const [taken, next] of [[[], 'person'], [null, 'work']] as const) {
      own.noteMessage('s', 'work', false, true, false, `w-${next}`)
      own.turnStarted('s')
      own.turnNamed('s', [`w-${next}`])
      own.noteMessage('s', 'person', true, true, false, 'm')
      expect(own.turnEnded('s', taken)).toEqual({ by: 'work' })
      own.turnStarted('s')
      expect(own.turnEnded('s')).toEqual({ by: next })
    }
  })

  it("a person's message into their own turn that was not taken in is theirs after it too, and the caller's is the work's", () => {
    own.noteMessage('s', 'person', false, true, false, 'p1')
    own.turnStarted('s')
    own.turnNamed('s', ['p1'])
    own.noteMessage('s', 'person', true, true, false, 'again')
    expect(own.turnEnded('s', [])).toEqual({ by: 'person' })
    own.turnStarted('s')
    expect(own.turnEnded('s', ['again'])).toEqual({ by: 'person' })
    own.noteMessage('s', 'person', false, true, false, 'p2')
    own.turnStarted('s')
    own.turnNamed('s', ['p2'])
    own.noteMessage('s', 'work', true, true, false, 'caller')
    expect(own.turnEnded('s', [])).toEqual({ by: 'person' })
    own.turnStarted('s')
    expect(own.turnEnded('s')).toEqual({ by: 'work' })
  })

  // The messages not yet taken in are read back from their rows (#1639, the test of a host that takes the session over below)
  it("the turn's starter is kept for the next host, and a pending list a build before #1639 kept beside it is not read", () => {
    own.markReport('s', 'caller')
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    own.noteMessage('s', 'person', true, true, false, 'held')
    expect(JSON.parse(store.settings.appSetting(reportTurnKey('s'))!)).toEqual({ by: 'work' })
    store.settings.setAppSetting(reportTurnKey('s'), JSON.stringify({ by: 'work', pending: [{ id: 'held', by: 'person' }] }))
    const next = new ChildOwnership(store)
    next.adoptReport('s', 'caller', null)
    expect(next.starterOf('s')).toEqual({ by: 'work' })
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

  it("two messages before the turn that the tool runs as one (it names the last): the work's if either is", () => {
    own.noteMessage('s', 'person', false, true, false, 'a1')
    own.noteMessage('s', 'work', false, true, false, 'a2')
    own.turnStarted('s')
    own.turnNamed('s', ['a2'])
    expect(own.turnEnded('s')).toEqual({ by: 'work', wrote: true })
    own.noteMessage('s', 'work', false, true, false, 'b1')
    own.noteMessage('s', 'person', false, true, true, 'b2')
    own.turnStarted('s')
    own.turnNamed('s', ['b2'])
    expect(own.turnEnded('s')).toEqual({ by: 'work', added: true })
    own.noteMessage('s', 'person', false, true, false, 'c1')
    own.noteMessage('s', 'person', false, true, false, 'c2')
    own.turnStarted('s')
    own.turnNamed('s', ['c2'])
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
  /** A hub's message given the tool as `id`, at rest or into the running turn (#1639: an entry, with its origin) */
  const hub = (id: string, seq = note.seq, inTurn = false) => {
    own.noteMessage('s', 'work', inTurn, true, false, id, 'caller', seq)
    own.noteInputOrigin('s', id, { ...note, seq })
  }

  it('names the sender and row of the note the turn opens for, once', () => {
    hub('note-id')
    expect(own.turnNamed('s', ['other-id', 'note-id'])).toEqual(note)
    expect(own.turnNamed('s', ['note-id'])).toBeUndefined()
  })

  it('names nothing for a turn the tool opens with no input of a sender, or when the tool does not say', () => {
    hub('note-id')
    expect(own.turnNamed('s', [])).toBeUndefined()
    expect(own.turnNamed('s', null)).toBeUndefined()
    expect(own.turnNamed('s', undefined)).toBeUndefined()
    expect(own.turnNamed('s', ['note-id'])).toEqual(note)
  })

  it('forgets a note the turn it went into took in, and keeps one it did not take, for the turn the tool runs it as', () => {
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    hub('taken', 7, true)
    hub('not-taken', 8, true)
    own.turnEnded('s', ['taken'])
    expect(own.turnNamed('s', ['taken'])).toBeUndefined()
    expect(own.turnNamed('s', ['not-taken'])).toEqual({ ...note, seq: 8 })
  })

  it('takes off every note given before the last one a turn names: the tool runs them in order, and says only the last of a batch', () => {
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) hub(id, 10 + i)
    expect(own.turnNamed('s', ['c'])).toEqual({ ...note, seq: 12 })
    // None of the batch is left, and the one given after it still is
    expect(own.turnNamed('s', ['a'])).toBeUndefined()
    expect(own.turnNamed('s', ['b'])).toBeUndefined()
    expect(own.turnNamed('s', ['d'])).toEqual({ ...note, seq: 13 })
  })

  it('keeps for one turn what a tool that does not name its inputs may run as a turn after the one it was sent into', () => {
    own.noteMessage('s', 'work', false, true)
    own.turnStarted('s')
    hub('note-id', 7, true)
    // Codex: every message sent to a running turn is taken to have joined it, yet one it ran as a turn after is named when that turn opens
    own.turnEnded('s', undefined)
    expect(JSON.parse(store.settings.appSetting('input_origins:s')!)).toEqual([['note-id', note]])
    own.turnStarted('s')
    expect(own.turnNamed('s', ['note-id'])).toEqual(note)
    own.turnEnded('s', undefined)
    // A turn that opens for something else: it went into the turn before, and is done with
    hub('steered', 9, true)
    own.turnEnded('s', undefined)
    own.turnStarted('s')
    expect(own.turnNamed('s', ['other'])).toBeUndefined()
    expect(own.turnNamed('s', ['steered'])).toBeUndefined()
  })

  it('keeps them across a host swap: a host that takes over the session still says whose message the turn it runs is for', () => {
    seedSession()
    store.messages.appendMessages([{ sessionId: 's', seq: 7, role: 'user', kind: 'text', payload: { text: 't', inputId: 'note-id', from: note.from }, ts: 1 }])
    hub('note-id')
    expect(new ChildOwnership(store).turnNamed('s', ['note-id'])).toEqual(note)
    // And what it took off stays off for the one after it
    expect(new ChildOwnership(store).turnNamed('s', ['note-id'])).toBeUndefined()
  })

  it('writes for a build before #1639 the hub messages still held, the most recent sixty-four', () => {
    for (let i = 0; i < 70; i++) hub(`id-${i}`, i)
    const written = () => JSON.parse(store.settings.appSetting('input_origins:s')!) as [string, unknown][]
    expect(written()).toHaveLength(64)
    expect(written().at(-1)).toEqual(['id-69', { ...note, seq: 69 }])
    // A turn ran for those up to id-10: what is written is what the tool still holds
    own.turnNamed('s', ['id-10'])
    expect(written().map(([id]) => id)).toEqual(Array.from({ length: 59 }, (_, i) => `id-${11 + i}`))
  })

  it('takes off the same when the tool cannot tell what a turn took in (an older Claude Code, a turn lost in a swap)', () => {
    hub('before-the-turn', 4)
    own.turnStarted('s')
    own.turnEnded('s', null)
    expect(own.turnNamed('s', ['before-the-turn'])).toBeUndefined()
    expect(JSON.parse(store.settings.appSetting('input_origins:s')!)).toEqual([])
  })

  it('takes off all of them when the process went with the turn: it runs none of what it was given after', () => {
    hub('a', 2)
    hub('b', 3)
    // A control: a turn that ended whole and named nothing keeps them
    own.turnEnded('s', [])
    expect(own.turnNamed('s', ['a'])).toEqual({ ...note, seq: 2 })
    own.turnEnded('s', [], true)
    expect(store.settings.appSetting('input_origins:s')).toBeNull()
    expect(own.turnNamed('s', ['b'])).toBeUndefined()
  })

  it('takes off all of them when the tool holds none any more: a stop, a new process', () => {
    hub('a', 2)
    own.dropInputOrigins('s')
    expect(own.turnNamed('s', ['a'])).toBeUndefined()
    expect(store.settings.appSetting('input_origins:s')).toBeNull()
  })

  it("keeps nothing of a session's turns when it is deleted: neither its origins nor where its turns began", () => {
    hub('a', 2)
    own.noteTurnStart('s', 1)
    expect(store.settings.appSetting('turn_span:s')).not.toBeNull()
    own.forgetTurns('s')
    expect(store.settings.appSetting('input_origins:s')).toBeNull()
    expect(store.settings.appSetting('turn_span:s')).toBeNull()
    expect(store.settings.appSetting('turn_inputs:s')).toBeNull()
  })
})

// #1604: where a hub reads the words of a turn from
describe('where the last turn that ended began', () => {
  const note = { seq: 7, from: { sessionId: '_hub-orchestrator', name: 'Parent' } }
  /** A hub gives the session messages: only those have their turns kept */
  const followed = () => {
    own.noteMessage('s', 'work', false, true, false, 'task', 'caller', note.seq)
    own.noteInputOrigin('s', 'task', note)
  }

  it('is kept for the turns of a session a hub gave messages, and for no other', () => {
    own.noteTurnStart('other', 4)
    expect(store.settings.appSetting('turn_span:other')).toBeNull()
    expect(own.turnRows('other')).toBeUndefined()
    followed()
    own.noteTurnStart('s', 4)
    expect(own.turnRows('s')).toEqual({ after: 4 })
  })

  it('is the turn before the running one, up to where the running one began, when the running one has not ended', () => {
    followed()
    own.noteTurnStart('s', 4)
    own.turnEnded('s')
    expect(own.turnRows('s')).toEqual({ after: 4 })
    own.noteTurnStart('s', 9)
    // The hub reads the end of the first turn as the second begins
    expect(own.turnRows('s')).toEqual({ after: 4, through: 9 })
  })

  // #1812: a hub reads a turn's words after its end, by when more than one turn may have followed it
  it('is the turn a hub names by where it began, up to where the next began, though later turns have begun and ended', () => {
    followed()
    for (const start of [1, 3, 5, 7]) {
      own.noteTurnStart('s', start)
      own.turnEnded('s')
    }
    expect(own.turnRows('s', 1)).toEqual({ after: 1, through: 3 })
    expect(own.turnRows('s', 5)).toEqual({ after: 5, through: 7 })
    expect(own.turnRows('s', 7)).toEqual({ after: 7 })
  })

  it('is the last turn that ended for a start no longer kept, or a list a build before it left behind', () => {
    followed()
    for (let start = 1; start <= 10; start++) {
      own.noteTurnStart('s', start)
      own.turnEnded('s')
    }
    // Eight are kept: the first two are gone
    expect(own.turnRows('s', 2)).toEqual({ after: 10 })
    expect(own.turnRows('s', 3)).toEqual({ after: 3, through: 4 })
    // An older build wrote the span since: its list does not end at the latest start, so only the two it keeps are read
    store.settings.setAppSetting('turn_span:s', JSON.stringify({ latest: { since: 12, ended: true }, previous: { since: 11 }, starts: [3, 4, 10] }))
    expect(own.turnRows('s', 3)).toEqual({ after: 12 })
    expect(own.turnRows('s', 11)).toEqual({ after: 11, through: 12 })
  })

  it('is the latest turn once it has ended, even when it said nothing: never the turn before it', () => {
    followed()
    own.noteTurnStart('s', 4)
    own.turnEnded('s')
    own.noteTurnStart('s', 9)
    own.turnEnded('s')
    expect(own.turnRows('s')).toEqual({ after: 9 })
  })

  it('is closed with the process: a turn that never sent its end has its own words, and nothing it was given is run', () => {
    followed()
    own.noteTurnStart('s', 4)
    own.turnEnded('s')
    own.noteTurnStart('s', 9)
    // A control: the turn still running reads as the turn before it
    expect(own.turnRows('s')).toEqual({ after: 4, through: 9 })
    own.processGone('s')
    expect(own.turnRows('s')).toEqual({ after: 9 })
    expect(store.settings.appSetting('input_origins:s')).toBeNull()
    // Closing it again, or a session no hub follows, is nothing
    own.processGone('s')
    own.processGone('nobody')
    expect(own.turnRows('s')).toEqual({ after: 9 })
    expect(store.settings.appSetting('turn_span:nobody')).toBeNull()
  })

  it('survives a host swap: the host that takes the session over reads where the running turn began, and ends it', () => {
    followed()
    own.noteTurnStart('s', 4)
    own.turnEnded('s')
    own.noteTurnStart('s', 9)
    const next = new ChildOwnership(store)
    expect(next.turnRows('s')).toEqual({ after: 4, through: 9 })
    next.turnEnded('s')
    expect(new ChildOwnership(store).turnRows('s')).toEqual({ after: 9 })
  })
})

/*
 * #1639 (docs/plans/turn-starter.md): a turn is decided at its start by the oldest message given before it, else it is the CLI's own; when the
 * tool names the input the turn opened from, it is decided again by that, with no clock
 */
describe('whose a turn is, by the inputs the tool names (#1639)', () => {
  const told: { sessionId: string; by: string; cli: boolean; again?: true }[] = []
  beforeEach(() => {
    told.length = 0
    own.onTurnStarted((sessionId, t) => void told.push({ sessionId, by: t.by, cli: t.cli, ...(t.again ? { again: t.again } : {}) }))
  })

  it('a message the tool holds queued for 20 s still starts its sender’s turn: no window decides it', () => {
    vi.useFakeTimers()
    own.noteMessage('s', 'work', false, false, false, 'caller-1')
    vi.advanceTimersByTime(20_000)
    own.turnStarted('s')
    expect(told).toEqual([{ sessionId: 's', by: 'work', cli: false }])
  })

  it('is decided again when the tool names the input the turn opened from: the start went by an older message', () => {
    // The person’s message the tool answered without a turn (a refused /goal) is still held when the caller’s comes
    own.noteMessage('s', 'person', false, false, false, 'person-1')
    own.noteMessage('s', 'work', false, false, false, 'caller-1')
    own.turnStarted('s')
    expect(own.starterOf('s')).toEqual({ by: 'person' })
    own.turnNamed('s', ['caller-1'])
    // It ran for both (the tool runs inputs in order): the work’s, the person’s message in it
    expect(own.starterOf('s')).toEqual({ by: 'work', wrote: true })
    expect(told).toEqual([{ sessionId: 's', by: 'person', cli: false }, { sessionId: 's', by: 'work', cli: false, again: true }])
    // The same answer again is not told twice, and the next turn finds nothing held
    own.turnNamed('s', ['caller-1'])
    expect(told).toHaveLength(2)
    expect(own.turnEnded('s', [])).toEqual({ by: 'work', wrote: true })
    own.turnStarted('s')
    expect(told.at(-1)).toEqual({ sessionId: 's', by: 'work', cli: true })
  })

  it('an input named that no message went in under (a mail wake, a compact), or none named, is the CLI’s own; the held message waits', () => {
    own.noteMessage('s', 'person', false, false, false, 'person-1')
    own.turnStarted('s')
    own.turnNamed('s', ['wake-1'])
    expect(told.at(-1)).toEqual({ sessionId: 's', by: 'work', cli: true, again: true })
    own.turnEnded('s', ['wake-1'])
    // The person’s message is the next turn’s
    own.turnStarted('s')
    expect(own.starterOf('s')).toEqual({ by: 'person' })
    own.turnNamed('s', ['person-1'])
    own.turnEnded('s', ['person-1'])
    own.noteMessage('s', 'person', false, false, false, 'person-2')
    own.turnStarted('s')
    own.turnNamed('s', [])
    expect(told.at(-1)).toEqual({ sessionId: 's', by: 'work', cli: true, again: true })
    // Not an opening: nothing changes
    own.turnNamed('s', null)
    expect(told.at(-1)).toEqual({ sessionId: 's', by: 'work', cli: true, again: true })
  })

  it('an end that cannot name what it took spends every message: the CLI’s next turn is its own, not the note sender’s', () => {
    own.noteMessage('s', 'work', false, false, false, 'caller-1')
    own.turnStarted('s')
    // The person writes into the work’s turn; an older CLI cannot say whether it took the note in
    own.noteMessage('s', 'person', true, true, false, 'person-1')
    expect(own.personInTurn('s')).toBe(true)
    expect(own.turnEnded('s', null)).toEqual({ by: 'work' })
    own.turnStarted('s')
    expect(told.at(-1)).toEqual({ sessionId: 's', by: 'work', cli: true })
  })

  it('a note the turn says it took joined it; one it did not take is the next turn’s', () => {
    own.noteMessage('s', 'work', false, false, false, 'caller-1')
    own.turnStarted('s')
    own.turnNamed('s', ['caller-1'])
    own.noteMessage('s', 'person', true, true, false, 'person-1')
    own.noteMessage('s', 'person', true, true, false, 'person-2')
    expect(own.turnEnded('s', ['person-1'])).toEqual({ by: 'work', wrote: true })
    own.turnStarted('s')
    expect(own.starterOf('s')).toEqual({ by: 'person' })
  })

  it('a turn whose opening was not named (a card was up) is decided by the inputs its end names, however long they waited', () => {
    vi.useFakeTimers()
    own.noteMessage('s', 'person', false, false, false, 'person-1')
    own.noteMessage('s', 'work', false, false, false, 'caller-1')
    vi.advanceTimersByTime(20_000)
    own.turnStarted('s')
    expect(own.turnEnded('s', ['person-1', 'caller-1'])).toEqual({ by: 'work', wrote: true })
  })

  it('a turn the person took over stays theirs when the tool names a caller’s input', () => {
    own.noteMessage('s', 'work', false, false, false, 'caller-1')
    own.turnStarted('s')
    own.takeTurn('s')
    own.turnNamed('s', ['caller-1'])
    expect(own.starterOf('s')).toEqual({ by: 'person' })
  })

  it('a Stop, a new process or a cut turn spends what was held', () => {
    own.noteMessage('s', 'person', false, false, false, 'person-1')
    own.dropInputOrigins('s')
    own.turnStarted('s')
    expect(told.at(-1)).toEqual({ sessionId: 's', by: 'work', cli: true })
  })

  it('a host that takes the session over reads the held messages back from their rows, after the last one spent', () => {
    seedSession()
    const row = (seq: number, payload: Record<string, unknown>) => ({ sessionId: 's', seq, role: 'user' as const, kind: 'text' as const, payload: { text: 't', ...payload }, ts: 1 })
    store.messages.appendMessages([
      // A row with no input id (a first prompt, or one an older build wrote): no message to go by
      row(1, {}),
      row(2, { inputId: 'person-1' }),
      row(3, { inputId: 'caller-1', from: { sessionId: 'c', name: 'C' } }),
      row(4, { inputId: 'person-2', intent: 'task' }),
    ])
    own.noteMessage('s', 'person', false, false, false, 'person-1', 'caller', 2)
    own.turnStarted('s')
    own.turnNamed('s', ['person-1'])
    expect(JSON.parse(store.settings.appSetting('turn_inputs:s')!)).toEqual({ spent: 2, named: true })
    const next = new ChildOwnership(store)
    next.turnStarted('s')
    expect(next.starterOf('s')).toEqual({ by: 'work' })
    next.turnNamed('s', ['person-2'])
    expect(next.starterOf('s')).toEqual({ by: 'work', added: true })
  })

  // Review of #1929: what a host that takes a kept session over mid-turn reads back
  describe('across a keeper swap', () => {
    const user = (seq: number, inputId: string, from?: string) =>
      ({ sessionId: 's', seq, role: 'user' as const, kind: 'text' as const, payload: { text: 't', inputId, ...(from ? { from: { sessionId: from, name: from } } : {}) }, ts: 1 })
    beforeEach(() => seedSession())

    it('a work turn the person wrote into stays the work’s, with the person noted: the caller’s report is not held back', () => {
      store.messages.appendMessages([user(1, 'caller-1', 'c'), user(2, 'person-1')])
      own.markReport('s', 'caller')
      own.noteMessage('s', 'work', false, false, false, 'caller-1', 'caller', 1)
      own.turnStarted('s')
      own.turnNamed('s', ['caller-1'])
      own.noteMessage('s', 'person', true, true, false, 'person-1', 'caller', 2)
      const next = new ChildOwnership(store)
      next.adoptReport('s', 'caller', null)
      expect(next.personInTurn('s')).toBe(true)
      // The CLI names both at the end: the caller's it opened from, and the person's it took in at a tool round
      expect(next.turnEnded('s', ['caller-1', 'person-1'])).toEqual({ by: 'work', wrote: true })
    })

    it('a turn the person took over before the swap stays theirs when the new host hears the opening named', () => {
      store.messages.appendMessages([user(1, 'caller-1', 'c')])
      own.markReport('s', 'caller')
      own.noteMessage('s', 'work', false, false, false, 'caller-1', 'caller', 1)
      own.turnStarted('s')
      own.takeTurn('s')
      const next = new ChildOwnership(store)
      next.adoptReport('s', 'caller', null)
      next.turnNamed('s', ['caller-1'])
      expect(next.starterOf('s')).toEqual({ by: 'person' })
    })

    it('reads back a message held before anything was ever spent: a new session’s first one', () => {
      store.messages.appendMessages([user(1, 'person-1')])
      own.noteMessage('s', 'person', false, false, false, 'person-1', 'caller', 1)
      const next = new ChildOwnership(store)
      next.turnStarted('s')
      expect(next.starterOf('s')).toEqual({ by: 'person' })
      expect(next.continuesPause('s', 'caller')).toBe(false)
    })

    // Recheck of #1929, N1: the new host's first call is the person's message, whose row is already stored
    it('a message given first thing on the new host is marked as given into the turn, and kept so across another swap', () => {
      store.messages.appendMessages([user(1, 'caller-1', 'c'), user(2, 'person-1')])
      own.markReport('s', 'caller')
      own.noteMessage('s', 'work', false, false, false, 'caller-1', 'caller', 1)
      // A card is up at the opening: it is not named
      own.turnStarted('s')
      const next = new ChildOwnership(store)
      next.adoptReport('s', 'caller', null)
      next.noteMessage('s', 'person', true, true, false, 'person-1', 'caller', 2)
      expect(next.personInTurn('s')).toBe(true)
      const third = new ChildOwnership(store)
      third.adoptReport('s', 'caller', null)
      expect(third.personInTurn('s')).toBe(true)
      // Codex names nothing at the end: the person's message went into the work's turn
      expect(third.turnEnded('s', undefined)).toEqual({ by: 'work', wrote: true })
    })

    // N2: an upgrade swap from a build before #1639, which kept no `turn_inputs` and wrote no input id on its rows
    it('reads once what a build before #1639 left: the running turn’s pending messages', () => {
      store.settings.setAppSetting(reportTurnKey('s'), JSON.stringify({ by: 'work', pending: [{ id: 'person-1', by: 'person' }] }))
      const next = new ChildOwnership(store)
      next.adoptReport('s', 'caller', null)
      expect(next.personInTurn('s')).toBe(true)
      expect(next.turnEnded('s', ['caller-1', 'person-1'])).toEqual({ by: 'work', wrote: true })
    })

    it('reads once what a build before #1639 left: the hub’s messages its tool holds', () => {
      const hubNote = { seq: 3, from: { sessionId: '_hub-orchestrator', name: 'Parent' } }
      store.settings.setAppSetting('input_origins:s', JSON.stringify([['hub-1', hubNote]]))
      const next = new ChildOwnership(store)
      next.turnStarted('s')
      expect(next.starterOf('s')).toEqual({ by: 'work' })
      expect(next.turnNamed('s', ['hub-1'])).toEqual(hubNote)
    })

    // N5: a rollback to a build before #1639 and forward again
    it('does not read back as held what was given before a row an older build wrote: that build ran it', () => {
      store.messages.appendMessages([user(1, 'person-1'), { ...user(2, 'x'), payload: { text: 'from the older build' } }, user(3, 'caller-2', 'c')])
      store.settings.setAppSetting('turn_inputs:s', JSON.stringify({ spent: 0 }))
      const next = new ChildOwnership(store)
      next.turnStarted('s')
      // Not the person's message the older build already ran: the caller's given after it
      expect(next.starterOf('s')).toEqual({ by: 'work' })
      next.turnNamed('s', ['person-1'])
      expect(next.starterOf('s')).toEqual({ by: 'work' })
      expect(JSON.parse(store.settings.appSetting('turn_inputs:s')!)).toMatchObject({ spent: 2 })
    })

    it('reads back however many rows a long turn wrote after the last message spent', () => {
      const steps = Array.from({ length: 600 }, (_, i) => ({ sessionId: 's', seq: 2 + i, role: 'assistant' as const, kind: 'text' as const, payload: { text: 'step' }, ts: 1 }))
      store.messages.appendMessages([user(1, 'caller-1', 'c'), ...steps, user(602, 'person-1')])
      own.noteMessage('s', 'work', false, false, false, 'caller-1', 'caller', 1)
      own.turnStarted('s')
      own.turnNamed('s', ['caller-1'])
      own.turnEnded('s', ['caller-1'])
      own.noteMessage('s', 'person', false, false, false, 'person-1', 'caller', 602)
      const next = new ChildOwnership(store)
      next.turnStarted('s')
      expect(next.starterOf('s')).toEqual({ by: 'person' })
    })
  })

  it('a person’s message held over a turn’s end and taken into the next work turn at a tool round is noted on it, and is in it while it runs', () => {
    own.noteMessage('s', 'work', false, false, false, 'caller-0')
    own.turnStarted('s')
    own.turnNamed('s', ['caller-0'])
    own.noteMessage('s', 'work', true, true, false, 'caller-1')
    own.noteMessage('s', 'person', true, true, false, 'person-1')
    // Neither was taken: both wait for the next turn, which opens on the caller's
    expect(own.turnEnded('s', ['caller-0'])).toEqual({ by: 'work' })
    own.turnStarted('s')
    own.turnNamed('s', ['caller-1'])
    expect(own.personInTurn('s')).toBe(true)
    expect(own.turnEnded('s', ['caller-1', 'person-1'])).toEqual({ by: 'work', wrote: true })
  })
})
