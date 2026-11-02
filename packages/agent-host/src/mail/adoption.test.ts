/**
 * What the host that becomes the active one does with what an earlier build left (docs/plans/mailbox.md §9.5): the old report paths are the truth of
 * a report owed until M8, and the task rows follow them at every `ready`. A report mark with no task gets one; a task no old path owes is settled.
 */
import { describe, expect, it } from 'vitest'
import { takeOverFromEarlierBuild, type AdoptedSession } from './adoption.js'
import { A, B, W, world } from './messages.test-helpers.js'
import { ADOPTED_TASK } from './rules.js'

function setup(sessions: Record<string, AdoptedSession> = {}, owesToo: (owner: string, child: string) => boolean = () => false) {
  const w = world()
  // As the manager answers it at ready: a mark the store still holds is owed (the start dropped the others), and whatever else the test says
  const owes = (o: string, c: string) => owesToo(o, c) || w.store.children.listReportMarks().some((m) => m.sessionId === c && m.callerSessionId === o)
  const known: Record<string, AdoptedSession> = { a: { state: 'idle' }, b: { state: 'idle' }, w: { askedBy: 'a', state: 'idle' }, ...sessions }
  const take = () => takeOverFromEarlierBuild(w.mail, w.store, { info: (id) => known[id], oldOwes: owes })
  return { ...w, take, known }
}

describe('a report mark with no task (§9.5 step 1)', () => {
  it('gets a task from the marking caller, delivered and read, start_agent when the caller started the session; nothing wakes anyone', () => {
    const w = setup()
    w.store.children.setReportMark('w', 'a')
    w.store.children.setReportMark('b', 'a')
    expect(w.take()).toEqual({ adopted: 2, settled: 0 })
    const kid = w.store.mailbox.newestTask(A, W)!
    expect(kid).toMatchObject({ kind: 'task', body: ADOPTED_TASK, origin: 'start_agent' })
    expect(w.store.mailbox.newestTask(A, B)).toMatchObject({ origin: 'send_to_session' })
    expect(w.rowOf(kid.id, W)).toMatchObject({ deliveredAt: expect.any(Number), readAt: expect.any(Number) })
    expect(w.store.mailbox.pendingFor(W, Number.MAX_SAFE_INTEGER)).toEqual([])
  })

  it('is idempotent: a pair with an unsettled task is left; a mark whose sessions are not both here, or that names one session twice, is left', () => {
    const w = setup({ b: undefined as unknown as AdoptedSession })
    w.mail.task(A, W, { text: 'given by this build', origin: 'start_agent', delivered: true })
    w.store.children.setReportMark('w', 'a')
    w.store.children.setReportMark('b', 'a')
    w.store.children.setReportMark('a', 'a')
    expect(w.take().adopted).toBe(0)
    expect(w.store.mailbox.watchedFrom(A)).toHaveLength(1)
  })
})

describe('a task the old paths no longer owe (§9.5 step 2)', () => {
  it('a report an older build sent by its marks while this one was away settles the task, with no report message', () => {
    const w = setup()
    const task = w.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    // The older build reported and cleared the mark: nothing owes it any more
    expect(w.take()).toEqual({ adopted: 0, settled: 1 })
    expect(w.rowOf(task.id, W).settled).toBe('reported')
    expect(w.store.mailbox.reportsOn(task.id)).toEqual([])
  })

  it('leaves a task that is owed, whose child is in a turn, has a queued request or undelivered mail from the owner, or is not here', () => {
    const owed = setup({}, (o, c) => o === 'a' && c === 'w')
    const t1 = owed.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    owed.take()
    expect(owed.rowOf(t1.id, W).settled).toBeNull()

    const busy = setup({ w: { askedBy: 'a', state: 'working' } })
    const t2 = busy.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    busy.take()
    expect(busy.rowOf(t2.id, W).settled).toBeNull()

    const waiting = setup()
    const t3 = waiting.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    waiting.mail.task(A, W, { text: 'more', origin: 'agent_session', delivered: false })
    waiting.take()
    expect(waiting.rowOf(t3.id, W).settled).toBeNull()

    const gone = setup({ w: undefined as unknown as AdoptedSession })
    const t4 = gone.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    gone.take()
    expect(gone.rowOf(t4.id, W).settled).toBeNull()

    // The same task with none of these is settled: the cases above stand only by the conditions they name
    const free = setup()
    const t5 = free.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    free.take()
    expect(free.rowOf(t5.id, W).settled).toBe('reported')
  })

  it('a crash between the old mark and the task row is mended at the next ready: the mark gets its task, then the report settles it', () => {
    const w = setup()
    w.store.children.setReportMark('w', 'a')
    // Crashed after the mark was written and before the task row: the next ready writes it
    expect(w.take().adopted).toBe(1)
    // The old path reported and cleared the mark; the host stopped before the row was settled: the next ready settles it
    w.store.children.clearReportMark('w')
    expect(w.take()).toEqual({ adopted: 0, settled: 1 })
  })
})
