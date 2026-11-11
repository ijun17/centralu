/**
 * What the host that becomes the active one does with an earlier build's report marks (docs/plans/mailbox.md §10.6.3): the task rows are the record
 * of an owed answer, so a mark with no task gets one, and every mark goes. A task no mark owes stays open for the session's reply or last response.
 */
import { describe, expect, it } from 'vitest'
import { leaveForEarlierBuild, takeOverFromEarlierBuild, type AdoptedSession } from './adoption.js'
import { A, B, W, world } from './messages.test-helpers.js'
import { ADOPTED_TASK } from './rules.js'

function setup(sessions: Record<string, AdoptedSession> = {}) {
  const w = world()
  const known: Record<string, AdoptedSession> = { a: { state: 'idle' }, b: { state: 'idle' }, w: { askedBy: 'a', state: 'idle' }, ...sessions }
  const take = () => takeOverFromEarlierBuild(w.mail, w.store, { info: (id) => known[id] })
  return { ...w, take, known }
}

describe('a report mark with no task (§10.6.3)', () => {
  it('gets a task from the marking caller, delivered and read, start_agent when the caller started the session; nothing wakes anyone', () => {
    const w = setup()
    w.store.children.setReportMark('w', 'a')
    w.store.children.setReportMark('b', 'a')
    expect(w.take()).toEqual({ queued: 0, adopted: 2 })
    expect(w.store.children.listReportMarks()).toEqual([])
    const kid = w.store.mailbox.newestTask(A, W)!
    expect(kid).toMatchObject({ kind: 'task', body: ADOPTED_TASK, origin: 'start_agent' })
    expect(w.store.mailbox.newestTask(A, B)).toMatchObject({ origin: 'send_to_session' })
    expect(w.rowOf(kid.id, W)).toMatchObject({ deliveredAt: expect.any(Number), readAt: expect.any(Number) })
    expect(w.store.mailbox.pendingFor(W, Number.MAX_SAFE_INTEGER)).toEqual([])
  })

  it('a pair with an unsettled task, a mark whose sessions are not both here, or one that names one session twice gets no task; each mark goes all the same', () => {
    const w = setup({ b: undefined as unknown as AdoptedSession })
    w.mail.task(A, W, { text: 'given by this build', origin: 'start_agent', delivered: true })
    w.store.children.setReportMark('w', 'a')
    w.store.children.setReportMark('b', 'a')
    w.store.children.setReportMark('a', 'a')
    expect(w.take().adopted).toBe(0)
    expect(w.store.mailbox.watchedFrom(A)).toHaveLength(1)
    expect(w.store.children.listReportMarks()).toEqual([])
  })
})

describe('a task no mark owes (§10.6.3)', () => {
  it('stays open at the start: nothing settles it but its reply or the last response, and a second start adds nothing', () => {
    const w = setup()
    const task = w.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    w.store.children.setReportMark('b', 'a')
    expect(w.take()).toEqual({ queued: 0, adopted: 1 })
    expect(w.take()).toEqual({ queued: 0, adopted: 0 })
    expect(w.rowOf(task.id, W).settled).toBeNull()
    const adopted = w.store.mailbox.newestTask(A, B)!
    expect(w.rowOf(adopted.id, B).settled).toBeNull()
    expect(w.store.mailbox.reportsOn(task.id)).toEqual([])
  })
})

describe('what this build leaves for an earlier one as it leaves (§10.6.3)', () => {
  it('a session in a turn gets one mark: the sender of the task its turn is the work of, not of a newer task that joined it', () => {
    const w = setup()
    const work = w.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    w.mail.task(B, W, { text: 'joined later', origin: 'send_to_session', delivered: true })
    w.store.mailbox.startTurn({ sessionId: 'w', turnSeq: 1, messageId: work.id, starterId: work.id, startedBy: 'caller', startedAt: 1 })
    leaveForEarlierBuild(w.mail, w.store, ['w'])
    expect(w.store.children.listReportMarks()).toEqual([{ sessionId: 'w', callerSessionId: 'a' }])
  })

  it('a turn that is no session’s task leaves the mark of the newest open task’s sender', () => {
    const w = setup()
    w.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    w.mail.task(B, W, { text: 'joined later', origin: 'send_to_session', delivered: true })
    w.store.mailbox.startTurn({ sessionId: 'w', turnSeq: 1, messageId: null, starterId: null, startedBy: 'person', startedAt: 1 })
    leaveForEarlierBuild(w.mail, w.store, ['w'])
    expect(w.store.children.listReportMarks()).toEqual([{ sessionId: 'w', callerSessionId: 'b' }])
  })
})
