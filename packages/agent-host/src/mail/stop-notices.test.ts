/**
 * Stop notices over message rows (docs/plans/turn-owned-by-no-one.md §4.1, P1): a session stopped without answering, so each question delivered to it
 * and not answered is released with the cause, and each sender is told once. Who is told, how often, who is woken, and what is not touched.
 */
import { describe, expect, it } from 'vitest'
import { PERSON } from './address.js'
import { MessageService, type StopWhy } from './messages.js'
import { A, B, C, HOST, ORC, world } from './messages.test-helpers.js'
import { wakesMessage } from './rules.js'

/** A world whose service also knows which sessions run a turn (`busy`), as the host answers it */
function stopWorld() {
  const w = world()
  const busy = new Set<string>()
  const stops = new MessageService(w.store.mailbox, w.reach, { hostId: HOST, now: () => w.clock.t, turn: (a) => w.turns.get(a) ?? null, atRest: (a) => !busy.has(a) })
  /** A question from `from` to `to`, delivered to it and not answered */
  const ask = (from: string, to: string, text = 'what does the build need?', over: { needsReply?: boolean } = {}) => {
    const m = w.send(from, { to: [to], text, needsReply: over.needsReply ?? true }).message
    w.records.markDelivered(to, [m.id], w.clock.t, null)
    return m
  }
  /** What Centralu told `who` since the start: the stop notices */
  const noticesTo = (who: string) => w.records.pendingFor(who, w.clock.t + 60_000).filter((p) => p.message.kind === 'notice' && p.message.facts.unanswered)
  return { ...w, busy, stops, ask, noticesTo }
}

const CAUSES: { why: StopWhy; says: string }[] = [
  { why: 'error', says: 'beta stopped with an error before it answered' },
  { why: 'limit', says: 'beta reached its usage limit before it answered' },
  { why: 'network', says: 'beta lost the network before it answered' },
  { why: 'interrupted', says: "beta's tool interrupted its turn before it answered" },
  { why: 'stopped', says: 'beta was stopped before it answered' },
  { why: 'uncontinued', says: 'Centralu could not continue beta after an update or restart' },
  { why: 'quit', says: 'Centralu quit while beta worked on' },
  { why: 'shutdown', says: 'the computer shut down, restarted or signed out while it worked' },
]

