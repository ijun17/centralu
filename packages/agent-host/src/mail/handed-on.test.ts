/**
 * Work handed on (docs/plans/mailbox.md §6, slice 3): a thread a session opens in the middle of work it was given is that work's
 * child. The work stays `running` while the child is going, its report says how many threads it waits for, and a turn that
 * only the child's report starts belongs to the work.
 */
import { describe, expect, it } from 'vitest'
import { Store } from '../dev-services/store.js'
import { sessionAddress } from './address.js'
import { reportRecorder, type ReportDraft } from './delegation.js'
import { MailService } from './service.js'

const HOST = 'hub-aaaaaaaa'
const A = sessionAddress(HOST, 'a')
const B = sessionAddress(HOST, 'b')
const C = sessionAddress(HOST, 'c')
const NOW = 1_800_000_000_000

function setup() {
  const store = new Store()
  const clock = { t: NOW }
  const mail = new MailService(store.mail, { hostId: () => HOST, now: () => clock.t })
  // A gave B work; B is at it
  const t1 = mail.recordDelegation(A, { assignee: B, task: 'Land #12', origin: 'start_agent' }).thread
  // B hands a part on to C, in the work of T1
  const handOn = (over: { parentId?: string | null; depth?: number } = {}) =>
    mail.recordDelegation(B, { assignee: C, task: 'Write the tests', origin: 'start_agent', parentId: t1.id, ...over })
  return { store, clock, mail, t1, handOn }
}
const report = (over: Partial<Parameters<MailService['reportTurn']>[1]> = {}): Parameters<MailService['reportTurn']>[1] => ({
  to: A,
  about: B,
  outcome: 'finished',
  body: '[Centralu] The assigned work finished.\nid: b',
  then: 'review',
  ...over,
})

describe('a thread opened in the work of another', () => {
  it('is that work’s child, one level below it; a depth the host knows to be deeper stands', () => {
    const s = setup()
    const child = s.handOn().thread
    expect(child).toMatchObject({ parentId: s.t1.id, depth: s.t1.depth + 1, owner: B, assignee: C })
    const deeper = s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'd'), task: 'Another', origin: 'start_agent', parentId: s.t1.id, depth: 5 }).thread
    expect(deeper.depth).toBe(5)
  })

  it('has no parent when the caller is not the one doing it, or the work is over', () => {
    const s = setup()
    // The caller doing the work does have one
    expect(s.handOn().thread.parentId).toBe(s.t1.id)
    // B is not the assignee of a thread A is the assignee of
    const other = s.mail.recordDelegation(C, { assignee: sessionAddress(HOST, 'd'), task: 'Elsewhere', origin: 'start_agent', parentId: s.t1.id }).thread
    expect(other.parentId).toBeNull()
    s.mail.update(s.t1.id, A, { state: 'done', outcome: 'dropped' })
    expect(s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'x'), task: 'After', origin: 'start_agent', parentId: s.t1.id }).thread.parentId).toBeNull()
    expect(s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'y'), task: 'No parent given', origin: 'start_agent' }).thread.parentId).toBeNull()
  })
})

describe('a thread opened with the mail tool under work', () => {
  it('names only work the opener is doing: another session cannot hold it running, the person can', () => {
    const s = setup()
    const open = (by: string, parentId: string) => s.mail.open(by, { kind: 'note', subject: 'Part', body: 'a part of it', owner: by, parentId })
    expect(() => open(C, s.t1.id)).toThrow(/parentId/)
    expect(open(B, s.t1.id).thread.parentId).toBe(s.t1.id)
    s.mail.update(s.t1.id, A, { state: 'done', outcome: 'dropped' })
    expect(() => open(B, s.t1.id)).toThrow(/parentId/)
    expect(s.mail.waitingOn(A, B)).toBe(0)
  })
})

