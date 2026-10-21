/**
 * The report marks an older build wrote while it served the same store become threads when this build becomes the active host
 * (docs/plans/mailbox.md §4.2, slice 3): keyed by the two sessions, idempotent, and the old rows stay.
 */
import { describe, expect, it } from 'vitest'
import { Store } from '../dev-services/store.js'
import { adoptOldMarks, reconcileFinished, takeOverFromEarlierBuild, type AdoptedSession } from './adoption.js'
import { ChildOwnership } from '../sessions/child-ownership.js'
import { reportRecorder } from './delegation.js'
import { MailService } from './service.js'

const HOST = 'hub-aaaaaaaa'
const NOW = 1_800_000_000_000

function setup(sessions: Record<string, AdoptedSession> = {}) {
  const store = new Store()
  const mail = new MailService(store.mail, { hostId: () => HOST, now: () => NOW })
  const known: Record<string, AdoptedSession> = { caller: {}, kid: { askedBy: 'caller', projectId: 'p1', depth: 1 }, other: { askedBy: null }, ...sessions }
  const adopt = (marks: { sessionId: string; callerSessionId: string }[], paused: Record<string, number> = {}) =>
    adoptOldMarks(mail, marks, (id) => known[id], (id) => paused[id] ?? 0)
  return { store, mail, adopt, addr: (id: string) => mail.sessionAddress(id) }
}

