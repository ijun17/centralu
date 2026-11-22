import { describe, expect, it } from 'vitest'
import { parseAddress, sessionAddress } from './address.js'
import { A, B, C, HOST, world } from './messages.test-helpers.js'
import { MailReminders } from './reminders.js'
import type { RestFacts } from './rest.js'
import { HOUR_MS, MINUTE_MS, REMINDER } from './rules.js'

/**
 * The unanswered reminder (docs/plans/mailbox.md §10, M5) over a real store and message service: the host's facts about each session are a table
 * the test edits, every count and clock is read from the store, and time moves only by the test's clock
 */
function harness() {
  const w = world()
  const over = new Map<string, Partial<RestFacts>>()
  const lines: string[] = []
  const idOf = (address: string) => {
    const p = parseAddress(address)
    return p?.kind === 'session' ? p.sessionId : ''
  }
  const facts = (address: string): RestFacts | null => {
    const p = parseAddress(address)
    if (p?.kind !== 'session' || p.host !== HOST) return null
    return {
      receiver: { kind: 'ready', live: true, quiet: true },
      error: false,
      interrupted: false,
      work: 0,
      workKnown: true,
      mailWaiting: false,
      lastTurn: w.records.lastTurnEnded(p.sessionId),
      ...over.get(address),
    }
  }
  const make = () => new MailReminders(w.mail, w.records, facts, { now: () => w.clock.t, log: (l) => lines.push(l) })
  let reminders = make()

  /** `to`'s turn `starter` started, ended now: the rows given in it are delivered into it */
  function turn(to: string, starter: string | null, given: readonly string[] = [], opts: { person?: boolean } = {}): number {
    const t = w.startTurn(to, starter, opts.person ? { by: 'person' } : {})
    if (opts.person) w.db.prepare(`UPDATE mail_turns SET started_by = 'person' WHERE session_id = ? AND turn_seq = ?`).run(idOf(to), t.turnSeq)
    if (given.length) w.records.markDelivered(to, given, w.clock.t, t.turnSeq)
    w.clock.t += 1_000
    w.records.endTurn(idOf(to), t.turnSeq, w.clock.t, 'acted')
    return t.turnSeq
  }
  /** `from` asks `to` something that needs a reply, and `to` reads it in a turn of its own */
  function ask(from: string, to: string, text = 'what is the build status?'): string {
    const id = w.send(from, { to: [to], text, needsReply: true }).message.id
    turn(to, id, [id])
    return id
  }
  /** The reminders and unanswered notices Centralu wrote to `to`, oldest first */
  const followUps = (to: string) => w.records.followUpsTo(to, 0).map((r) => w.message(r.messageId))
  /** The newest follow-up to `to` is delivered, in a turn of its own that ends now */
  const deliverFollowUp = (to: string) => {
    const n = followUps(to).at(-1)
    if (!n) throw new Error('no follow-up')
    return turn(to, n.id, [n.id])
  }
  const minutes = (m: number) => {
    w.clock.t += m * MINUTE_MS
  }
  const sweep = () => reminders.sweep()
  const restart = () => {
    reminders = make()
  }
  return { w, over, lines, ask, turn, followUps, deliverFollowUp, minutes, sweep, restart }
}