describe('a pause wakes its owner once (§6)', () => {
  const settled = (s: ReturnType<typeof setup>, id: string) => s.store.mail.markDelivered(A, [id], [id], s.clock.t)

  it('the first wakes; the next, with other threads going, is recorded and starts no turn; the end of the work wakes again', () => {
    const s = setup()
    const first = s.handOn().thread
    const one = s.mail.reportTurn(s.t1.id, report())
    expect(one.message.wake).toBeNull()
    s.clock.t += 3_000
    expect(s.mail.drain(A, {}).wake).toBe(true)
    settled(s, one.message.id)
    // Another helper is handed on: the turn that ended with it is a pause again
    s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'd'), task: 'Another', origin: 'start_agent', parentId: s.t1.id })
    const two = s.mail.reportTurn(s.t1.id, report())
    expect(two.message).toMatchObject({ wake: 'no', body: expect.stringContaining('2 threads') })
    expect(two.message.facts.waitingOn).toHaveLength(2)
    s.clock.t += 3_000
    const drained = s.mail.drain(A, {})
    expect(drained.messageIds).toEqual([two.message.id])
    expect(drained.wake).toBe(false)
    expect(drained.text).toContain('waitingOn="2"')
    // The work ends: it wakes, as the end always does
    s.mail.update(first.id, B, { state: 'done', outcome: 'finished' })
    s.mail.update(s.store.mail.threadsOfParty(B, 'owner')[1]!.id, B, { state: 'done', outcome: 'finished' })
    const end = s.mail.reportTurn(s.t1.id, report())
    expect(end.message.wake).toBeNull()
    expect(end.thread.state).toBe('review')
  })

  it('the next pause wakes again once the owner or the person has posted work or a note in the thread', () => {
    const s = setup()
    s.handOn()
    s.mail.reportTurn(s.t1.id, report())
    s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'd'), task: 'Another', origin: 'start_agent', parentId: s.t1.id })
    expect(s.mail.reportTurn(s.t1.id, report()).message.wake).toBe('no')
    // The owner sends B more
    s.mail.post(s.t1.id, A, { kind: 'note', body: 'and the docs too' })
    s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'e'), task: 'A third', origin: 'start_agent', parentId: s.t1.id })
    expect(s.mail.reportTurn(s.t1.id, report()).message.wake).toBeNull()
    // And the person does
    s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'f'), task: 'A fourth', origin: 'start_agent', parentId: s.t1.id })
    expect(s.mail.reportTurn(s.t1.id, report()).message.wake).toBe('no')
    s.mail.post(s.t1.id, 'person', { kind: 'note', body: 'any news?' })
    s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'g'), task: 'A fifth', origin: 'start_agent', parentId: s.t1.id })
    expect(s.mail.reportTurn(s.t1.id, report()).message.wake).toBeNull()
  })

  it('a note from the one doing the work, or from a stranger, is not new work: the pause after it stays quiet', () => {
    const s = setup()
    s.handOn()
    s.mail.reportTurn(s.t1.id, report())
    s.mail.post(s.t1.id, B, { kind: 'note', body: 'working on it' })
    s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'd'), task: 'Another', origin: 'start_agent', parentId: s.t1.id })
    expect(s.mail.reportTurn(s.t1.id, report()).message.wake).toBe('no')
  })

  it('a pause on its own background work and one on threads are the same pause: the second is quiet', () => {
    const s = setup()
    s.mail.reportTurn(s.t1.id, report({ outcome: 'paused', paused: 1, then: 'running' }))
    s.handOn()
    expect(s.mail.reportTurn(s.t1.id, report()).message.wake).toBe('no')
    // And the other way round
    const t = setup()
    t.handOn()
    expect(t.mail.reportTurn(t.t1.id, report()).message.wake).toBeNull()
    t.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'd'), task: 'Another', origin: 'start_agent', parentId: t.t1.id })
    expect(t.mail.reportTurn(t.t1.id, report({ outcome: 'paused', paused: 1, then: 'running' })).message.wake).toBe('no')
  })

  it('a failure, or the person taking the work over, wakes whatever pauses came before', () => {
    const s = setup()
    s.handOn()
    expect(s.mail.reportTurn(s.t1.id, report()).message.wake).toBeNull()
    s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'd'), task: 'Another', origin: 'start_agent', parentId: s.t1.id })
    // The second pause is quiet; what follows is not
    expect(s.mail.reportTurn(s.t1.id, report()).message.wake).toBe('no')
    expect(s.mail.reportTurn(s.t1.id, report({ outcome: 'failed', error: 'network' })).message.wake).toBeNull()
  })
})

