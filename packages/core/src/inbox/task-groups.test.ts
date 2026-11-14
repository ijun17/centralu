import { describe, expect, it } from 'vitest'
import type { MailParty, MailTaskRow } from '@cc/protocol'
import { groupTasks, openTaskCount, shownTasks, taskKey } from './task-groups.js'

const session = (name: string): MailParty => ({ address: `session:h/${name}`, kind: 'session', sessionId: name, name, state: null })
const PERSON: MailParty = { address: 'person', kind: 'person', sessionId: null, name: null, state: null }
let n = 0
const task = (over: Partial<MailTaskRow>): MailTaskRow => {
  n += 1
  return { id: `m${n}`, root: `m${n}`, subject: `task ${n}`, kind: 'assign', owner: session('lead'), assignee: session('worker'), state: 'open', outcome: null, createdAt: n, updatedAt: n, ...over }
}
const ids = (rows: readonly MailTaskRow[]) => rows.map((t) => t.id)

describe('grouping the tasks by who acts next', () => {
  it('puts a question to the person and a reported task of theirs under Needs you, what another party has under Waiting on others, released work under Unassigned and settled work under Done', () => {
    const asked = task({ kind: 'question', assignee: PERSON })
    const review = task({ owner: PERSON, state: 'review' })
    const open = task({})
    const running = task({ state: 'running' })
    const released = task({ state: 'released' })
    const done = task({ state: 'done', outcome: 'reported' })
    const g = groupTasks([asked, review, open, running, released, done])
    expect(ids(g.needsYou)).toEqual([asked.id, review.id])
    expect(ids(g.waitingOnOthers)).toEqual([running.id, open.id])
    expect(ids(g.unassigned)).toEqual([released.id])
    expect(ids(g.done)).toEqual([done.id])
  })

  it('lets a state word it does not know wait on others, and a released or settled question to the person leave Needs you', () => {
    const queued = task({ state: 'queued' })
    const gone = task({ assignee: PERSON, state: 'released' })
    const answered = task({ assignee: PERSON, state: 'done', outcome: 'answered' })
    const g = groupTasks([queued, gone, answered])
    expect(ids(g.waitingOnOthers)).toEqual([queued.id])
    expect(g.needsYou).toEqual([])
    expect(ids(g.unassigned)).toEqual([gone.id])
    expect(ids(g.done)).toEqual([answered.id])
  })

  it('keeps each group newest first, with the questions, then what is held, then the reviews in Needs you however new a review is', () => {
    const oldAsk = task({ assignee: PERSON, updatedAt: 1 })
    const newReview = task({ owner: PERSON, state: 'review', updatedAt: 50 })
    const newAsk = task({ assignee: PERSON, updatedAt: 40 })
    // Held for the person between two sessions: nobody can act on it until the person does
    const held = task({ state: 'held', updatedAt: 45 })
    const a = task({ updatedAt: 5 })
    const b = task({ updatedAt: 9 })
    const g = groupTasks([oldAsk, newReview, a, held, newAsk, b])
    expect(ids(g.needsYou)).toEqual([newAsk.id, oldAsk.id, held.id, newReview.id])
    expect(ids(g.waitingOnOthers)).toEqual([b.id, a.id])
  })

  it('shows Done only unfolded, counts what is not done, and names a row by its message and recipient', () => {
    const open = task({})
    const done = task({ state: 'done' })
    const g = groupTasks([open, done])
    expect(ids(shownTasks(g, false))).toEqual([open.id])
    expect(ids(shownTasks(g, true))).toEqual([open.id, done.id])
    expect(openTaskCount(g)).toBe(1)
    expect(taskKey(task({ id: 'x', assignee: session('a') }))).not.toBe(taskKey(task({ id: 'x', assignee: session('b') })))
  })
})