describe('a session stops without answering a question', () => {
  it.each(CAUSES)('$why: the question is released with that cause, its sender is told once in plain words, and the question stays open', ({ why, says }) => {
    const w = stopWorld()
    const q = w.ask(A, B)
    expect(w.stops.sessionStopped(B, why, { quiet: why === 'quit' || why === 'shutdown' })).toBe(1)

    expect(w.rowOf(q.id, B)).toMatchObject({ releasedWhy: why, toldAt: w.clock.t, settled: null })
    const [told, ...rest] = w.noticesTo(A)
    expect(rest).toEqual([])
    expect(told?.message).toMatchObject({ sender: 'centralu', kind: 'notice', facts: { unanswered: [{ id: q.id, recipient: B, why }] } })
    expect(told?.message.body).toContain(says)
    expect(told?.message.body).toContain(q.id)
    // Short and plain: what happened, and what the reader can do; none of the tool's own words
    expect(told?.message.body.split('\n')).toHaveLength(1)
    expect(told?.message.body).not.toContain('no longer watched')
  })

  it('wakes a sender at rest, except for a quit or a shutdown, which wake no one: a restart does not wake every sender that waits (Q1)', () => {
    for (const why of ['error', 'limit', 'network', 'interrupted', 'stopped', 'uncontinued'] as const) {
      const w = stopWorld()
      w.ask(A, B)
      w.stops.sessionStopped(B, why)
      const [told] = w.noticesTo(A)
      expect(told?.message.facts.quiet, why).toBeUndefined()
      expect(wakesMessage(told!.message), why).toBe(true)
    }
    for (const why of ['quit', 'shutdown'] as const) {
      const w = stopWorld()
      w.ask(A, B)
      w.stops.sessionStopped(B, why, { quiet: true })
      const [told] = w.noticesTo(A)
      expect(told?.message.facts.quiet, why).toBe(true)
      expect(wakesMessage(told!.message), why).toBe(false)
    }
  })

  it('a sender in a turn reads the notice with its other mail instead of waking again after the turn', () => {
    const w = stopWorld()
    w.ask(A, B)
    w.ask(C, B)
    w.busy.add(A)
    w.stops.sessionStopped(B, 'error')
    expect(wakesMessage(w.noticesTo(A)[0]!.message)).toBe(false)
    // C is at rest and waits on B: it is woken
    expect(wakesMessage(w.noticesTo(C)[0]!.message)).toBe(true)
  })

  it('tells each sender once for all its questions, and nothing again for a second stop or a second call', () => {
    const w = stopWorld()
    const q1 = w.ask(A, B, 'first')
    const q2 = w.ask(A, B, 'second')
    const other = w.ask(C, B, 'third')
    expect(w.stops.sessionStopped(B, 'limit')).toBe(3)

    const toA = w.noticesTo(A)
    expect(toA).toHaveLength(1)
    expect(toA[0]?.message.facts.unanswered).toEqual([
      { id: q1.id, recipient: B, why: 'limit' },
      { id: q2.id, recipient: B, why: 'limit' },
    ])
    expect(toA[0]?.message.body).toContain(`${q1.id}, ${q2.id}`)
    expect(w.noticesTo(C)[0]?.message.facts.unanswered).toEqual([{ id: other.id, recipient: B, why: 'limit' }])

    // The rows are released: the same stop again, or another stop of the same session before it was continued, tells no one
    expect(w.stops.sessionStopped(B, 'limit')).toBe(0)
    expect(w.stops.sessionStopped(B, 'error')).toBe(0)
    expect(w.noticesTo(A)).toHaveLength(1)
    expect(w.noticesTo(C)).toHaveLength(1)

    // A question asked after the session was continued is a new one: its stop is told on its own
    const later = w.ask(A, B, 'fourth')
    expect(w.stops.sessionStopped(B, 'error')).toBe(1)
    expect(w.noticesTo(A).map((n) => n.message.facts.unanswered)).toContainEqual([{ id: later.id, recipient: B, why: 'error' }])
  })

  it("tells the person in the Inbox when it was the person's question, and wakes nothing", () => {
    const w = stopWorld()
    const q = w.ask(PERSON, B, 'which branch is the release on?')
    w.stops.sessionStopped(B, 'error')
    const [told, ...rest] = w.noticesTo(PERSON)
    expect(rest).toEqual([])
    expect(told?.message).toMatchObject({ sender: 'centralu', kind: 'notice', facts: { unanswered: [{ id: q.id, recipient: B, why: 'error' }] } })
    expect(told?.message.body).toContain('beta stopped with an error before it answered')
    expect(w.rowOf(q.id, B)).toMatchObject({ releasedWhy: 'error', toldAt: w.clock.t })
    // Once
    expect(w.stops.sessionStopped(B, 'error')).toBe(0)
    expect(w.noticesTo(PERSON)).toHaveLength(1)
  })

  it('a sender the older report paths tell of the same stop gets its rows released and marked told, and no second notice', () => {
    const w = stopWorld()
    const q = w.ask(A, B)
    const other = w.ask(C, B)
    expect(w.stops.sessionStopped(B, 'error', { told: [A] })).toBe(2)
    expect(w.rowOf(q.id, B)).toMatchObject({ releasedWhy: 'error', toldAt: w.clock.t })
    expect(w.noticesTo(A)).toEqual([])
    expect(w.noticesTo(C)).toHaveLength(1)
    expect(w.rowOf(other.id, B)).toMatchObject({ releasedWhy: 'error' })
  })

  it("the person's notice is worded for the person, and only what is released now is listed, not the rows older builds released untold", () => {
    const w = stopWorld()
    const old = w.ask(PERSON, C, 'an old question')
    w.records.markReleased(old.id, C, w.clock.t, 'gone')
    w.clock.t += 1000
    const q = w.ask(PERSON, B, 'are you done?')
    w.stops.sessionStopped(B, 'quit', { quiet: true })
    const [told, ...rest] = w.noticesTo(PERSON)
    expect(rest).toEqual([])
    expect(told?.message.facts.unanswered).toEqual([{ id: q.id, recipient: B, why: 'quit' }])
    expect(told?.message.body).toContain('Send it a message when you want it to go on.')
    expect(told?.message.body).not.toContain('The person decides')
    expect(w.rowOf(old.id, C)).toMatchObject({ toldAt: null })

    // An S3 line is worded for the person too: nothing about needsReply or asking the person
    const gone = w.ask(PERSON, C, 'another')
    w.mail.partyGone(C)
    const bodies = w.noticesTo(PERSON).map((n) => n.message.body)
    expect(bodies.some((b) => b.includes(`1 of your messages went unanswered:`) && b.includes(gone.id))).toBe(true)
    expect(bodies.join(' ')).not.toContain('needsReply')
    expect(bodies.join(' ')).not.toContain('ask the person')
  })

  it('tells a sender of several causes in one notice, a sentence for each session and cause', () => {
    const w = stopWorld()
    const mine = w.ask(A, B, 'ask b')
    const yours = w.ask(A, C, 'ask c')
    w.stops.sessionStopped(B, 'network')
    w.stops.sessionStopped(C, 'error')
    // Told as each stopped: a stop is a notice of its own, not held until the others come
    const notices = w.noticesTo(A).map((n) => n.message.body)
    expect(notices).toHaveLength(2)
    expect(notices[0]).toContain(`beta lost the network before it answered ${mine.id}`)
    expect(notices[1]).toContain(`gamma stopped with an error before it answered ${yours.id}`)
  })

  it('leaves what is not a question alone: a task, a message that needs no reply, one not delivered yet, one already answered, a request to the orchestrator', () => {
    const w = stopWorld()
    const task = w.mail.task(A, B, { text: 'work', origin: 'start_agent', delivered: true })
    // Even a task that were marked as needing a reply is the report path's, not this one's
    w.db.prepare(`UPDATE mail SET needs_reply = 1 WHERE id = ?`).run(task.id)
    const fyi = w.ask(A, B, 'fyi', { needsReply: false })
    const waiting = w.send(A, { to: [B], text: 'not delivered', needsReply: true }).message
    const answered = w.ask(C, B, 'answered one')
    w.send(B, { replyTo: answered.id, text: 'here' })
    const request = w.ask(A, ORC, 'can you look at CI?')

    expect(w.stops.sessionStopped(B, 'error')).toBe(0)
    expect(w.stops.sessionStopped(ORC, 'error')).toBe(0)
    for (const [id, who] of [[task.id, B], [fyi.id, B], [waiting.id, B], [request.id, ORC]] as const) expect(w.rowOf(id, who)).toMatchObject({ releasedAt: null, toldAt: null })
    expect(w.rowOf(task.id, B)).toMatchObject({ settled: null })
    expect(w.noticesTo(A)).toEqual([])
    expect(w.noticesTo(C)).toEqual([])
  })

  it('a reply after the stop still answers the question: the row was released, not settled', () => {
    const w = stopWorld()
    const q = w.ask(A, B)
    w.stops.sessionStopped(B, 'stopped')
    expect(w.rowOf(q.id, B)).toMatchObject({ settled: null, releasedWhy: 'stopped' })

    const reply = w.send(B, { replyTo: q.id, text: 'main' }).message
    expect(w.rowOf(q.id, B)).toMatchObject({ settled: 'answered', answerId: reply.id })
    expect(w.noticesTo(A)).toHaveLength(1)
  })

  it('does not run on a task alone: a session that owes only a task tells no one here (the old report path tells its owner)', () => {
    const w = stopWorld()
    w.mail.task(A, B, { text: 'work', origin: 'start_agent', delivered: true })
    expect(w.stops.sessionStopped(B, 'error')).toBe(0)
    expect(w.records.pendingFor(A, w.clock.t + 60_000).filter((p) => p.message.kind === 'notice')).toEqual([])
  })
})