describe('a pause that does not wake, to an owner told the old way', () => {
  const draft = (over: Partial<ReportDraft> = {}): ReportDraft => ({ outcome: 'paused', body: '[Centralu] The assigned work paused.\nid: b', then: 'running', delivery: 'old', ...over })

  it('is recorded and tells nobody, unless the owner is in a turn, where the notice joins it and starts none', () => {
    for (const delivery of ['old', 'in-turn'] as const) {
      const s = setup()
      s.handOn()
      const record = reportRecorder(s.mail, s.store.mail)
      // The first pause wakes: told
      expect(record('a', 'b', draft({ delivery }))).toMatchObject({ keep: delivery === 'old' })
      s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'd'), task: 'Another', origin: 'start_agent', parentId: s.t1.id })
      // The next, with other threads going, does not
      expect(record('a', 'b', draft({ delivery }))).toBe('closed')
      expect(s.store.mail.lastReportBy(s.t1.id, 'centralu')?.wake).toBe('no')
      s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'e'), task: 'A third', origin: 'start_agent', parentId: s.t1.id })
      expect(record('a', 'b', draft({ delivery, ownerInTurn: true }))).toMatchObject({ keep: delivery === 'old' })
    }
  })

  it('is mailed to an owner that reads mail: its wake knows not to start a turn', () => {
    const s = setup()
    s.handOn()
    const record = reportRecorder(s.mail, s.store.mail)
    expect(record('a', 'b', draft({ delivery: 'wake' }))).toBe('mailed')
    s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'd'), task: 'Another', origin: 'start_agent', parentId: s.t1.id })
    expect(record('a', 'b', draft({ delivery: 'wake' }))).toBe('mailed')
    expect(s.store.mail.lastReportBy(s.t1.id, 'centralu')?.wake).toBe('no')
  })
})

describe('the same pause', () => {
  it('is told again when other threads are going, though there are as many as before: the ids are compared, not their number', () => {
    const s = setup()
    const first = s.handOn().thread
    s.mail.reportTurn(s.t1.id, report())
    // The first is over; another is going
    s.mail.update(first.id, B, { state: 'done', outcome: 'finished' })
    const second = s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'd'), task: 'Another', origin: 'start_agent', parentId: s.t1.id }).thread
    const next = s.mail.reportTurn(s.t1.id, report())
    expect(next.duplicate).toBe(false)
    expect(next.message.facts.waitingOn).toEqual([second.id])
  })

  it('is the same after an event of Centralu’s between the two: the last report is the one compared with', () => {
    const s = setup()
    s.handOn()
    const first = s.mail.reportTurn(s.t1.id, report())
    // A state change is an event of Centralu's in the thread (the owner's reply, a blocker...)
    s.mail.update(s.t1.id, A, { next: 'wait for the tests' })
    s.mail.addBlocker(s.t1.id, A, { kind: 'text', text: 'Mac only' })
    s.mail.resolveBlocker(s.t1.id, A, 1)
    expect(s.store.mail.messagesAfter(s.t1.id, first.message.seq).filter((m) => m.kind === 'event').length).toBeGreaterThan(1)
    expect(s.mail.reportTurn(s.t1.id, report())).toMatchObject({ duplicate: true, message: { id: first.message.id } })
  })
})