describe('adopting the marks of an older build', () => {
  it('makes a running thread of a mark: the marking caller owns it, the session that owes the report is on it, nothing wakes anyone', () => {
    const s = setup()
    expect(s.adopt([{ sessionId: 'kid', callerSessionId: 'caller' }])).toBe(1)
    const thread = s.store.mail.latestBetween(s.addr('caller'), s.addr('kid'))!
    expect(thread).toMatchObject({ state: 'running', owner: s.addr('caller'), assignee: s.addr('kid'), origin: 'start_agent', projectId: 'p1', depth: 1, parentId: null })
    const messages = s.store.mail.messagesAfter(thread.id, 0)
    expect(messages.map((m) => m.kind)).toEqual(['assign', 'event'])
    expect(messages[1]!.facts).toEqual({ change: 'adopted', by: 'centralu' })
    // The assign is the stand-in for words that were not kept; it is delivered and read for the session, which has the work already
    expect(messages[0]!.body).toContain('before this version of Centralu wrote it down')
    expect(s.store.mail.receiptsOf(messages[0]!.id)[0]).toMatchObject({ recipient: s.addr('kid'), deliveredAt: NOW, readAt: NOW })
    s.mail.drain(s.addr('kid'), {})
    expect(s.mail.drain(s.addr('kid'), {}).messageIds).toEqual([])
  })

  it('is send_to_session when the caller did not start the session', () => {
    const s = setup()
    s.adopt([{ sessionId: 'other', callerSessionId: 'caller' }])
    expect(s.store.mail.latestBetween(s.addr('caller'), s.addr('other'))?.origin).toBe('send_to_session')
  })

  it('says in an event how many background tasks a paused report waits on, and no more', () => {
    const s = setup()
    s.adopt([{ sessionId: 'kid', callerSessionId: 'caller' }], { kid: 2 })
    const thread = s.store.mail.latestBetween(s.addr('caller'), s.addr('kid'))!
    expect(s.store.mail.messagesAfter(thread.id, 0).find((m) => m.kind === 'event')?.facts).toEqual({ change: 'adopted', by: 'centralu', paused: 2 })
  })

  it('is idempotent: a pair that has a thread not over is skipped, whatever state it is in', () => {
    const s = setup()
    expect(s.adopt([{ sessionId: 'kid', callerSessionId: 'caller' }])).toBe(1)
    expect(s.adopt([{ sessionId: 'kid', callerSessionId: 'caller' }])).toBe(0)
    const thread = s.store.mail.latestBetween(s.addr('caller'), s.addr('kid'))!
    s.mail.reportTurn(thread.id, { to: s.addr('caller'), about: s.addr('kid'), outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: kid', then: 'review' })
    expect(s.adopt([{ sessionId: 'kid', callerSessionId: 'caller' }])).toBe(0)
    expect(s.store.mail.threadsOfParty(s.addr('caller'), 'owner')).toHaveLength(1)
  })

  it('opens a new thread that follows one that is done: the mark is work given after it', () => {
    const s = setup()
    s.adopt([{ sessionId: 'kid', callerSessionId: 'caller' }])
    const first = s.store.mail.latestBetween(s.addr('caller'), s.addr('kid'))!
    s.mail.update(first.id, s.addr('caller'), { state: 'done', outcome: 'finished' })
    expect(s.adopt([{ sessionId: 'kid', callerSessionId: 'caller' }])).toBe(1)
    const second = s.store.mail.latestBetween(s.addr('caller'), s.addr('kid'))!
    expect(second.id).not.toBe(first.id)
    expect(second.follows).toEqual([first.id])
  })

  it('leaves a mark whose sessions are not both here, or that names one session twice, and goes on with the rest', () => {
    const s = setup()
    const made = s.adopt([
      { sessionId: 'gone', callerSessionId: 'caller' },
      { sessionId: 'kid', callerSessionId: 'gone-caller' },
      { sessionId: 'kid', callerSessionId: 'kid' },
      { sessionId: 'other', callerSessionId: 'caller' },
    ])
    expect(made).toBe(1)
    expect(s.store.mail.threadsOfParty(s.addr('caller'), 'owner').map((t) => t.assignee)).toEqual([s.addr('other')])
  })

  it('a mark that cannot be adopted does not stop the rest, and the old row is left', () => {
    const s = setup()
    s.store.children.setReportMark('kid', 'caller')
    const real = s.mail.adoptMark.bind(s.mail)
    let first = true
    s.mail.adoptMark = (owner, assignee, input) => {
      if (first) {
        first = false
        throw new Error('the store is busy')
      }
      return real(owner, assignee, input)
    }
    const made = s.adopt([
      { sessionId: 'kid', callerSessionId: 'caller' },
      { sessionId: 'other', callerSessionId: 'caller' },
    ])
    expect(made).toBe(1)
    expect(s.store.children.listReportMarks()).toEqual([{ sessionId: 'kid', callerSessionId: 'caller' }])
  })

  it('the thread it makes is the one the session’s report goes in, and the thread moves with it', () => {
    const s = setup()
    s.adopt([{ sessionId: 'kid', callerSessionId: 'caller' }])
    const record = reportRecorder(s.mail, s.store.mail)
    expect(record('caller', 'kid', { outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: kid', then: 'review', delivery: 'wake' })).toBe('mailed')
    expect(s.store.mail.latestBetween(s.addr('caller'), s.addr('kid'))?.state).toBe('review')
  })
})

describe('closing the work an earlier build finished (rollback, then forward)', () => {
  type Host = Parameters<typeof reconcileFinished>[2]
  const at = (over: Partial<Host> = {}): Host => ({ owes: () => false, atRest: () => true, holds: () => false, mailInHand: () => false, ...over })
  const going = (s: ReturnType<typeof setup>, assignee = 'kid', origin: 'start_agent' | 'send_to_session' | 'ask_project' | 'agent_session' = 'start_agent') =>
    s.mail.recordDelegation(s.addr('caller'), { assignee: s.addr(assignee), task: 'Land it', origin }).thread

  it('moves a thread to review when its session owes no report, is at rest and holds nothing, with an event that says so; once', () => {
    const s = setup()
    const thread = going(s)
    expect(reconcileFinished(s.mail, s.store.mail.goingMarked(), at())).toBe(1)
    const after = s.store.mail.thread(thread.id)!
    expect(after.state).toBe('review')
    const event = s.store.mail.messagesAfter(thread.id, 0).filter((m) => m.kind === 'event').pop()!
    expect(event.facts).toEqual({ change: 'state', from: 'running', to: 'review', by: 'centralu', reason: 'no_report_owed' })
    expect(event.body).toContain('owes no report')
    // No report: the earlier build told the owner
    expect(s.store.mail.messagesAfter(thread.id, 0).some((m) => m.kind === 'report')).toBe(false)
    expect(reconcileFinished(s.mail, s.store.mail.goingMarked(), at())).toBe(0)
  })

  it('leaves work that is owed (the mark names its owner), in a turn, held over background work or a queued request, or whose session is not here', () => {
    const s = setup()
    const owed = going(s, 'kid')
    const busy = going(s, 'other')
    const held = going(s, 'held')
    const gone = going(s, 'gone')
    const moved = reconcileFinished(
      s.mail,
      s.store.mail.goingMarked(),
      at({
        owes: (assignee, owner) => assignee === 'kid' && owner === 'caller',
        atRest: (id) => id !== 'other' && id !== 'gone',
        holds: (id) => id === 'held',
      }),
    )
    expect(moved).toBe(0)
    for (const t of [owed, busy, held, gone]) expect(s.store.mail.thread(t.id)?.state).toBe('running')
    // A mark that names another caller does not make this owner's work owed
    expect(reconcileFinished(s.mail, s.store.mail.goingMarked(), at({ owes: (assignee, owner) => assignee === 'kid' && owner === 'someone-else', atRest: (id) => id === 'kid' }))).toBe(1)
    expect(s.store.mail.thread(owed.id)?.state).toBe('review')
  })

  it('moves open work too, and leaves blocked work, work of a tool no mark tracks, work made with mail, and work that is over', () => {
    const s = setup()
    const open = going(s, 'kid')
    s.store.mail.updateThread(open.id, { state: 'open' }, NOW, false)
    const viaTool = going(s, 'other', 'agent_session')
    const blocked = going(s, 'held')
    s.mail.addBlocker(blocked.id, s.addr('caller'), { kind: 'text', text: 'Mac only' })
    const done = going(s, 'gone')
    s.mail.update(done.id, s.addr('caller'), { state: 'done', outcome: 'finished' })
    const viaMail = s.mail.open(s.addr('caller'), { kind: 'assign', subject: 'By mail', body: 'x', assignee: s.addr('kid') }).thread
    s.store.mail.updateThread(viaMail.id, { state: 'running' }, NOW, false)
    const known = new Set([open.id, viaMail.id, blocked.id, done.id])
    expect(reconcileFinished(s.mail, s.store.mail.goingMarked(), at())).toBe(1)
    expect(s.store.mail.thread(open.id)?.state).toBe('review')
    expect(s.store.mail.thread(viaTool.id)?.state).toBe('running')
    expect(s.store.mail.thread(blocked.id)?.state).toBe('blocked')
    expect(s.store.mail.thread(done.id)?.state).toBe('done')
    expect(s.store.mail.thread(viaMail.id)?.state).toBe('running')
    expect(known.size).toBe(4)
  })

  it('one thread that cannot be closed leaves the rest', () => {
    const s = setup()
    going(s, 'kid')
    going(s, 'other')
    const real = s.mail.finishedByEarlierBuild.bind(s.mail)
    let first = true
    s.mail.finishedByEarlierBuild = (id) => {
      if (first) {
        first = false
        throw new Error('the store is busy')
      }
      return real(id)
    }
    expect(reconcileFinished(s.mail, s.store.mail.goingMarked(), at())).toBe(1)
  })

  it('takes over in one step: the marks written are adopted, and so the work they owe is not closed; what no mark owes is', () => {
    const s = setup({ finished: { askedBy: 'caller' } })
    // Finished under the earlier build: the thread this build wrote reads running, and no mark is left
    const finished = going(s, 'finished')
    // Still owed under it: a mark, and no thread yet
    s.store.children.setReportMark('kid', 'caller')
    s.store.settings.setAppSetting('report_paused:kid', '[{"id":"t1","description":"dev"}]')
    const result = takeOverFromEarlierBuild(s.mail, s.store, {
      info: (id) => ({ ...({ caller: {}, kid: { askedBy: 'caller' }, finished: { askedBy: 'caller' } } as Record<string, AdoptedSession>)[id], state: 'idle' }),
      depth: () => 0,
      paused: (id) => (id === 'kid' ? 1 : null),
    })
    expect(result).toEqual({ adopted: 1, closed: 1 })
    expect(s.store.mail.thread(finished.id)?.state).toBe('review')
    const adopted = s.store.mail.latestBetween(s.addr('caller'), s.addr('kid'))!
    expect(adopted.state).toBe('running')
    expect(takeOverFromEarlierBuild(s.mail, s.store, { info: () => ({ state: 'idle' }), depth: () => 0, paused: (id) => (id === 'kid' ? 1 : null) })).toEqual({ adopted: 0, closed: 0 })
  })

  it('takes over knowing what holds work: a mark that names another caller, a queued request, a pause on background work, and a session that is not here', () => {
    const s = setup()
    const names = ['a', 'b', 'c', 'd', 'e']
    const threads = names.map((n) => going(s, n))
    // a: a mark names another caller (not this owner's work); b: a request waits for it; c: its report is held over background work; d: not here; e: nothing
    s.store.children.setReportMark('a', 'someone-else')
    new ChildOwnership(s.store).enqueue({ id: 'q1', sessionId: 'b', callerSessionId: 'caller', via: 'agent_session', text: 'more', queuedAt: NOW, openedByAuto: false })
    const info = (id: string) => (id === 'd' ? undefined : { state: 'idle' as const })
    const result = takeOverFromEarlierBuild(s.mail, s.store, { info, depth: () => 0, paused: (id) => (id === 'c' ? 1 : null) })
    const states = threads.map((t) => s.store.mail.thread(t.id)?.state)
    expect(states).toEqual(['review', 'running', 'running', 'running', 'review'])
    expect(result.closed).toBe(2)
  })

  describe('mail the session has not taken is work in hand', () => {
    const takeOver = (s: ReturnType<typeof setup>) =>
      takeOverFromEarlierBuild(s.mail, s.store, { info: () => ({ state: 'idle' }), depth: () => 0, paused: () => null })
    /** Reported, so in review; then the owner or the person sends more, and the turn it starts has begun (running) with the mail not yet marked taken */
    const reopened = (s: ReturnType<typeof setup>, by: string) => {
      const thread = going(s)
      s.mail.reportTurn(thread.id, { to: s.addr('caller'), about: s.addr('kid'), outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: kid', then: 'review' })
      const sent = s.mail.post(thread.id, by === 'person' ? 'person' : s.addr(by), { kind: 'note', body: 'one more thing' })
      s.mail.turnStarted(s.addr('kid'), thread.id, [sent.message.id])
      expect(s.store.mail.thread(thread.id)?.state).toBe('running')
      return { thread, sent }
    }

    it('the owner’s note into a thread in review is not closed as finished while the session has not got it; once it has taken it, it is', () => {
      const s = setup()
      const { thread, sent } = reopened(s, 'caller')
      expect(s.store.mail.receiptsOf(sent.message.id).find((r) => r.recipient === s.addr('kid'))).toMatchObject({ deliveredAt: null })
      expect(takeOver(s).closed).toBe(0)
      expect(s.store.mail.thread(thread.id)?.state).toBe('running')
      // Delivered, not yet read: still in hand
      s.store.mail.markDelivered(s.addr('kid'), [sent.message.id], [], NOW)
      expect(takeOver(s).closed).toBe(0)
      // Read: the session has it, and its turn has ended
      s.store.mail.markDelivered(s.addr('kid'), [sent.message.id], [sent.message.id], NOW)
      expect(takeOver(s).closed).toBe(1)
      expect(s.store.mail.thread(thread.id)?.state).toBe('review')
    })

    it('the person’s reply in the Inbox is work in hand too', () => {
      const s = setup()
      const { thread } = reopened(s, 'person')
      expect(takeOver(s).closed).toBe(0)
      expect(s.store.mail.thread(thread.id)?.state).toBe('running')
    })

    it('mail held back for the person is not work in hand: the person decides what becomes of it', () => {
      const s = setup()
      const { thread, sent } = reopened(s, 'caller')
      s.store.mail.setHeld(s.addr('kid'), [sent.message.id], 'loop')
      expect(takeOver(s).closed).toBe(1)
      expect(s.store.mail.thread(thread.id)?.state).toBe('review')
    })

    it('mail for another session in the thread is not the session’s: only what the assignee holds counts', () => {
      const s = setup()
      const thread = going(s)
      s.mail.post(thread.id, s.addr('kid'), { kind: 'note', body: 'a question for you' })
      expect(s.store.mail.receiptsOf(s.store.mail.messagesAfter(thread.id, 0).filter((m) => m.kind === 'note').pop()!.id)[0]).toMatchObject({ recipient: s.addr('caller') })
      expect(takeOver(s).closed).toBe(1)
    })
  })

  it('the service itself moves nothing but work that is going: not a thread that is over or blocked', () => {
    const s = setup()
    const done = going(s, 'kid')
    s.mail.update(done.id, s.addr('caller'), { state: 'done', outcome: 'finished' })
    expect(s.mail.finishedByEarlierBuild(done.id)).toBeUndefined()
    const blocked = going(s, 'other')
    s.mail.addBlocker(blocked.id, s.addr('caller'), { kind: 'text', text: 'Mac only' })
    expect(s.mail.finishedByEarlierBuild(blocked.id)).toBeUndefined()
    expect(s.store.mail.thread(blocked.id)?.state).toBe('blocked')
    expect(s.mail.finishedByEarlierBuild('no-such-thread')).toBeUndefined()
  })
})
