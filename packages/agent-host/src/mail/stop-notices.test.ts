/**
 * Stop notices over message rows (docs/plans/turn-owned-by-no-one.md §4.1, P1): a session stopped without answering, so each question delivered to it
 * and not answered is released with the cause, and each sender is told once. Who is told, how often, who is woken, and what is not touched.
 */
import { describe, expect, it } from 'vitest'
import { PERSON } from './address.js'
import { MessageService, type StopWhy } from './messages.js'
import { A, B, C, HOST, ORC, world } from './messages.test-helpers.js'
import { wakesMessage } from './rules.js'

/**
 * A world whose service also knows which sessions run a turn (`busy`) and which wait on another by more than a task (`waits`: "sender>stopped"), as the
 * host answers it. Every stop here is of turn 1, the turn `ask` delivers into
 */
function stopWorld() {
  const w = world()
  const busy = new Set<string>()
  const waits = new Set<string>()
  const service = new MessageService(w.store.mailbox, w.reach, { hostId: HOST, now: () => w.clock.t, turn: (a) => w.turns.get(a) ?? null, atRest: (a) => !busy.has(a), waitsOn: (sender, stopped) => waits.has(`${sender}>${stopped}`) })
  const stops = {
    sessionStopped: (who: string, why: StopWhy, o: { quiet?: boolean; told?: readonly string[]; held?: readonly string[]; turnSeq?: number | null } = {}) => service.sessionStopped(who, why, { turnSeq: 1, ...o }),
    sessionsStopped: service.sessionsStopped.bind(service),
    oldPathEnded: service.oldPathEnded.bind(service),
  }
  /** A question from `from` to `to`, delivered to it in its turn `turn` and not answered */
  const ask = (from: string, to: string, text = 'what does the build need?', over: { needsReply?: boolean; turn?: number | null } = {}) => {
    const m = w.send(from, { to: [to], text, needsReply: over.needsReply ?? true }).message
    w.records.markDelivered(to, [m.id], w.clock.t, over.turn === undefined ? 1 : over.turn)
    return m
  }
  /** What Centralu told `who` since the start: the stop notices */
  const noticesTo = (who: string) => w.records.pendingFor(who, w.clock.t + 60_000).filter((p) => p.message.kind === 'notice' && p.message.facts.unanswered)
  return { ...w, busy, waits, stops, ask, noticesTo }
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

  it('wakes only a sender that is at rest and waits on the stopped session: by a task it gave that is still open, or by a wait (Q1)', () => {
    for (const why of ['error', 'limit', 'network', 'interrupted', 'stopped', 'uncontinued'] as const) {
      // A task it gave B, still open
      const w = stopWorld()
      w.mail.task(A, B, { text: 'work', origin: 'start_agent', delivered: true })
      w.ask(A, B)
      w.stops.sessionStopped(B, why)
      const [told] = w.noticesTo(A)
      expect(told?.message.facts.quiet, why).toBeUndefined()
      expect(wakesMessage(told!.message), why).toBe(true)
    }
    // A wait the host reports (a blocking wait, a child it started whose report it is owed)
    const waiting = stopWorld()
    waiting.waits.add(`${A}>${B}`)
    waiting.ask(A, B)
    waiting.stops.sessionStopped(B, 'error')
    expect(wakesMessage(waiting.noticesTo(A)[0]!.message)).toBe(true)
  })

  it('a sender that waits on nothing of the stopped session reads the notice with its next mail: it is not woken', () => {
    const w = stopWorld()
    w.ask(A, B)
    // C waits on another session, not on B
    w.mail.task(C, ORC, { text: 'work', origin: 'start_agent', delivered: true })
    w.ask(C, B)
    w.waits.add(`${C}>${ORC}`)
    w.stops.sessionStopped(B, 'error')
    for (const who of [A, C]) {
      const [told, ...rest] = w.noticesTo(who)
      expect(rest).toEqual([])
      expect(told?.message.facts.quiet, who).toBe(true)
      expect(wakesMessage(told!.message), who).toBe(false)
    }
  })

  it('a quit or a shutdown wakes no one, a sender that waits included: a restart must not wake every sender', () => {
    for (const why of ['quit', 'shutdown'] as const) {
      const w = stopWorld()
      w.mail.task(A, B, { text: 'work', origin: 'start_agent', delivered: true })
      w.ask(A, B)
      w.stops.sessionStopped(B, why, { quiet: true })
      const [told] = w.noticesTo(A)
      expect(told?.message.facts.quiet, why).toBe(true)
      expect(wakesMessage(told!.message), why).toBe(false)
    }
  })

  it('a sender in a turn reads the notice with its other mail instead of waking again after the turn, though it waits', () => {
    const w = stopWorld()
    w.mail.task(A, B, { text: 'work', origin: 'start_agent', delivered: true })
    w.mail.task(C, B, { text: 'work', origin: 'start_agent', delivered: true })
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
    // In plain words for the person: the session's name, and no message id or session address
    expect(told?.message.body).toBe('beta stopped with an error before it answered your message. It keeps its conversation; send it a message to go on.')
    expect(told?.message.body).not.toContain(q.id)
    expect(told?.message.body).not.toContain(B)
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

  it('the person is not told what they did themselves: their own Stop, or deleting a session', () => {
    const w = stopWorld()
    const stopped = w.ask(PERSON, B, 'are you done?')
    w.stops.sessionStopped(B, 'stopped')
    const gone = w.ask(PERSON, C, 'and you?')
    w.mail.partyGone(C)
    expect(w.rowOf(stopped.id, B)).toMatchObject({ releasedWhy: 'stopped' })
    expect(w.rowOf(gone.id, C)).toMatchObject({ releasedWhy: 'gone' })
    expect(w.noticesTo(PERSON)).toEqual([])
    // What they did not do themselves is told
    w.ask(PERSON, B, 'once more')
    w.stops.sessionStopped(B, 'limit')
    expect(w.noticesTo(PERSON)).toHaveLength(1)
  })

  it("the person's notice is worded for the person: the session's name and no ids or addresses, only what is released now, and no advice for agents", () => {
    const w = stopWorld()
    const old = w.ask(PERSON, C, 'an old question')
    w.records.markReleased(old.id, C, w.clock.t, 'lost')
    w.clock.t += 1000
    const q = w.ask(PERSON, B, 'are you done?')
    w.stops.sessionStopped(B, 'quit', { quiet: true })
    const [told, ...rest] = w.noticesTo(PERSON)
    expect(rest).toEqual([])
    expect(told?.message.facts.unanswered).toEqual([{ id: q.id, recipient: B, why: 'quit' }])
    expect(told?.message.body).toBe('Centralu quit while beta worked on your message, so it did not answer. Send it a message when you want it to go on.')
    expect(w.rowOf(old.id, C)).toMatchObject({ toldAt: null })

    // A line of the older causes is worded for the person too: nothing about needsReply or asking the person, and no id or address
    const lost = w.ask(PERSON, C, 'another')
    w.mail.turnsLost(() => [{ address: C, turnSeq: 1 }])
    const body = w.noticesTo(PERSON).map((n) => n.message.body).find((x) => x.startsWith('1 of your messages went unanswered:'))
    expect(body).toContain('- gamma: ')
    for (const hidden of [lost.id, C, 'needsReply', 'ask the person']) expect(body).not.toContain(hidden)
  })

  it('a quit that cuts several sessions tells the person once, and a sender that asked several once: one notice, not one per session', () => {
    const w = stopWorld()
    const mine = [w.ask(PERSON, B, 'first'), w.ask(PERSON, C, 'second')]
    const asked = [w.ask(A, B, 'third'), w.ask(A, C, 'fourth')]
    expect(
      w.stops.sessionsStopped(
        [
          { address: B, why: 'quit', turnSeq: 1 },
          { address: C, why: 'quit', turnSeq: 1 },
        ],
        true,
      ),
    ).toBe(4)
    const toPerson = w.noticesTo(PERSON)
    expect(toPerson).toHaveLength(1)
    expect(toPerson[0]?.message.body).toContain('beta')
    expect(toPerson[0]?.message.body).toContain('gamma')
    expect(toPerson[0]?.message.facts.unanswered?.map((u) => u.id)).toEqual(mine.map((m) => m.id))
    const toA = w.noticesTo(A)
    expect(toA).toHaveLength(1)
    expect(toA[0]?.message.facts.unanswered?.map((u) => u.id)).toEqual(asked.map((m) => m.id))
  })

  it('releases only the questions delivered into the turn that was cut, not one the session read in an earlier turn or outside any turn', () => {
    const w = stopWorld()
    // Answered in conversation, not by a reply: the question is still open, and was read in turn 1
    const earlier = w.ask(A, B, 'which branch?', { turn: 1 })
    const outside = w.ask(A, B, 'when you can', { turn: null })
    const cut = w.ask(C, B, 'what now?', { turn: 2 })
    expect(w.stops.sessionStopped(B, 'stopped', { turnSeq: 2 })).toBe(1)
    expect(w.rowOf(cut.id, B)).toMatchObject({ releasedWhy: 'stopped', toldAt: w.clock.t })
    for (const m of [earlier, outside]) expect(w.rowOf(m.id, B)).toMatchObject({ releasedAt: null, toldAt: null })
    expect(w.noticesTo(A)).toEqual([])
    expect(w.noticesTo(C)).toHaveLength(1)

    // A stop of no recorded turn releases nothing
    expect(w.stops.sessionStopped(B, 'error', { turnSeq: null })).toBe(0)
    expect(w.rowOf(earlier.id, B)).toMatchObject({ releasedAt: null })
  })

  it('a message a session sent itself is not a question to it: a handoff to the very session that asked leaves such a row', () => {
    const w = stopWorld()
    const own = w.ask(B, C, 'a question for C')
    // C's work was handed to B, which asked it: the row's sender is its recipient
    w.db.prepare(`UPDATE mail_recipients SET recipient = ? WHERE message_id = ?`).run(B, own.id)
    const other = w.ask(A, B, 'a question for B')
    expect(w.stops.sessionStopped(B, 'error')).toBe(1)
    expect(w.rowOf(own.id, B)).toMatchObject({ releasedAt: null, toldAt: null })
    expect(w.rowOf(other.id, B)).toMatchObject({ releasedWhy: 'error' })
    expect(w.noticesTo(B)).toEqual([])
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

  it('leaves what is not a question alone: a task, a message that needs no reply, one not delivered yet, one already answered; a request to the Assistant is one', () => {
    const w = stopWorld()
    const task = w.mail.task(A, B, { text: 'work', origin: 'start_agent', delivered: true })
    // Even a task that were marked as needing a reply is the report path's, not this one's
    w.db.prepare(`UPDATE mail SET needs_reply = 1 WHERE id = ?`).run(task.id)
    const fyi = w.ask(A, B, 'fyi', { needsReply: false })
    const waiting = w.send(A, { to: [B], text: 'not delivered', needsReply: true }).message
    const answered = w.ask(C, B, 'answered one')
    w.send(B, { replyTo: answered.id, text: 'here' })
    const request = w.ask(C, ORC, 'can you look at CI?')

    expect(w.stops.sessionStopped(B, 'error')).toBe(0)
    for (const id of [task.id, fyi.id, waiting.id]) expect(w.rowOf(id, B)).toMatchObject({ releasedAt: null, toldAt: null })
    expect(w.rowOf(task.id, B)).toMatchObject({ settled: null })
    expect(w.noticesTo(A)).toEqual([])
    expect(w.noticesTo(C)).toEqual([])
    // Its sender always learns it will not be answered (owner, #1186)
    expect(w.stops.sessionStopped(ORC, 'error')).toBe(1)
    expect(w.rowOf(request.id, ORC)).toMatchObject({ releasedWhy: 'error', toldAt: w.clock.t })
    expect(w.noticesTo(C)).toHaveLength(1)
  })

  it.each(CAUSES)("$why: a request to the Assistant is released with that cause and its sender told, as a crash's turnsLost tells it 'lost'", ({ why }) => {
    const w = stopWorld()
    const request = w.ask(A, ORC, 'can you look at CI?')
    const quiet = why === 'quit' || why === 'shutdown'
    expect(w.stops.sessionStopped(ORC, why, { quiet })).toBe(1)
    expect(w.rowOf(request.id, ORC)).toMatchObject({ releasedWhy: why, toldAt: w.clock.t, settled: null })
    const [told, ...rest] = w.noticesTo(A)
    expect(rest).toEqual([])
    expect(told?.message.facts.unanswered).toEqual([{ id: request.id, recipient: ORC, why }])
    expect(told?.message.body).toContain(request.id)
  })

  it('the asker the request turn’s own report tells is held for that report: told by it, no second notice; missed by it, the stop notice', () => {
    for (const reported of [true, false]) {
      const w = stopWorld()
      const request = w.ask(A, ORC, 'can you look at CI?')
      // Another session's request rode in the same turn: no report is owed to it, so it is told now
      const other = w.ask(C, ORC, 'and the release?')
      expect(w.stops.sessionStopped(ORC, 'stopped', { held: [A] })).toBe(2)
      expect(w.noticesTo(A), String(reported)).toEqual([])
      expect(w.noticesTo(C).map((n) => n.message.facts.unanswered)).toEqual([[{ id: other.id, recipient: ORC, why: 'stopped' }]])
      w.stops.oldPathEnded(ORC, A, reported)
      expect(w.noticesTo(A), String(reported)).toHaveLength(reported ? 0 : 1)
      expect(w.rowOf(request.id, ORC)).toMatchObject({ releasedWhy: 'stopped', toldAt: w.clock.t })
    }
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