describe('a turn that ends while work handed on is going', () => {
  it('is not held while the work itself is blocked: the blocker is the owner’s to see', () => {
    // Not blocked, the same turn is held
    const free = setup()
    free.handOn()
    expect(free.mail.reportTurn(free.t1.id, report()).message.facts.outcome).toBe('paused')
    const s = setup()
    s.handOn()
    s.mail.addBlocker(s.t1.id, A, { kind: 'text', text: 'Mac only' })
    expect(s.store.mail.thread(s.t1.id)?.state).toBe('blocked')
    const posted = s.mail.reportTurn(s.t1.id, report())
    expect(posted.message.facts).toEqual({ outcome: 'finished', about: { session: B } })
    expect(posted.thread.state).toBe('blocked')
  })

  it('is a pause: the thread stays running, the report says how many threads it waits for, and nothing of theirs is in it', () => {
    const s = setup()
    const child = s.handOn().thread
    const posted = s.mail.reportTurn(s.t1.id, report())
    expect(posted.thread.state).toBe('running')
    expect(posted.message.facts).toEqual({ outcome: 'paused', about: { session: B }, waitingOn: [child.id] })
    expect(posted.message.body).toContain('paused')
    expect(posted.message.body).toContain('1 thread it handed on is still going')
    expect(posted.message.body).not.toContain('finished')
    expect(posted.message.body).not.toContain('Write the tests')
    expect(s.mail.waitingOn(A, B)).toBe(1)
    // What the owner is woken with: a count
    s.clock.t += 3_000
    expect(s.mail.drain(A, {}).text).toContain('outcome="paused"')
    expect(s.mail.drain(A, {}).text).toContain('waitingOn="1"')
  })

  it('says the same pause once: the turns that follow, with the same threads going, tell nobody anything new', () => {
    const s = setup()
    s.handOn()
    const first = s.mail.reportTurn(s.t1.id, report())
    const again = s.mail.reportTurn(s.t1.id, report())
    expect(again).toMatchObject({ duplicate: true, message: { id: first.message.id } })
    expect(s.store.mail.messagesAfter(s.t1.id, 0).filter((m) => m.kind === 'report')).toHaveLength(1)
    // Another thread handed on is news
    s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'd'), task: 'One more', origin: 'start_agent', parentId: s.t1.id })
    const more = s.mail.reportTurn(s.t1.id, report())
    expect(more.duplicate).toBe(false)
    expect(more.message.facts.waitingOn).toHaveLength(2)
  })

  it('is the work’s end once the threads handed on are over: finished, in review', () => {
    const s = setup()
    const child = s.handOn().thread
    s.mail.reportTurn(s.t1.id, report())
    s.mail.update(child.id, B, { state: 'done', outcome: 'finished' })
    expect(s.mail.waitingOn(A, B)).toBe(0)
    const last = s.mail.reportTurn(s.t1.id, report())
    expect(last.thread.state).toBe('review')
    expect(last.message.facts).toEqual({ outcome: 'finished', about: { session: B } })
  })

  it('is not held by a thread handed on that has been reported (it is in review: the owner of it has it)', () => {
    const s = setup()
    const child = s.handOn().thread
    s.mail.reportTurn(child.id, { to: B, about: C, outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    expect(s.store.mail.thread(child.id)?.state).toBe('review')
    expect(s.mail.reportTurn(s.t1.id, report()).thread.state).toBe('review')
    // Going, it is held
    const going = setup()
    going.handOn()
    expect(going.mail.reportTurn(going.t1.id, report()).thread.state).toBe('running')
  })

  it('does not hold a turn that failed, or the person taking the work over', () => {
    const s = setup()
    s.handOn()
    // A turn that finished is held; one that failed is not
    const finished = setup()
    finished.handOn()
    expect(finished.mail.reportTurn(finished.t1.id, report()).thread.state).toBe('running')
    const failed = s.mail.reportTurn(s.t1.id, report({ outcome: 'failed', error: 'network' }))
    expect(failed.thread.state).toBe('review')
    expect(failed.message.facts).toEqual({ outcome: 'failed', about: { session: B }, error: 'network' })
    const t2 = setup()
    t2.handOn()
    const taken = t2.mail.reportTurn(t2.t1.id, report({ outcome: 'took_over', then: 'dropped' }))
    expect(taken.thread).toMatchObject({ state: 'done', outcome: 'dropped' })
    expect(taken.message.facts.waitingOn).toBeUndefined()
  })

  it('names the threads too when it is paused on its own background work', () => {
    const s = setup()
    const child = s.handOn().thread
    const posted = s.mail.reportTurn(s.t1.id, report({ outcome: 'paused', paused: 2, then: 'running' }))
    expect(posted.message.facts).toEqual({ outcome: 'paused', about: { session: B }, paused: 2, waitingOn: [child.id] })
  })
})