describe('MailReminders (docs/plans/mailbox.md §10)', () => {
  it('reminds a session at rest 2 minutes after it came to rest, once, inline in its wake, and counts it once delivered', () => {
    const h = harness()
    const q = h.ask(A, B)
    h.sweep()
    expect(h.followUps(B)).toEqual([])
    h.minutes(1)
    h.sweep()
    expect(h.followUps(B)).toEqual([])
    h.minutes(1.5)
    h.sweep()
    h.sweep()
    const [reminder, ...more] = h.followUps(B)
    expect(more).toEqual([])
    expect(reminder?.facts).toMatchObject({ reminder: 1, of: [q], reason: 'reminder' })
    expect(reminder?.body).toContain(`- ${q} from `)
    expect(reminder?.body).toContain('Centralu reminds you once more if they are still open, and not after that.')
    // Centralu's words flow down into the wake: the session reads which messages without a read
    h.w.clock.t += 3_000
    const wake = h.w.mail.drain(B)
    expect(wake.inline).toEqual([reminder?.id])
    expect(h.w.rowOf(q, B).reminded).toBe(0)
    h.deliverFollowUp(B)
    expect(h.w.rowOf(q, B).reminded).toBe(1)
    // Given again (a delivery the tool failed late), it counts nothing more
    h.w.records.markDelivered(B, [reminder?.id ?? ''], h.w.clock.t, null)
    expect(h.w.rowOf(q, B).reminded).toBe(1)
  })

  it('reminds a second time 20 minutes after the first one\'s turn ended, then releases the row 20 minutes after the second, and tells its sender once', () => {
    const h = harness()
    const q = h.ask(A, B)
    h.minutes(3)
    h.sweep()
    h.deliverFollowUp(B)
    h.minutes(19)
    h.sweep()
    expect(h.followUps(B)).toHaveLength(1)
    h.minutes(2)
    h.sweep()
    const second = h.followUps(B)[1]
    expect(second?.facts).toMatchObject({ reminder: 2, of: [q] })
    expect(second?.body).toContain('This is the last reminder of these messages: after it, Centralu tells their senders they have no answer.')
    h.deliverFollowUp(B)
    expect(h.w.rowOf(q, B).reminded).toBe(2)
    h.minutes(19)
    h.sweep()
    expect(h.w.rowOf(q, B).releasedAt).toBeNull()
    // In a turn, it may be answering: the release waits for the turn's end
    h.over.set(B, { receiver: { kind: 'busy', why: 'turn' } })
    h.minutes(2)
    h.sweep()
    expect(h.w.rowOf(q, B).releasedAt).toBeNull()
    h.over.delete(B)
    h.sweep()
    h.sweep()
    expect(h.w.rowOf(q, B)).toMatchObject({ releasedWhy: 'reminders' })
    // No third reminder, and one notice to the sender with the row and why
    expect(h.followUps(B)).toHaveLength(2)
    const told = h.followUps(A)
    expect(told).toHaveLength(1)
    expect(told[0]?.facts.unanswered).toEqual([{ id: q, recipient: B, why: 'reminders' }])
    expect(told[0]?.body).toContain('it was reminded twice and has not answered')
    expect(h.w.rowOf(q, B).toldAt).not.toBeNull()
  })

  it('never reminds or releases a message that needs no reply, nor releases a task however long it runs', () => {
    const h = harness()
    const note = h.w.send(A, { to: [B], text: 'fyi', needsReply: false }).message.id
    const task = h.w.mail.task(A, B, { text: 'build it', origin: 'start_agent', delivered: false }).id
    h.turn(B, note, [note, task])
    h.minutes(3 * 60)
    h.sweep()
    expect(h.followUps(B)).toEqual([])
    expect(h.w.rowOf(note, B).releasedAt).toBeNull()
    expect(h.w.rowOf(task, B).releasedAt).toBeNull()
    expect(h.followUps(A)).toEqual([])
  })

  it('holds a reminder while the session\'s own work runs, reminds 2 minutes after it ends, and releases at 2 hours as still working', () => {
    const h = harness()
    const q = h.ask(A, B)
    h.over.set(B, { work: 1 })
    h.minutes(30)
    h.sweep()
    expect(h.followUps(B)).toEqual([])
    h.over.set(B, { work: 0 })
    h.sweep()
    h.minutes(1)
    h.sweep()
    expect(h.followUps(B)).toEqual([])
    h.minutes(1.5)
    h.sweep()
    expect(h.followUps(B)).toHaveLength(1)

    const other = harness()
    const r = other.ask(A, B)
    other.over.set(B, { work: 2 })
    other.minutes(121)
    other.sweep()
    expect(other.w.rowOf(r, B).releasedWhy).toBe('working')
    expect(other.followUps(A)[0]?.body).toContain('it is still working on its own work after 2 hours')
    expect(q).toBeTruthy()
  })

  it('holds a reminder for 10 minutes after a turn the person started', () => {
    const h = harness()
    const q = h.w.send(A, { to: [B], text: 'q', needsReply: true }).message.id
    h.turn(B, null, [q], { person: true })
    h.minutes(9)
    h.sweep()
    expect(h.followUps(B)).toEqual([])
    expect(h.lines.at(-1)).toContain('no (person)')
    h.minutes(2)
    h.sweep()
    h.minutes(2.5)
    h.sweep()
    expect(h.followUps(B)).toHaveLength(1)
  })

  it('reminds nothing after the person\'s Stop or a failure until the session\'s next turn', () => {
    const h = harness()
    const q = h.ask(A, B)
    const seq = h.w.records.nextTurnSeq('b') - 1
    h.w.records.setTurnEndedHow('b', seq, 'stopped')
    h.minutes(30)
    h.sweep()
    expect(h.followUps(B)).toEqual([])
    expect(h.lines.at(-1)).toContain('no (stopped)')
    h.w.records.setTurnEndedHow('b', seq, 'error')
    h.sweep()
    expect(h.lines.at(-1)).toContain('no (error)')
    // A new turn that ends as turns do lets it be reminded again
    h.turn(B, null)
    h.minutes(3)
    h.sweep()
    h.sweep()
    expect(h.followUps(B)[0]?.facts.of).toEqual([q])
  })

  it('spares a session waiting on what it asked in that message\'s turn, and releases the row at 2 hours as waiting', () => {
    const h = harness()
    const q = h.w.send(A, { to: [B], text: 'can you find out?', needsReply: true }).message.id
    const t = h.w.startTurn(B, q)
    h.w.records.markDelivered(B, [q], h.w.clock.t, t.turnSeq)
    const asked = h.w.send(B, { to: [C], text: 'what does C know?', needsReply: true }).message.id
    h.w.records.endTurn('b', t.turnSeq, h.w.clock.t, 'acted')
    h.w.records.markDelivered(C, [asked], h.w.clock.t, null)
    h.minutes(5)
    h.sweep()
    expect(h.followUps(B)).toEqual([])
    expect(h.lines.some((l) => l.includes('no (covered; by'))).toBe(true)
    // C holds the inner question uncovered, and is reminded (a chain a → b → c: only c)
    expect(h.followUps(C)[0]?.facts.of).toEqual([asked])
    h.minutes(120)
    h.sweep()
    expect(h.w.rowOf(q, B).releasedWhy).toBe('waiting')
    expect(h.followUps(A)[0]?.body).toContain('it is still waiting on another session or on the person after 2 hours')
  })

  it('in two sessions asking each other, reminds only the one holding the inner question', () => {
    const h = harness()
    const outer = h.w.send(A, { to: [B], text: 'outer', needsReply: true }).message.id
    const t = h.w.startTurn(B, outer)
    h.w.records.markDelivered(B, [outer], h.w.clock.t, t.turnSeq)
    const inner = h.w.send(B, { to: [A], text: 'inner', needsReply: true }).message.id
    h.w.records.endTurn('b', t.turnSeq, h.w.clock.t, 'acted')
    h.turn(A, inner, [inner])
    h.minutes(3)
    h.sweep()
    expect(h.followUps(B)).toEqual([])
    expect(h.followUps(A)[0]?.facts.of).toEqual([inner])
  })

  it('does not let a question sent before the message came in, or in a later turn another message started, spare it', () => {
    const h = harness()
    const before = h.w.send(B, { to: [C], text: 'unrelated, earlier', needsReply: true }).message.id
    const q = h.ask(A, B)
    const other = h.w.send(C, { to: [B], text: 'another thing', needsReply: true }).message.id
    const t = h.w.startTurn(B, other)
    h.w.records.markDelivered(B, [other], h.w.clock.t, t.turnSeq)
    h.w.send(B, { to: [C], text: 'about another thing', needsReply: true })
    h.w.records.endTurn('b', t.turnSeq, h.w.clock.t, 'acted')
    h.minutes(3)
    h.sweep()
    expect(h.followUps(B)[0]?.facts.of).toContain(q)
    expect(before).toBeTruthy()
  })

  it('wakes a session for a follow-up at most once in 20 minutes and 6 times in 24 hours, counted from the store across a restart', () => {
    const h = harness()
    const posted: number[] = []
    for (let i = 0; i < 8; i++) {
      h.ask(A, B, `question ${i}`)
      h.minutes(3)
      h.sweep()
      const n = h.followUps(B).length
      if (n > posted.length) {
        posted.push(h.w.clock.t)
        h.deliverFollowUp(B)
      }
      h.restart()
      h.minutes(21)
    }
    expect(posted).toHaveLength(6)
    for (let i = 1; i < posted.length; i++) expect((posted[i] ?? 0) - (posted[i - 1] ?? 0)).toBeGreaterThanOrEqual(REMINDER.gapMs)
    expect(h.lines.some((l) => l.includes('no (cap_day)'))).toBe(true)
  })

  it('posts no second follow-up while one waits undelivered, and posts quiet to a session asleep past 50 minutes', () => {
    const h = harness()
    h.ask(A, B)
    h.over.set(B, { receiver: { kind: 'ready', live: false, quiet: false } })
    h.minutes(55)
    h.sweep()
    h.sweep()
    const [quiet, ...rest] = h.followUps(B)
    expect(quiet?.facts.quiet).toBe(true)
    expect(rest).toEqual([])
    h.ask(C, B, 'another')
    h.minutes(30)
    h.sweep()
    expect(h.followUps(B)).toHaveLength(1)
    expect(h.lines.at(-1)).toContain('no (undelivered)')
  })

  it('tells a sender of its released rows within its own follow-up budget, gathered in one notice', () => {
    const h = harness()
    const q1 = h.ask(A, B, 'first')
    const q2 = h.ask(A, C, 'second')
    // A was reminded itself a minute ago: the notice to it waits for its gap
    h.w.mail.notice(A, { body: 'an earlier follow-up', facts: { reminder: 1, of: [] }, dedupeKey: 'earlier' })
    h.over.set(B, { work: 1 })
    h.over.set(C, { work: 1 })
    h.minutes(119)
    const earlier = h.followUps(A)[0]
    h.w.records.markDelivered(A, [earlier?.id ?? ''], h.w.clock.t, null)
    h.minutes(2)
    h.sweep()
    expect(h.w.rowOf(q1, B).releasedWhy).toBe('working')
    expect(h.followUps(A)).toHaveLength(1)
    expect(h.lines.some((l) => l.includes('sender told later (cap_gap)'))).toBe(true)
    h.minutes(20)
    h.sweep()
    const told = h.followUps(A)[1]
    expect(told?.facts.unanswered?.map((u) => u.id)).toEqual([q1, q2])
    h.sweep()
    expect(h.followUps(A)).toHaveLength(2)
  })

  it('tells the person in plain words, without speaking of reminders', () => {
    const h = harness()
    const q = h.w.send('person', { to: [B], text: 'are you there?', needsReply: true }).message.id
    h.turn(B, null, [q])
    h.minutes(25)
    for (const _ of [1, 2]) {
      h.sweep()
      h.deliverFollowUp(B)
      h.minutes(21)
    }
    h.sweep()
    h.minutes(21)
    h.sweep()
    expect(h.w.rowOf(q, B).releasedWhy).toBe('reminders')
    const told = h.w.records.followUpsTo('person', 0).map((r) => h.w.message(r.messageId))
    expect(told).toHaveLength(1)
    expect(told[0]?.body).toContain('it has not answered')
    expect(told[0]?.body).not.toMatch(/remind/)
  })

  it('leaves a session on another computer to its own host, and reminds a session here of a question from another computer', () => {
    const h = harness()
    const far = sessionAddress('hub-bbbbbbbb', 'z')
    h.w.records.insert(
      { id: 'hub-aaaaaaaa.m_01JZZZZZZZZZZZZZZZZZZZZZZ1', senderProject: null, needsReply: true, replyTo: null, causeId: null, depth: 0, urgent: false, facts: {}, choices: null, subject: null, dedupeKey: null, legacyThread: null, createdAt: h.w.clock.t, sender: B, kind: 'message', body: 'to the far side', origin: 'mail' },
      [{ recipient: far, recipientProject: null, dueAt: h.w.clock.t, deliveredAt: h.w.clock.t }],
    )
    h.w.records.insert(
      { id: 'hub-bbbbbbbb.m_01JZZZZZZZZZZZZZZZZZZZZZZ2', senderProject: null, needsReply: true, replyTo: null, causeId: null, depth: 0, urgent: false, facts: {}, choices: null, subject: null, dedupeKey: null, legacyThread: null, createdAt: h.w.clock.t, sender: far, kind: 'message', body: 'from the far side', origin: 'mail' },
      [{ recipient: C, recipientProject: 'p2', dueAt: h.w.clock.t }],
    )
    h.turn(C, 'hub-bbbbbbbb.m_01JZZZZZZZZZZZZZZZZZZZZZZ2', ['hub-bbbbbbbb.m_01JZZZZZZZZZZZZZZZZZZZZZZ2'])
    h.minutes(3 * 60)
    h.sweep()
    // The row to the far session is that host's to remind and release: never here
    expect(h.followUps(far).filter((m) => m.facts.reminder !== undefined)).toEqual([])
    expect(h.w.rowOf('hub-aaaaaaaa.m_01JZZZZZZZZZZZZZZZZZZZZZZ1', far)).toMatchObject({ reminded: 0, releasedAt: null })
    // The question to C is C's host's, this one: released at 2 hours, and the far sender told by a notice the link carries
    expect(h.w.rowOf('hub-bbbbbbbb.m_01JZZZZZZZZZZZZZZZZZZZZZZ2', C).releasedWhy).toBe('waited')
    expect(h.w.records.followUpsTo(far, 0)).toHaveLength(1)
  })

  it('keeps a handed-over row\'s reminders and clock with the heir, and its archived predecessor tells nobody of it', () => {
    const h = harness()
    const q = h.ask(A, B)
    h.minutes(3)
    h.sweep()
    h.deliverFollowUp(B)
    h.w.records.markRead(B, [q], h.w.clock.t)
    const deliveredAt = h.w.rowOf(q, B).deliveredAt
    h.w.mail.handOver(B, C, 'all')
    expect(h.w.rowOf(q, C)).toMatchObject({ reminded: 1, deliveredAt })
    h.w.mail.stops.partyGone(B)
    expect(h.followUps(A)).toEqual([])
    expect(h.w.rowOf(q, C).releasedAt).toBeNull()
    // The heir is released at the original 2 hours, after its second reminder
    h.minutes(120)
    h.sweep()
    expect(h.w.rowOf(q, C).releasedAt).not.toBeNull()
    expect(h.followUps(A)).toHaveLength(1)
  })

  it('reminds an archived or deleted session no more: its rows are released as gone, and its reminder is not given', () => {
    const h = harness()
    const q = h.ask(A, B)
    h.minutes(3)
    h.sweep()
    const reminder = h.followUps(B)[0]
    h.w.mail.stops.partyGone(B)
    h.over.set(B, { receiver: { kind: 'gone' } })
    expect(h.w.rowOf(q, B).releasedWhy).toBe('gone')
    expect(h.followUps(A)).toHaveLength(1)
    h.minutes(180)
    h.sweep()
    expect(h.followUps(B)).toHaveLength(1)
    expect(h.w.mail.drain(B).messageIds).not.toContain(reminder?.id)
  })

  it('logs one line per changed decision and none for repeats', () => {
    const h = harness()
    h.ask(A, B)
    h.over.set(B, { work: 1 })
    h.sweep()
    h.sweep()
    h.sweep()
    expect(h.lines).toEqual(['[mail] reminder b: no (own_work; 1 task)'])
    h.over.set(B, { work: 0 })
    h.sweep()
    h.sweep()
    expect(h.lines).toEqual(['[mail] reminder b: no (own_work; 1 task)', '[mail] reminder b: no (grace)'])
    h.minutes(3)
    h.sweep()
    expect(h.lines.at(-1)).toBe('[mail] reminder b: posted 1/2 rows=1 quiet=no')
  })

  it('releases at 2 hours a row the session waited on with nothing of its own running', () => {
    const h = harness()
    const q = h.ask(A, B)
    h.over.set(B, { receiver: { kind: 'busy', why: 'turn' } })
    h.w.clock.t += 2 * HOUR_MS
    h.sweep()
    expect(h.w.rowOf(q, B).releasedWhy).toBe('waited')
    expect(h.followUps(B)).toEqual([])
  })
})
