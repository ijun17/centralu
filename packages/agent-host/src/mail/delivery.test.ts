/**
 * Delivery to a receiver at rest, on the message tables (docs/plans/mailbox.md §8, §7.5, M3a): who is woken when, what is written before and after
 * the tool takes the input, what waits, the turn a wake begins, and the warning to the person that holds nothing (#2014).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MailNotAtRest } from './delivery.js'
import { deliveryWorld, settle } from './delivery.test-helpers.js'
import { A, B, C, NOW, ORC, W, X } from './messages.test-helpers.js'
import { PERSON } from './address.js'
import { HOUR_MS } from './rules.js'
import { turnsOf as turnRows } from '../dev-services/store/mailbox-turns.test-helpers.js'

let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
})
const started = (opts: Parameters<typeof deliveryWorld>[0] = {}) => {
  const w = deliveryWorld(opts)
  w.delivery.start()
  stop = () => w.delivery.stop()
  return w
}

describe('delivery to a receiver at rest (§8.1)', () => {
  it('a message is delivered when it is due, 2 seconds on: one wake with the frame; its row is delivered in the turn the wake began', async () => {
    const w = started()
    const { message } = w.send(A, { to: [B], text: 'can you look at #12?' })
    await settle()
    expect(w.delivered).toEqual([])
    await w.advance(2_000)
    expect(w.to('b')).toHaveLength(1)
    expect(w.to('b')[0]!.input).toMatchObject({ quiet: false, line: '✉ 1 message, from a session of your project' })
    expect(w.to('b')[0]!.input.text).toContain(`id="${message.id}"`)
    const row = w.rowOf(message.id, B)
    expect(row).toMatchObject({ deliveredAt: w.clock.t, attempts: 1, turnSeq: 1 })
    // Pulled, not inline: a message from a session of the same project is read with the tool
    expect(row.readAt).toBeNull()
    expect(turnRows(w.store, 'b')).toEqual([expect.objectContaining({ turnSeq: 1, startedBy: 'mail', starterId: message.id, messageId: null, endedAt: null })])
  })

  it('a burst is one delivery, and nothing is delivered twice', async () => {
    const w = started()
    // Sent at once: one wake carries both
    w.mail.send(A, { to: [B], text: 'one' })
    w.mail.send(C, { to: [B], text: 'two' })
    await w.advance(2_000)
    await w.advance(60_000)
    expect(w.to('b')).toHaveLength(1)
    expect(w.to('b')[0]!.input.line).toBe('✉ 2 messages, from a session of your project, a session of another project')
  })

  it('mail for a receiver in a turn, on a card, or at its limit waits and goes when it is poked; for one that is gone it stays', async () => {
    const w = started()
    w.states.set('b', { kind: 'busy', why: 'turn' })
    w.send(A, { to: [B], text: 'later' })
    await w.advance(5_000)
    expect(w.to('b')).toHaveLength(0)
    w.states.set('b', { kind: 'ready', live: true, quiet: true })
    w.delivery.poke('b')
    await settle()
    expect(w.to('b')).toHaveLength(1)
    w.states.set('c', { kind: 'gone' })
    const { message } = w.send(A, { to: [C], text: 'for c' })
    await w.advance(5_000)
    expect(w.to('c')).toHaveLength(0)
    expect(w.rowOf(message.id, C).deliveredAt).toBeNull()
  })

  it('what was read before the delivery runs is not sent, and with nothing left no turn starts', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'read it yourself' })
    w.mail.read(B)
    await w.advance(5_000)
    expect(w.to('b')).toHaveLength(0)
    expect(turnRows(w.store, 'b')).toEqual([])
  })

  it('wakes a session at most every 30 seconds, but not for the person’s words or urgent mail', async () => {
    const w = started()
    w.send(A, { to: [B], text: 'one' })
    await w.advance(2_000)
    w.endTurn('b')
    w.send(A, { to: [B], text: 'two' })
    await w.advance(2_000)
    expect(w.to('b')).toHaveLength(1)
    // The person's words do not wait, and carry what waited for the gap
    w.send(PERSON, { to: [B], text: 'now please' })
    await settle()
    expect(w.to('b')).toHaveLength(2)
    expect(w.to('b')[1]!.input.line).toContain('2 messages')
    await w.advance(30_000)
    expect(w.to('b')).toHaveLength(2)
  })

  it('a quiet answer goes in without a turn to a live session that takes quiet input, and waits for a wake in one that is asleep or cannot', async () => {
    const w = started()
    const note = w.send(A, { to: [B], text: 'fyi', needsReply: false })
    await w.advance(2_000)
    w.endTurn('b')
    w.mail.read(B)
    const thanks = w.send(B, { replyTo: note.message.id, text: 'thanks' })
    expect(thanks.quiet).toBe(true)
    await w.advance(31_000)
    expect(w.to('a')).toEqual([expect.objectContaining({ input: expect.objectContaining({ quiet: true }) })])
    expect(turnRows(w.store, 'a')).toEqual([])
    // Asleep: it waits for a wake that carries it
    const w2 = started()
    w2.states.set('a', { kind: 'ready', live: false, quiet: false })
    const n2 = w2.send(A, { to: [B], text: 'fyi', needsReply: false })
    w2.mail.read(B)
    w2.send(B, { replyTo: n2.message.id, text: 'thanks' })
    await w2.advance(31_000)
    expect(w2.to('a')).toHaveLength(0)
  })

  it('the person and an app are not woken: their rows wait where they are', async () => {
    const w = started()
    const { message } = w.send(A, { to: [PERSON], text: 'a question for you' })
    await w.advance(5_000)
    expect(w.delivered).toEqual([])
    expect(w.rowOf(message.id, PERSON).deliveredAt).toBeNull()
  })
})

describe('a delivery that fails', () => {
  it('is tried again after a growing wait; after six failed tries it is held failed for the person and the Inbox is told', async () => {
    const w = started()
    const told: string[] = []
    w.mail.onChange((c) => void (c.recipients.includes(PERSON) && told.push(c.messageId)))
    w.behaviour.fail = new Error('the tool said no')
    const { message } = w.send(A, { to: [B], text: 'x' })
    await w.advance(2_000)
    expect(w.rowOf(message.id, B)).toMatchObject({ deliveredAt: null, attempts: 1, lastError: 'the tool said no', held: null })
    for (let i = 0; i < 8; i++) await w.advance(15 * 60_000)
    expect(w.rowOf(message.id, B)).toMatchObject({ held: 'failed', attempts: 6 })
    expect(told).toContain(message.id)
    const tries = w.to('b').length
    await w.advance(60 * 60_000)
    expect(w.to('b')).toHaveLength(tries)
  })

  it('a receiver that left rest while being woken is no failed try: the attempt is taken back and the mail goes at the next rest', async () => {
    const w = started()
    w.behaviour.fail = new MailNotAtRest()
    const { message } = w.send(A, { to: [B], text: 'x' })
    await w.advance(2_000)
    expect(w.rowOf(message.id, B)).toMatchObject({ attempts: 0, attemptAt: null, held: null })
    expect(turnRows(w.store, 'b')).toEqual([expect.objectContaining({ outcome: 'canceled' })])
    w.behaviour.fail = null
    w.delivery.poke('b')
    await settle()
    expect(w.rowOf(message.id, B).deliveredAt).not.toBeNull()
    // The cancelled turn counts for no guard
    expect(w.store.mailbox.mailStartedSince(0)).toBe(1)
  })
})

describe('one delivery at a time, the sweep', () => {
  it('mail that arrives while a delivery is under way is delivered after it, not alongside', async () => {
    const w = started()
    let release = () => {}
    w.behaviour.hold = new Promise<void>((r) => (release = r))
    w.send(A, { to: [B], text: 'first' })
    await w.advance(2_000)
    w.send(PERSON, { to: [B], text: 'second' })
    await settle()
    expect(w.to('b')).toHaveLength(1)
    w.behaviour.hold = null
    release()
    await settle()
    w.endTurn('b')
    await w.advance(1)
    expect(w.to('b')).toHaveLength(2)
  })

  it('the sweep settles the watched rows of a session that left without telling the mailbox', async () => {
    const w = started()
    const q = w.send(A, { to: [C], text: 'are you there?' })
    w.states.set('c', { kind: 'gone' })
    await w.advance(60_000)
    expect(w.rowOf(q.message.id, C)).toMatchObject({ settled: 'gone', releasedWhy: 'gone' })
  })

  it('does nothing once stopped', async () => {
    const w = started()
    w.delivery.stop()
    w.send(A, { to: [B], text: 'x' })
    await w.advance(120_000)
    expect(w.delivered).toEqual([])
  })
})

describe('what a host that died left half done', () => {
  it('a task that may have been taken is held uncertain and said to the receiver; a notice goes again and its frame says it may be a repeat', async () => {
    const w = deliveryWorld()
    const task = w.mail.task(A, W, { text: 'land #12', origin: 'start_agent', delivered: false })
    const notice = w.mail.notice(W, { body: 'PR landed', facts: {}, dedupeKey: 'watch:w:1' })!
    w.store.mailbox.markAttempt(W, [task.id, notice.id], NOW)
    w.clock.t += 5_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(1)
    expect(w.rowOf(task.id, W).held).toBe('uncertain')
    expect(w.notes).toEqual([{ sessionId: 'w', text: expect.stringContaining('may not have arrived when Centralu restarted') }])
    expect(w.to('w')[0]!.input.text).toContain('maybeRepeated="1"')
    expect(w.to('w')[0]!.input.text).not.toContain(task.id)
    expect(w.mail.dismissHeld(W, [task.id])).toBe(1)
    expect(w.rowOf(task.id, W).held).toBe('dismissed')
  })
})

describe('a host that was off a long while', () => {
  const MIN = 60_000
  it('a sleeping session is woken only for mail that needs it, with everything due for it in one wake; plain news waits for its next turn', async () => {
    const w = deliveryWorld({ heartbeat: NOW - 3 * 60 * MIN })
    w.states.set('b', { kind: 'ready', live: false, quiet: false })
    w.states.set('c', { kind: 'ready', live: false, quiet: false })
    w.send(A, { to: [B], text: 'fyi only', needsReply: false })
    const fyi = w.send(A, { to: [C], text: 'fyi only', needsReply: false })
    const question = w.send(A, { to: [C], text: 'a question' })
    w.clock.t += 5_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(1)
    expect(w.to('b')).toHaveLength(0)
    expect(w.to('c')).toHaveLength(1)
    expect(w.to('c')[0]!.input.text).toContain(question.message.id)
    expect(w.to('c')[0]!.input.text).not.toContain(fyi.message.id)
  })

  // #1951: the person opens the sleeping session, its process resumes; that is not a turn, and old news does not start one
  it('plain news held back for the stop does not start a turn when the session only resumes; it goes with the next mail that wakes it', async () => {
    const w = deliveryWorld({ heartbeat: NOW - 3 * 60 * MIN })
    w.states.set('b', { kind: 'ready', live: false, quiet: true })
    const fyi = w.send(A, { to: [B], text: 'an issue was filed', needsReply: false })
    w.clock.t += 5_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(1)
    expect(w.to('b')).toHaveLength(0)
    // The person clicks its input: the process runs, and the delivery is told
    w.states.set('b', { kind: 'ready', live: true, quiet: true })
    w.delivery.poke('b')
    await w.advance(60_000)
    expect(w.to('b')).toHaveLength(0)
    expect(w.rowOf(fyi.message.id, B).deliveredAt).toBeNull()
    // Mail that does wake it carries the old note along
    const question = w.send(C, { to: [B], text: 'a question' })
    await w.advance(2_000)
    expect(w.to('b')).toHaveLength(1)
    expect(w.to('b')[0]!.input.text).toContain(question.message.id)
    expect(w.to('b')[0]!.input.text).toContain(fyi.message.id)
  })

  it('a quiet answer held over the stop still goes into a live session that takes quiet input: only mail that would start a turn waits', async () => {
    const w = deliveryWorld({ heartbeat: NOW - 3 * 60 * MIN })
    const note = w.send(A, { to: [B], text: 'fyi', needsReply: false })
    w.mail.read(B)
    const thanks = w.send(B, { replyTo: note.message.id, text: 'thanks' })
    expect(thanks.quiet).toBe(true)
    w.clock.t += 5_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(1)
    expect(w.to('a')).toEqual([expect.objectContaining({ input: expect.objectContaining({ quiet: true }) })])
  })

  it('past ten sleeping sessions to wake nobody is woken: the person is asked once', async () => {
    const w = deliveryWorld({ heartbeat: NOW - 3 * 60 * MIN })
    for (let i = 0; i < 11; i++) {
      w.sessions.set(`s${i}`, { projectId: 'p1' })
      w.states.set(`s${i}`, { kind: 'ready', live: false, quiet: false })
      w.send(A, { to: [`session:hub-aaaaaaaa/s${i}`], text: `question ${i}` })
    }
    w.clock.t += 5_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(1)
    expect(w.delivered).toEqual([])
    expect(w.delivery.crowdWaiting()).toBe(11)
    await w.delivery.answerCrowd(false)
    expect(w.delivery.crowdWaiting()).toBe(0)
  })
})

describe('the turn a wake begins (§8.2, D17)', () => {
  it('a wake carries one task: its turn is that task’s, started by it, and reported to its sender; the next task waits for the next turn', async () => {
    const w = started()
    const t1 = w.mail.task(A, W, { text: 'first job', origin: 'start_agent', delivered: false })
    w.clock.t += 10
    const t2 = w.mail.task(A, W, { text: 'second job', origin: 'agent_session', delivered: false })
    await w.advance(2_000)
    expect(w.to('w')).toHaveLength(1)
    expect(w.to('w')[0]!.input).toMatchObject({ reportTo: 'a' })
    expect(w.to('w')[0]!.input.text).toContain(t1.id)
    expect(w.to('w')[0]!.input.text).not.toContain(t2.id)
    expect(w.turns.current('w')).toMatchObject({ messageId: t1.id, starter: t1.id, by: 'mail' })
    w.endTurn('w')
    w.delivery.poke('w')
    await w.advance(31_000)
    expect(w.to('w')).toHaveLength(2)
    expect(w.turns.current('w')).toMatchObject({ messageId: t2.id, starter: t2.id })
  })

  it('the Assistant takes one asker per wake: its turn records the asker, and its end is reported to that session', async () => {
    const w = started()
    const r1 = w.send(A, { to: [ORC], text: 'please check CI' })
    w.send(C, { to: [ORC], text: 'and mine' })
    await w.advance(2_000)
    expect(w.to('orc')).toHaveLength(1)
    expect(w.to('orc')[0]!.input).toMatchObject({ reportTo: 'a' })
    expect(w.turns.current('orc')).toMatchObject({ messageId: r1.message.id, asker: A })
  })

  it('a turn that goes on from the host before is read back with its starter, its work and its asker; a stale one is closed lost', () => {
    const w = deliveryWorld({ keepOpen: (id) => id === 'orc' })
    const r = w.send(A, { to: [ORC], text: 'please check CI' })
    w.store.mailbox.startTurn({ sessionId: 'orc', turnSeq: 4, messageId: r.message.id, starterId: r.message.id, startedBy: 'mail', startedAt: NOW })
    w.store.mailbox.startTurn({ sessionId: 'b', turnSeq: 2, messageId: null, starterId: 'x', startedBy: 'mail', startedAt: NOW })
    w.delivery.start()
    stop = () => w.delivery.stop()
    expect(w.turns.current('orc')).toEqual({ turnSeq: 4, by: 'mail', starter: r.message.id, messageId: r.message.id, asker: A, startedAt: NOW })
    expect(turnRows(w.store, 'b')[0]).toMatchObject({ outcome: 'lost' })
  })

  /*
   * #1916: A asked B, B's turn on it ran, and the host was killed and started again (not an update's stop, so nothing continues the turn). The
   * question was delivered and read, so it is never given again; unanswered and unreleased, nobody heard. The start closes the turn lost, and
   * each question that turn had and did not answer is released `lost`: its sender is told in the gathered notice (D25) and can ask again. A
   * sender that asked two sessions whose turns were both cut is told once, for both
   */
  it('a turn cut by a plain restart releases the questions it had unanswered, and their senders are told once', () => {
    const w = deliveryWorld()
    const other = w.send(A, { to: [C], text: 'and what does the test need?' }).message
    w.store.mailbox.markDelivered(C, [other.id], NOW, 1)
    w.store.mailbox.markRead(C, [other.id], NOW)
    w.store.mailbox.startTurn({ sessionId: 'c', turnSeq: 1, messageId: null, starterId: other.id, startedBy: 'mail', startedAt: NOW })
    const before = w.send(C, { to: [B], text: 'an older question' }).message
    w.store.mailbox.markDelivered(B, [before.id], NOW, 1)
    w.store.mailbox.markRead(B, [before.id], NOW)
    w.store.mailbox.startTurn({ sessionId: 'b', turnSeq: 1, messageId: null, starterId: before.id, startedBy: 'mail', startedAt: NOW })
    w.store.mailbox.endTurn('b', 1, NOW, 'acted')
    const asked = w.send(A, { to: [B], text: 'what does the build need?' }).message
    const note = w.send(A, { to: [B], text: 'fyi', needsReply: false }).message
    w.store.mailbox.markDelivered(B, [asked.id, note.id], NOW, 2)
    w.store.mailbox.markRead(B, [asked.id, note.id], NOW)
    w.store.mailbox.startTurn({ sessionId: 'b', turnSeq: 2, messageId: null, starterId: asked.id, startedBy: 'mail', startedAt: NOW })

    w.delivery.start()
    stop = () => w.delivery.stop()
    expect(turnRows(w.store, 'b')[1]).toMatchObject({ outcome: 'lost' })
    expect(w.rowOf(asked.id, B)).toMatchObject({ releasedWhy: 'lost', toldAt: w.clock.t, settled: null })
    expect(w.rowOf(other.id, C)).toMatchObject({ releasedWhy: 'lost', toldAt: w.clock.t, settled: null })
    // Not a question, or a question of a turn that ended: nothing to tell
    expect(w.rowOf(note.id, B)).toMatchObject({ releasedAt: null })
    expect(w.rowOf(before.id, B)).toMatchObject({ releasedAt: null })
    const told = w.records.pendingFor(A, w.clock.t + 10_000).filter((p) => p.message.kind === 'notice')
    expect(told).toHaveLength(1)
    expect(told[0]?.message.facts.unanswered).toEqual(expect.arrayContaining([{ id: asked.id, recipient: B, why: 'lost' }, { id: other.id, recipient: C, why: 'lost' }]))
    expect(told[0]?.message.body).toContain(`- ${asked.id} to beta (${B}): its turn on your message ended while Centralu restarted, before it answered, so ask again if you still need the answer.`)
    // Every line says to ask again: the closing words for the others (and needsReply=false) are not said
    expect(told[0]?.message.body).not.toContain('For the others')
    expect(w.records.pendingFor(C, w.clock.t + 10_000).filter((p) => p.message.kind === 'notice')).toEqual([])
  })

  // #1916: the close and the release are one write. A release that fails keeps nothing: the turn stays open, and the next start releases and tells
  it('a release that fails at a start leaves the turn open, and the next start releases its question and tells the sender', async () => {
    const w = deliveryWorld()
    const asked = w.send(A, { to: [B], text: 'what does the build need?' }).message
    w.store.mailbox.markDelivered(B, [asked.id], NOW, 1)
    w.store.mailbox.markRead(B, [asked.id], NOW)
    w.store.mailbox.startTurn({ sessionId: 'b', turnSeq: 1, messageId: null, starterId: asked.id, startedBy: 'mail', startedAt: NOW })
    const fail = vi.spyOn(w.records, 'markReleased').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})

    w.delivery.start()
    expect(said).toHaveBeenCalledWith(expect.stringContaining('closing the turns the last host left failed'))
    expect(turnRows(w.store, 'b')[0]).toMatchObject({ endedAt: null })
    expect(w.rowOf(asked.id, B)).toMatchObject({ releasedAt: null })
    // This start still delivers
    w.send(C, { to: [B], text: 'and this?' })
    await w.advance(2_000)
    expect(w.to('b')).toHaveLength(1)

    w.delivery.stop()
    fail.mockRestore()
    w.delivery.start()
    stop = () => w.delivery.stop()
    expect(turnRows(w.store, 'b')[0]).toMatchObject({ outcome: 'lost' })
    expect(w.rowOf(asked.id, B)).toMatchObject({ releasedWhy: 'lost', toldAt: w.clock.t })
    const told = w.records.pendingFor(A, w.clock.t + 10_000).filter((p) => p.message.kind === 'notice')
    expect(told).toHaveLength(1)
    expect(told[0]?.message.facts.unanswered).toEqual([{ id: asked.id, recipient: B, why: 'lost' }])
  })
})