describe('work handed on that nobody is doing', () => {
  it('does not hold the work paused: a thread whose helper was archived is not going, and the end is the end', () => {
    const s = setup()
    s.handOn()
    expect(s.mail.reportTurn(s.t1.id, report()).message.facts.outcome).toBe('paused')
    // The helper is archived: its thread is open with nobody on it
    s.mail.sessionGone('c')
    const orphan = s.store.mail.threadsOfParty(B, 'owner')[0]!
    expect(orphan).toMatchObject({ state: 'open', assignee: null })
    expect(s.mail.waitingOn(A, B)).toBe(0)
    const last = s.mail.reportTurn(s.t1.id, report())
    expect(last.duplicate).toBe(false)
    expect(last.thread.state).toBe('review')
    expect(last.message.facts).toEqual({ outcome: 'finished', about: { session: B } })
  })

  it('goes on holding it once the thread has someone again', () => {
    const s = setup()
    const child = s.handOn().thread
    s.mail.sessionGone('c')
    expect(s.mail.waitingOn(A, B)).toBe(0)
    s.mail.assign(child.id, B, { assignee: sessionAddress(HOST, 'd'), body: 'take it over' })
    expect(s.mail.waitingOn(A, B)).toBe(1)
  })
})

describe('a helper that is sent more', () => {
  it('works for the work it is sent more from: the thread takes that work as its parent, one level below', () => {
    const s = setup()
    // First handed on from no work at all, and reported
    const y = s.mail.recordDelegation(B, { assignee: C, task: 'Earlier', origin: 'start_agent' }).thread
    expect(y.parentId).toBeNull()
    s.mail.reportTurn(y.id, { to: B, about: C, outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    // B is now doing T1 and sends C more
    const again = s.mail.recordDelegation(B, { assignee: C, task: 'And more', origin: 'agent_session', parentId: s.t1.id })
    expect(again.continued).toBe(true)
    expect(again.thread).toMatchObject({ id: y.id, state: 'running', parentId: s.t1.id, depth: s.t1.depth + 1 })
    expect(s.mail.waitingOn(A, B)).toBe(1)
    expect(s.mail.reportTurn(s.t1.id, report()).message.facts.outcome).toBe('paused')
  })

  it('is not working for the work it once did when it is sent more from a turn that belongs to none', () => {
    const s = setup()
    const y = s.handOn().thread
    s.mail.reportTurn(y.id, { to: B, about: C, outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    const again = s.mail.recordDelegation(B, { assignee: C, task: 'For myself', origin: 'agent_session' })
    expect(again.thread).toMatchObject({ id: y.id, state: 'running', parentId: null })
    expect(s.mail.waitingOn(A, B)).toBe(0)
  })

  it('keeps the work it is already doing for when it is sent more from no work, and takes the new work when it is going', () => {
    const s = setup()
    const y = s.handOn().thread
    // Going already, sent more from no work: it is still the work's
    expect(s.mail.recordDelegation(B, { assignee: C, task: 'More', origin: 'agent_session' }).thread.parentId).toBe(s.t1.id)
    // Going for the work, sent more from another work of B's
    const t2 = s.mail.recordDelegation(sessionAddress(HOST, 'z'), { assignee: B, task: 'Other work', origin: 'start_agent' }).thread
    const moved = s.mail.recordDelegation(B, { assignee: C, task: 'For the other', origin: 'agent_session', parentId: t2.id }).thread
    expect(moved).toMatchObject({ id: y.id, parentId: t2.id })
  })
})

describe('a turn only the child’s report starts', () => {
  it('belongs to the work it was handed on from: its end is reported to whoever gave it', () => {
    const s = setup()
    const child = s.handOn().thread
    s.mail.reportTurn(child.id, { to: B, about: C, outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    s.clock.t += 3_000
    const drained = s.mail.drain(B, {})
    expect(drained.wake).toBe(true)
    expect(drained.threads).toEqual([child.id])
    expect(drained.workThread).toBe(s.t1.id)
  })

  it('is the other work’s when mail for other work of the receiver’s picked a thread too: the child’s report does not take the turn from it', () => {
    const s = setup()
    const child = s.handOn().thread
    // The person gives B another piece of work, which wakes it in the same delivery
    const other = s.mail.open('person', { kind: 'assign', subject: 'Other', body: 'also this', assignee: B }).thread
    s.mail.reportTurn(child.id, { to: B, about: C, outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    s.clock.t += 3_000
    const drained = s.mail.drain(B, {})
    expect(drained.threads).toContain(child.id)
    expect(drained.workThread).toBe(other.id)
    // Without the other work the child's report takes the turn for the work it was handed on from
    const alone = setup()
    const only = alone.handOn().thread
    alone.mail.reportTurn(only.id, { to: B, about: C, outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    alone.clock.t += 3_000
    expect(alone.mail.drain(B, {}).workThread).toBe(alone.t1.id)
  })

  it('is the thread’s own when the work it was opened under has not been started: the receiver is not in a turn of it', () => {
    const s = setup()
    const D = sessionAddress(HOST, 'd')
    const given = s.mail.open(A, { kind: 'assign', subject: 'Not yet', body: 'later', assignee: D })
    const waiting = given.thread
    expect(waiting.state).toBe('open')
    // The assign itself has been delivered: it is not what is picked here
    s.store.mail.markDelivered(D, [given.message.id], [given.message.id], s.clock.t)
    const child = s.mail.recordDelegation(D, { assignee: C, task: 'Early', origin: 'start_agent', parentId: waiting.id }).thread
    s.mail.reportTurn(child.id, { to: D, about: C, outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    s.clock.t += 3_000
    expect(s.mail.drain(D, {}).workThread).toBeNull()
    // Started, it is the work's
    s.mail.update(waiting.id, D, { state: 'running' })
    s.mail.reportTurn(child.id, { to: D, about: C, outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    s.mail.update(child.id, D, { state: 'running' })
    s.mail.reportTurn(child.id, { to: D, about: C, outcome: 'failed', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    s.clock.t += 3_000
    expect(s.mail.drain(D, {}).workThread).toBe(waiting.id)
  })

  it('is the thread’s own for a session that is not the one doing the work the thread was opened under', () => {
    const s = setup()
    const D = sessionAddress(HOST, 'd')
    const E = sessionAddress(HOST, 'e')
    // The person opens a thread for D under B's work: D is not doing T1
    const odd = s.mail.open('person', { kind: 'assign', subject: 'Odd', body: 'under T1', owner: D, assignee: E, parentId: s.t1.id }).thread
    s.mail.reportTurn(odd.id, { to: D, about: E, outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: e', then: 'review' })
    s.clock.t += 3_000
    const drained = s.mail.drain(D, {})
    expect(drained.threads).toEqual([odd.id])
    expect(drained.workThread).toBeNull()
    // The one doing it is in the work
    const own = s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'g'), task: 'Mine', origin: 'start_agent', parentId: s.t1.id }).thread
    s.mail.reportTurn(own.id, { to: B, about: sessionAddress(HOST, 'g'), outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    s.clock.t += 3_000
    expect(s.mail.drain(B, {}).workThread).toBe(s.t1.id)
  })

  it('is the thread’s own without a parent, or when the work is not going on any more', () => {
    const s = setup()
    const plain = s.handOn({ parentId: null }).thread
    s.mail.reportTurn(plain.id, { to: B, about: C, outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    s.clock.t += 3_000
    expect(s.mail.drain(B, {}).workThread).toBeNull()
    // Under the work, the same report takes the work's turn
    const under = s.mail.recordDelegation(B, { assignee: sessionAddress(HOST, 'h'), task: 'Under', origin: 'start_agent', parentId: s.t1.id }).thread
    s.mail.reportTurn(under.id, { to: B, about: sessionAddress(HOST, 'h'), outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    s.clock.t += 3_000
    expect(s.mail.drain(B, {}).workThread).toBe(s.t1.id)

    const t = setup()
    const child = t.handOn().thread
    t.mail.reportTurn(child.id, { to: B, about: C, outcome: 'finished', body: '[Centralu] The assigned work finished.\nid: c', then: 'review' })
    t.mail.update(t.t1.id, A, { state: 'done', outcome: 'dropped' })
    t.clock.t += 3_000
    expect(t.mail.drain(B, {}).workThread).toBeNull()
  })
})