describe('the warning to the person (#2014, §7.5)', () => {
  /** Two sessions asking each other back, every answer a question again: `rounds` mail-started turns between them. The last message */
  const askBack = async (w: ReturnType<typeof started>, rounds: number) => {
    let last = w.send(A, { to: [B], text: 'round 0' }).message.id
    await w.advance(2_000)
    for (let i = 1; i < rounds; i++) {
      w.endTurn(i % 2 === 1 ? 'b' : 'a')
      last = w.send(i % 2 === 1 ? B : A, { replyTo: last, text: `round ${i}`, needsReply: true }).message.id
      await w.advance(2_000)
    }
    return last
  }
  const warnings = (w: ReturnType<typeof started>) => w.store.mailbox.feedOf(PERSON, { limit: 50 }).filter((m) => m.facts.pairTurns !== undefined || m.facts.hostCap === true)

  it('mail between two sessions past 20 turns in an hour is delivered as usual; the person is warned once, with the pair and the count; no session is woken for it', async () => {
    const w = started({ delivery: { minWakeGapMs: 0 } })
    let last = await askBack(w, 21)
    expect(w.to('a').length + w.to('b').length).toBe(21)
    expect(w.rowOf(last, B)).toMatchObject({ held: null })
    const told = warnings(w)
    expect(told).toHaveLength(1)
    expect(told[0]!.facts.pairTurns).toEqual({ sessions: [A, B].sort(), turns: 21 })
    expect(told[0]!.body).toContain('started 21 turns of each other')
    // It goes to the person only: no session has it as a recipient, and no wake carries it
    expect(w.store.mailbox.recipients(told[0]!.id).map((r) => r.recipient)).toEqual([PERSON])
    expect(w.delivered.some((d) => d.input.text.includes(told[0]!.id))).toBe(false)
    // Rounds go on past it, each delivered, and the hour's warning is not written again
    for (let i = 21; i < 26; i++) {
      w.endTurn(i % 2 === 1 ? 'b' : 'a')
      last = w.send(i % 2 === 1 ? B : A, { replyTo: last, text: `round ${i}`, needsReply: true }).message.id
      await w.advance(2_000)
      const to = i % 2 === 1 ? A : B
      expect(w.rowOf(last, to)).toMatchObject({ held: null })
      expect(w.rowOf(last, to).deliveredAt).not.toBeNull()
    }
    expect(warnings(w)).toHaveLength(1)
    expect(w.to('a').length + w.to('b').length).toBe(26)
  })

  it('the pair’s warning is keyed by the pair and the clock hour, and is written again in the next hour while the exchange runs on', async () => {
    const w = started({ delivery: { minWakeGapMs: 0 } })
    const hourOf = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS
    // A minute before an hour turns, so the rounds run across it
    w.clock.t = hourOf(w.clock.t) + HOUR_MS - 60_000
    let last = await askBack(w, 21)
    const first = hourOf(w.clock.t)
    expect(warnings(w).map((m) => m.dedupeKey)).toEqual([`pairturns:${[A, B].sort().join('|')}:${first}`])
    for (let i = 21; i < 40; i++) {
      w.endTurn(i % 2 === 1 ? 'b' : 'a')
      last = w.send(i % 2 === 1 ? B : A, { replyTo: last, text: `round ${i}`, needsReply: true }).message.id
      await w.advance(2_000)
    }
    expect(hourOf(w.clock.t)).toBe(first + HOUR_MS)
    expect(warnings(w).map((m) => m.dedupeKey).sort()).toEqual([first, first + HOUR_MS].map((h) => `pairturns:${[A, B].sort().join('|')}:${h}`).sort())
  })

  it('the person’s word to either session counts the pair anew: no warning', async () => {
    const w = started({ delivery: { minWakeGapMs: 0 } })
    const last = await askBack(w, 15)
    w.send(PERSON, { to: [A], text: 'carry on' })
    await w.advance(2_000)
    w.endTurn('a')
    let reply = last
    for (let i = 0; i < 10; i++) {
      w.endTurn(i % 2 === 0 ? 'b' : 'a')
      reply = w.send(i % 2 === 0 ? B : A, { to: [i % 2 === 0 ? A : B], text: `again ${i}`, needsReply: true }).message.id
      await w.advance(2_000)
    }
    expect(w.rowOf(reply, B).deliveredAt).not.toBeNull()
    expect(warnings(w)).toHaveLength(0)
  })

  it('three empty mail-started turns in a row do not stop a session’s mail from waking it, and hold nothing', async () => {
    const w = started({ delivery: { minWakeGapMs: 0 } })
    for (let i = 0; i < 3; i++) {
      w.send(A, { to: [B], text: `ping ${i}`, needsReply: false })
      await w.advance(2_000)
      w.endTurn('b', false)
    }
    const m = w.send(A, { to: [B], text: 'ping 4', needsReply: false })
    await w.advance(2_000)
    expect(w.rowOf(m.message.id, B).held).toBeNull()
    expect(w.to('b')).toHaveLength(4)
    expect(w.to('b').at(-1)!.input.quiet).toBe(false)
  })

  /** `n` mail-started turns of `session` in this hour, each started by a session's message */
  const turnsOf = (w: ReturnType<typeof deliveryWorld>, session: string, n: number) => {
    const starter = w.send(C, { to: [A], text: `starter for ${session}`, needsReply: false }).message.id
    for (let i = 0; i < n; i++) w.store.mailbox.startTurn({ sessionId: session, turnSeq: 100 + i, messageId: null, starterId: starter, startedBy: 'mail', startedAt: w.clock.t })
  }

  it('past 120 mail-started turns on the host in the hour, mail still wakes its receiver at once, and the person is told once', async () => {
    const w = started({ delivery: { warnHostTurns: 12 } })
    turnsOf(w, 'b', 12)
    const one = w.send(A, { to: [B], text: 'one more', needsReply: false })
    await w.advance(2_000)
    expect(w.rowOf(one.message.id, B).deliveredAt).not.toBeNull()
    w.endTurn('b')
    const two = w.send(A, { to: [C], text: 'and another', needsReply: false })
    await w.advance(2_000)
    expect(w.rowOf(two.message.id, C).deliveredAt).not.toBeNull()
    const told = warnings(w)
    expect(told).toHaveLength(1)
    expect(told[0]!.body).toContain('turns on this computer in the last hour')
  })

  it('the host’s warning uses the key an earlier build’s cap notice used, so the two builds write one line an hour between them', async () => {
    const w = started({ delivery: { warnHostTurns: 12 } })
    const hour = Math.floor(w.clock.t / HOUR_MS) * HOUR_MS
    // An earlier build serving during a swap wrote its cap notice this hour already
    w.mail.notice(PERSON, { body: 'the earlier build’s line', facts: { hostCap: true }, dedupeKey: `hostcap:${PERSON}:${hour}` })
    turnsOf(w, 'b', 12)
    const one = w.send(A, { to: [B], text: 'one more', needsReply: false })
    await w.advance(2_000)
    expect(w.rowOf(one.message.id, B).deliveredAt).not.toBeNull()
    expect(warnings(w).map((m) => m.body)).toEqual(['the earlier build’s line'])
  })

  it('the host’s warning is written again in the next clock hour', async () => {
    const w = started({ delivery: { warnHostTurns: 12 } })
    const hourOf = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS
    w.clock.t = hourOf(w.clock.t) + HOUR_MS - 10_000
    turnsOf(w, 'b', 12)
    w.send(A, { to: [B], text: 'one more', needsReply: false })
    await w.advance(2_000)
    w.endTurn('b')
    await w.advance(10_000)
    w.send(A, { to: [C], text: 'in the next hour', needsReply: false })
    await w.advance(2_000)
    const first = hourOf(w.clock.t) - HOUR_MS
    expect(warnings(w).map((m) => m.dedupeKey).sort()).toEqual([first, first + HOUR_MS].map((h) => `hostcap:${PERSON}:${h}`).sort())
  })

  it('the turns a person’s words or a report started do not count toward it', async () => {
    const w = started()
    w.send(PERSON, { to: [B], text: 'hi' })
    await w.advance(1)
    w.endTurn('b')
    const task = w.mail.task(B, A, { text: 'job', origin: 'agent_session', delivered: true })
    w.mail.report(task.id, { outcome: 'finished', body: 'done' })
    await w.advance(31_000)
    expect(turnRows(w.store, 'b')).toHaveLength(2)
    expect(w.store.mailbox.mailStartedSince(0)).toBe(0)
  })
})

describe('what is held is said to the Inbox', () => {
  it('a hold for the one hold is announced for the person', async () => {
    const w = started()
    const told: string[] = []
    w.mail.onChange((c) => void (c.recipients.includes(PERSON) && told.push(c.messageId)))
    const out = w.send(X, { to: [A], text: 'from an untrusted project' })
    await w.advance(2_000)
    expect(w.rowOf(out.message.id, A).held).toBe('policy')
    expect(told).toContain(out.message.id)
  })
})
