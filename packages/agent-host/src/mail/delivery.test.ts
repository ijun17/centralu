/**
 * Delivery to a receiver at rest (#1347, docs/plans/mailbox.md §5, §7.5 to §7.6, §7.9): who is woken when, what is written
 * before and after the tool takes the input, and what waits.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../dev-services/store.js'
import { PERSON, appAddress, sessionAddress } from './address.js'
import { MailDelivery, MailNotAtRest, type MailInput, type MailSessions, type ReceiverState } from './delivery.js'
import { MailService } from './service.js'
import { openBy } from './mail.test-helpers.js'

const HOST = 'hub-aaaaaaaa'
const NOW = 1_800_000_000_000
const S1 = sessionAddress(HOST, 's1')
const S2 = sessionAddress(HOST, 's2')
const APP = appAddress(HOST, 'p1', 'board')

/** A clock and a scheduler that move only when a test moves them */
function world(seen: { heartbeat?: number | null } = {}) {
  const store = new Store()
  const clock = { t: NOW }
  const timers: { at: number; fn: () => void; id: number }[] = []
  let nextId = 1
  const mail = new MailService(store.mail, { hostId: () => HOST, now: () => clock.t })
  const states = new Map<string, ReceiverState>()
  const delivered: { sessionId: string; input: MailInput }[] = []
  const notes: { sessionId: string; text: string }[] = []
  const behaviour: { fail: Error | null; hold: Promise<void> | null } = { fail: null, hold: null }
  const sessions: MailSessions = {
    receiver: (id) => states.get(id) ?? { kind: 'ready', live: true, quiet: true },
    note: (sessionId, text) => void notes.push({ sessionId, text }),
    deliver: async (sessionId, input) => {
      delivered.push({ sessionId, input })
      if (behaviour.hold) await behaviour.hold
      if (behaviour.fail) throw behaviour.fail
    },
  }
  const beat = { value: seen.heartbeat ?? null }
  const delivery = new MailDelivery(mail, store.mail, sessions, {
    now: () => clock.t,
    heartbeat: { read: () => beat.value, write: (ms) => void (beat.value = ms) },
    schedule: (ms, fn) => {
      const id = nextId++
      timers.push({ at: clock.t + ms, fn, id })
      return () => {
        const i = timers.findIndex((t) => t.id === id)
        if (i >= 0) timers.splice(i, 1)
      }
    },
  })
  /** Moves time on and runs what falls due, in order, letting each delivery finish */
  const advance = async (ms: number) => {
    const end = clock.t + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > end) break
      timers.shift()
      clock.t = Math.max(clock.t, next.at)
      next.fn()
      await settle()
    }
    clock.t = end
    await settle()
  }
  return { store, mail, clock, states, delivered, notes, behaviour, delivery, advance, timers, beat }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise<void>((r) => setImmediate(r))
}

let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
})

const assign = (w: ReturnType<typeof world>, over: { by?: string; body?: string } = {}) =>
  openBy(w.mail, { by: over.by ?? S1, kind: 'assign', subject: 'work', body: over.body ?? 'land #12', assignee: S2 })

describe('delivery to a receiver at rest (§5)', () => {
  it('a post is delivered when it is due, 2 seconds on: one wake, with the frame, and the receipt says so', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { message, thread } = assign(w)
    await settle()
    expect(w.delivered).toEqual([])

    await w.advance(2_000)
    expect(w.delivered).toHaveLength(1)
    expect(w.delivered[0]).toMatchObject({ sessionId: 's2', input: { quiet: false } })
    expect(w.delivered[0]!.input.text).toContain(`thread="${thread.id}"`)
    expect(w.delivered[0]!.input.text).toContain('> land #12')
    expect(w.delivered[0]!.input.line).toBe('✉ 1 message in 1 thread, from the session that gave you this work')
    const receipt = w.store.mail.receiptsOf(message.id)[0]!
    expect(receipt).toMatchObject({ deliveredAt: NOW + 2_000, attemptAt: NOW + 2_000, attempts: 1 })
    // The words went in whole: read on acceptance
    expect(receipt.readAt).toBe(NOW + 2_000)
  })

  it('a burst is one delivery, and nothing is delivered twice', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { thread } = assign(w)
    w.mail.post(thread.id, S1, { kind: 'note', body: 'second' })
    w.mail.post(thread.id, S1, { kind: 'note', body: 'third' })
    await w.advance(2_000)
    expect(w.delivered).toHaveLength(1)
    expect(w.delivered[0]!.input.line).toContain('3 messages in 1 thread')
    await w.advance(120_000)
    expect(w.delivered).toHaveLength(1)
  })

  it('mail for a receiver in a turn, on a card, or at its limit waits, and goes when it is poked; for one that is gone it stays', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    assign(w)
    for (const state of [{ kind: 'busy', why: 'turn' }, { kind: 'busy', why: 'card' }, { kind: 'busy', why: 'limited' }, { kind: 'gone' }] as const) {
      w.states.set('s2', state)
      await w.advance(3_000)
      w.delivery.poke('s2')
      await settle()
      expect(w.delivered, JSON.stringify(state)).toEqual([])
    }
    w.states.set('s2', { kind: 'ready', live: true, quiet: true })
    w.delivery.poke('s2')
    await settle()
    expect(w.delivered).toHaveLength(1)
  })

  it('wakes a receiver asleep (the host resumes it), and in error (it may continue) like any at rest', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    w.states.set('s2', { kind: 'ready', live: false, quiet: false })
    assign(w)
    await w.advance(2_000)
    expect(w.delivered).toHaveLength(1)
    expect(w.delivered[0]!.input.quiet).toBe(false)
  })

  it('what was read before the delivery runs is not sent, and with nothing left no turn starts (§7.5)', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { thread } = assign(w)
    w.mail.read(thread.id, S2)
    await w.advance(5_000)
    expect(w.delivered).toEqual([])
    expect(w.store.mail.receiptsOf(thread.id.length ? w.store.mail.messagesAfter(thread.id, 0)[0]!.id : '')[0]!.attemptAt).toBeNull()
  })

  it('wakes a session at most every 30 seconds, but not for the person’s words or for urgent mail', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { thread } = assign(w)
    await w.advance(2_000)
    expect(toS2(w)).toHaveLength(1)

    mail(w, thread.id, 'second')
    await w.advance(5_000)
    expect(toS2(w)).toHaveLength(1)
    // The person writes: no waiting out the gap, and the earlier mail goes with it
    w.mail.post(thread.id, PERSON, { kind: 'note', body: 'please hurry' })
    await w.advance(0)
    expect(toS2(w)).toHaveLength(2)
    expect(toS2(w)[1]!.input.line).toContain('2 messages')

    // Plain mail waits the gap out
    mail(w, thread.id, 'third')
    await w.advance(10_000)
    expect(toS2(w)).toHaveLength(2)
    await w.advance(25_000)
    expect(toS2(w)).toHaveLength(3)

    // Urgent mail does not
    w.mail.post(thread.id, S1, { kind: 'note', body: 'now', urgent: true })
    await w.advance(0)
    expect(toS2(w)).toHaveLength(4)
  })

  it('mail that does not wake (an app’s notice) goes in without a turn to a live session, and waits for a wake in one that is asleep', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { thread } = assign(w)
    w.mail.addMember(thread.id, S1, APP)
    await w.advance(2_000)
    w.delivered.length = 0

    w.mail.post(thread.id, APP, { kind: 'notice', body: 'progress' })
    await w.advance(2_000)
    // Both parties are live: each gets it without a turn
    expect(w.delivered.map((d) => [d.sessionId, d.input.quiet])).toEqual([['s1', true], ['s2', true]])

    w.states.set('s1', { kind: 'ready', live: false, quiet: false })
    w.mail.post(thread.id, APP, { kind: 'notice', body: 'more progress' })
    await w.advance(3 * 60_000)
    // S1 is asleep: its receipt is the one that waits; S2 (live) got the quiet one
    expect(w.delivered.filter((d) => d.sessionId === 's1')).toHaveLength(1)
    // A wake for S1 carries what waited
    w.mail.post(thread.id, S2, { kind: 'question', body: 'which?' })
    await w.advance(2_000)
    const wake = w.delivered.filter((d) => d.sessionId === 's1').at(-1)!
    expect(wake.input.quiet).toBe(false)
    expect(wake.input.line).toContain('2 messages')
  })

  it('mail that does not wake is not sent to a live session of a tool that cannot take it quietly: it would start a turn', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { thread } = assign(w)
    w.mail.addMember(thread.id, S1, APP)
    await w.advance(2_000)
    w.delivered.length = 0
    w.states.set('s2', { kind: 'ready', live: true, quiet: false })
    w.states.set('s1', { kind: 'ready', live: true, quiet: false })
    w.mail.post(thread.id, APP, { kind: 'notice', body: 'progress' })
    await w.advance(3 * 60_000)
    expect(w.delivered).toEqual([])
  })

  it('the person and an app are not woken: their receipts wait where they are', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { thread } = assign(w)
    w.mail.addMember(thread.id, S1, APP)
    w.mail.post(thread.id, PERSON, { kind: 'note', body: 'hello' })
    w.mail.post(thread.id, S2, { kind: 'question', body: 'to everyone' })
    await w.advance(5 * 60_000)
    expect(w.delivered.every((d) => d.sessionId === 's1' || d.sessionId === 's2')).toBe(true)
    const pending = w.store.mail.recipientsWithMail()
    expect(pending).toContain(APP)
  })
})

const toS2 = (w: ReturnType<typeof world>) => w.delivered.filter((d) => d.sessionId === 's2')

function mail(w: ReturnType<typeof world>, thread: string, body: string) {
  return w.mail.post(thread, S1, { kind: 'note', body })
}

describe('a delivery that fails (§7.6)', () => {
  it('is tried again after a growing wait, and says why; the receipt is not delivered and not uncertain', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    w.behaviour.fail = new Error('could not resume the conversation')
    const { message } = assign(w)
    await w.advance(2_000)
    expect(w.delivered).toHaveLength(1)
    const failed = w.store.mail.receiptsOf(message.id)[0]!
    expect(failed).toMatchObject({ deliveredAt: null, attemptAt: null, attempts: 1, lastError: 'could not resume the conversation' })
    expect(failed.dueAt).toBe(NOW + 2_000 + 5_000)

    await w.advance(5_000)
    expect(w.delivered).toHaveLength(2)
    // The second wait is twice the first
    expect(w.store.mail.receiptsOf(message.id)[0]!.dueAt).toBe(NOW + 2_000 + 5_000 + 10_000)

    w.behaviour.fail = null
    await w.advance(10_000)
    expect(w.delivered).toHaveLength(3)
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ deliveredAt: expect.any(Number), lastError: null })
  })

  it('after six failed tries the mail is held for the person to retry, and is not tried by itself again', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    w.behaviour.fail = new Error('the tool will not start')
    const { message } = assign(w)
    await w.advance(30 * 60_000)
    expect(w.delivered).toHaveLength(6)
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ held: 'failed', deliveredAt: null, lastError: 'the tool will not start' })
    await w.advance(60 * 60_000)
    expect(w.delivered).toHaveLength(6)
    expect(w.store.mail.heldReceipts().map((r) => r.messageId)).toEqual([message.id])
  })
})

describe('a receiver that left rest while it was being woken (§7.1)', () => {
  it('is no failed try: the attempt is taken back, nothing is held however often it happens, and the mail goes at the next rest', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    w.behaviour.fail = new MailNotAtRest()
    const { message } = assign(w)
    await w.advance(2_000)
    expect(w.delivered).toHaveLength(1)
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ deliveredAt: null, attemptAt: null, attempts: 0, lastError: null, held: null })
    // No timer retries it: the person's turn can take as long as it takes
    await w.advance(60 * 60_000)
    const sent = w.delivered.length
    expect(sent).toBeLessThan(70)
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ held: null, attempts: 0 })
    expect(w.store.mail.heldReceipts()).toEqual([])

    // The turn ends: the session pokes, and the mail goes
    w.behaviour.fail = null
    w.delivery.poke('s2')
    await settle()
    expect(w.delivered.length).toBe(sent + 1)
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ deliveredAt: expect.any(Number) })
  })
})

describe('one delivery at a time per mailbox, and the sweep (§5)', () => {
  it('mail that arrives while a delivery is under way is delivered after it, not alongside', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    let release!: () => void
    w.behaviour.hold = new Promise<void>((r) => (release = r))
    const { thread } = assign(w)
    await w.advance(2_000)
    expect(w.delivered).toHaveLength(1)
    w.behaviour.hold = null
    mail(w, thread.id, 'later')
    await w.advance(3_000)
    // Still the first: the mailbox has one delivery in flight
    expect(w.delivered).toHaveLength(1)
    release()
    await settle()
    await w.advance(40_000)
    expect(w.delivered).toHaveLength(2)
  })

  it('the sweep delivers what no event came for, and runs retention', async () => {
    const w = world()
    // Mail posted before delivery started, as after a restart
    assign(w)
    w.clock.t += 5_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await settle()
    expect(w.delivered).toHaveLength(1)

    const old = openBy(w.mail, { by: S1, kind: 'assign', subject: 'old', body: 'x', assignee: S2 }).thread
    w.mail.update(old.id, S1, { state: 'done', outcome: 'finished' })
    w.clock.t += 181 * 24 * 60 * 60_000
    await w.delivery.sweep()
    expect(w.store.mail.thread(old.id)).toBeUndefined()
  })

  it('the sweep moves on the work of a session that left without telling the mailbox', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { thread } = assign(w)
    w.states.set('s2', { kind: 'gone' })
    await w.delivery.sweep()
    expect(w.store.mail.thread(thread.id)).toMatchObject({ assignee: null, state: 'open', owner: S1 })
    // And not the work of one that is here
    const kept = openBy(w.mail, { by: S1, kind: 'assign', subject: 'kept', body: 'x', assignee: sessionAddress(HOST, 's3') }).thread
    await w.delivery.sweep()
    expect(w.store.mail.thread(kept.id)?.assignee).toBe(sessionAddress(HOST, 's3'))
  })

  it('does nothing once stopped', async () => {
    const w = world()
    w.delivery.start()
    w.delivery.stop()
    assign(w)
    await w.advance(120_000)
    expect(w.delivered).toEqual([])
  })
})

describe('what a host that died left half done (§7.6.5)', () => {
  /** The attempt was written and the tool's acceptance was not: what a host that dies in the middle leaves */
  const diedMidDelivery = (w: ReturnType<typeof world>, recipient: string, messageIds: string[]) => {
    w.store.mail.markAttempt(recipient, messageIds, w.clock.t)
  }

  it('an assign that may have been taken is not sent again by itself: it is held, said in the thread and to the receiver, and sent only when the person says', async () => {
    const w = world()
    const { message, thread } = assign(w)
    diedMidDelivery(w, S2, [message.id])
    w.clock.t += 60_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(5 * 60_000)

    expect(w.delivered).toEqual([])
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ held: 'uncertain', attemptAt: null, deliveredAt: null })
    expect(w.notes).toEqual([{ sessionId: 's2', text: expect.stringContaining('may not have arrived when Centralu restarted') }])
    expect(w.notes[0]!.text).toContain('Resend and Dismiss')
    const event = w.mail.read(thread.id, S1, { all: true, peek: true }).messages.at(-1)
    expect(event).toMatchObject({ kind: 'event', facts: { change: 'delivery_uncertain', recipient: S2, messages: 1 } })

    // The person says send it
    expect(w.mail.resendHeld(S2, [message.id])).toBe(1)
    await w.advance(2_000)
    expect(w.delivered).toHaveLength(1)
    expect(w.delivered[0]!.input.text).toContain('> land #12')
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ held: null, deliveredAt: expect.any(Number) })
  })

  it('mail the person released, and the host died sending, is held like any other and not sent again by itself', async () => {
    const w = world()
    const { message } = assign(w)
    w.store.mail.setHeld(S2, [message.id], 'budget')
    w.mail.resendHeld(S2, [message.id])
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ held: 'released' })
    diedMidDelivery(w, S2, [message.id])
    w.clock.t += 60_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(5 * 60_000)
    expect(w.delivered).toEqual([])
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ held: 'uncertain' })
  })

  it('dismissing it leaves it undelivered for good, and not in the Inbox’s list', async () => {
    const w = world()
    const { message } = assign(w)
    diedMidDelivery(w, S2, [message.id])
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(1_000)
    expect(w.store.mail.heldReceipts().map((r) => r.messageId)).toEqual([message.id])
    expect(w.mail.dismissHeld(S2, [message.id])).toBe(1)
    expect(w.store.mail.heldReceipts()).toEqual([])
    await w.advance(10 * 60_000)
    expect(w.delivered).toEqual([])
  })

  it('news that starts no work, and Centralu’s own words, go again by themselves, and the frame says they may be a repeat', async () => {
    const w = world()
    const { thread } = assign(w)
    w.mail.addMember(thread.id, S1, APP)
    w.mail.read(thread.id, S2)
    const notice = w.mail.post(thread.id, APP, { kind: 'notice', body: 'progress', needsOwner: true })
    const report = w.mail.postAsCentralu(thread.id, { kind: 'report', body: 'The assigned work finished', facts: { outcome: 'finished' }, to: [S1] })
    diedMidDelivery(w, S1, [notice.message.id, report.message.id])
    w.clock.t += 60_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(5_000)

    expect(w.notes).toEqual([])
    const toS1 = () => w.delivered.filter((d) => d.sessionId === 's1')
    expect(toS1()).toHaveLength(1)
    expect(toS1()[0]!.input.text).toContain('maybeRepeated="1"')
    expect(w.store.mail.receiptsOf(notice.message.id).find((r) => r.recipient === S1)).toMatchObject({ held: null, lastError: null, deliveredAt: expect.any(Number) })
    // A later frame does not say it again
    w.mail.post(thread.id, S2, { kind: 'question', body: 'next?' })
    await w.advance(40_000)
    expect(toS1().at(-1)!.input.text).not.toContain('maybeRepeated')
  })

  it('a host that left nothing half done says nothing, and an inline assign that was taken whole is not touched', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    assign(w)
    await w.advance(3_000)
    expect(w.delivered).toHaveLength(1)
    expect(w.notes).toEqual([])
    w.delivery.stop()
    const again = new MailDelivery(w.mail, w.store.mail, { receiver: () => ({ kind: 'ready', live: true, quiet: true }), deliver: async () => {}, note: () => {} })
    again.start()
    again.stop()
    expect(w.store.mail.heldReceipts()).toEqual([])
  })
})

describe('a host that was off a long while (§7.9)', () => {
  const MIN = 60_000
  const asleep = (w: ReturnType<typeof world>, id: string) => w.states.set(id, { kind: 'ready', live: false, quiet: false })

  it('keeps a heartbeat, so that the next start knows how long it was off', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(3 * MIN)
    expect(w.beat.value).toBeGreaterThanOrEqual(NOW + 2 * MIN)
    w.delivery.stop()
    expect(w.beat.value).toBe(w.clock.t)
  })

  it('after a short stop it wakes a sleeping session for any mail, as ever', async () => {
    const w = world({ heartbeat: NOW - 5 * MIN })
    asleep(w, 's2')
    const { thread } = assign(w)
    w.mail.post(thread.id, S1, { kind: 'note', body: 'just a note' })
    w.clock.t += 3_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(1_000)
    expect(toS2(w)).toHaveLength(1)
  })

  it('after a long stop a sleeping session is woken only for mail that needs it, and the rest waits for its next turn', async () => {
    const w = world({ heartbeat: NOW - 3 * 60 * MIN })
    asleep(w, 's2')
    const first = assign(w)
    w.mail.read(first.thread.id, S2)
    const note = w.mail.post(first.thread.id, S1, { kind: 'note', body: 'only a note' })
    w.clock.t += 3_000
    // Only a note came due while the host was off: nothing wakes it
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(5 * MIN)
    expect(toS2(w)).toEqual([])
    expect(w.store.mail.receiptsOf(note.message.id)[0]!.deliveredAt).toBeNull()

    // Mail that came after the start is not held back: a question wakes it, and carries the note too once it is awake
    w.mail.post(first.thread.id, S1, { kind: 'question', body: 'are you there?' })
    await w.advance(3_000)
    expect(toS2(w)).toHaveLength(1)
    expect(toS2(w)[0]!.input.line).toContain('1 message in 1 thread')
  })

  it('after a long stop the mail that needs a sleeping session wakes it, with everything that came due for it in one wake', async () => {
    const w = world({ heartbeat: NOW - 3 * 60 * MIN })
    asleep(w, 's2')
    const { thread } = assign(w)
    w.mail.post(thread.id, S1, { kind: 'note', body: 'and a note' })
    w.clock.t += 3_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(1_000)
    expect(toS2(w)).toHaveLength(1)
    // The note did not need it, and is not in the wake
    expect(toS2(w)[0]!.input.line).toContain('1 message in 1 thread')
  })

  it('past ten sleeping sessions to wake nobody is woken: the person is asked, and answers wake them or leave them', async () => {
    const w = world({ heartbeat: NOW - 3 * 60 * MIN })
    const ids = Array.from({ length: 12 }, (_, i) => `a${i}`)
    for (const id of ids) {
      asleep(w, id)
      openBy(w.mail, { by: S1, kind: 'assign', subject: id, body: `work for ${id}`, assignee: sessionAddress(HOST, id) })
    }
    w.clock.t += 3_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(5 * MIN)
    expect(w.delivered).toEqual([])
    expect(w.delivery.crowdWaiting()).toBe(12)

    await w.delivery.answerCrowd(false)
    expect(w.delivery.crowdWaiting()).toBe(0)
    await w.advance(10 * MIN)
    expect(w.delivered).toEqual([])
    // Something about one of them happens (the person types to it, say): it is no longer left
    w.states.set('a3', { kind: 'ready', live: true, quiet: true })
    w.delivery.poke('a3')
    await settle()
    expect(w.delivered.map((d) => d.sessionId)).toEqual(['a3'])
  })

  it('woken at the person’s word, the ones with the most pressing mail go first and two at a time', async () => {
    const w = world({ heartbeat: NOW - 3 * 60 * MIN })
    const ids = Array.from({ length: 12 }, (_, i) => `a${i}`)
    for (const id of ids) {
      asleep(w, id)
      openBy(w.mail, { by: S1, kind: 'assign', subject: id, body: 'plain', assignee: sessionAddress(HOST, id) })
    }
    // a7 has a question waiting, a9 the person's words
    const q = openBy(w.mail, { by: S1, kind: 'assign', subject: 'q', body: 'x', assignee: sessionAddress(HOST, 'a7') })
    w.mail.post(q.thread.id, S1, { kind: 'question', body: 'which?' })
    const p = openBy(w.mail, { by: S1, kind: 'assign', subject: 'p', body: 'x', assignee: sessionAddress(HOST, 'a9') })
    w.mail.post(p.thread.id, PERSON, { kind: 'note', body: 'please' })
    w.clock.t += 3_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(1_000)
    const toSleepers = () => w.delivered.filter((d) => d.sessionId.startsWith('a'))
    expect(toSleepers()).toEqual([])
    expect(w.delivery.crowdWaiting()).toBe(12)

    let running = 0
    let most = 0
    const order: string[] = []
    let release!: () => void
    w.behaviour.hold = new Promise<void>((r) => (release = r))
    const woken = w.delivery.answerCrowd(true)
    await settle()
    // Two are in flight, no more, and the first of them is the one the person wrote to
    running = toSleepers().length
    most = running
    expect(most).toBe(2)
    expect(toSleepers()[0]!.sessionId).toBe('a9')
    w.behaviour.hold = null
    release()
    await woken
    order.push(...toSleepers().map((d) => d.sessionId))
    expect(order.slice(0, 3)).toEqual(['a9', 'a7', expect.any(String)])
    expect(new Set(order)).toEqual(new Set(ids))
  })
  /** Twelve sleeping sessions, each with an assign from before the host came back, and a crowd that waits for the person */
  const crowded = async () => {
    const w = world({ heartbeat: NOW - 3 * 60 * MIN })
    const ids = Array.from({ length: 12 }, (_, i) => `a${i}`)
    for (const id of ids) {
      asleep(w, id)
      openBy(w.mail, { by: S1, kind: 'assign', subject: id, body: `work for ${id}`, assignee: sessionAddress(HOST, id) })
    }
    w.clock.t += 3_000
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(1_000)
    expect(w.delivery.crowdWaiting()).toBe(12)
    return w
  }
  const threadOf = (w: ReturnType<typeof world>, id: string) => w.store.mail.threadsOfParty(sessionAddress(HOST, id), 'assignee')[0]!

  it('the person writing to a session in the crowd is heard by it, and it leaves the crowd; what others write is not', async () => {
    const w = await crowded()
    w.mail.post(threadOf(w, 'a4').id, S1, { kind: 'note', body: 'from the owner, since' })
    w.mail.post(threadOf(w, 'a5').id, PERSON, { kind: 'note', body: 'please look at this' })
    await w.advance(3_000)
    expect(w.delivered.map((d) => d.sessionId).filter((id) => id.startsWith('a'))).toEqual(['a5'])
    // Only the person’s word went, not the assign that came before the host did
    expect(w.delivered[0]!.input.text).toContain('please look at this')
    expect(w.delivered[0]!.input.text).not.toContain('work for a5')
    expect(w.delivery.crowdWaiting()).toBe(11)
  })

  it('a session the person said to leave for its next turn still hears the person’s later words', async () => {
    const w = await crowded()
    await w.delivery.answerCrowd(false)
    w.mail.post(threadOf(w, 'a2').id, PERSON, { kind: 'note', body: 'after all, now' })
    await w.advance(3_000)
    expect(w.delivered.map((d) => d.sessionId).filter((id) => id.startsWith('a'))).toEqual(['a2'])
  })

  it('a session that comes to rest or is used is not in the crowd any more', async () => {
    const w = await crowded()
    w.states.set('a6', { kind: 'ready', live: true, quiet: true })
    w.delivery.poke('a6')
    await settle()
    expect(w.delivery.crowdWaiting()).toBe(11)
    expect(w.delivered.map((d) => d.sessionId)).toEqual(['a6'])
  })

  it('does not rewrite the heartbeat while the crowd waits, so a restart asks again instead of waking them all', async () => {
    const w = await crowded()
    const before = w.beat.value
    await w.advance(10 * MIN)
    w.delivery.stop()
    expect(w.beat.value).toBe(before)
    expect(w.beat.value).toBeLessThan(NOW)
  })

  it('a host that was away without stopping (the computer asleep) is a long stop too, at the next sweep', async () => {
    const w = world()
    asleep(w, 's2')
    const first = assign(w)
    w.mail.read(first.thread.id, S2)
    w.delivery.start()
    stop = () => w.delivery.stop()
    await w.advance(3 * MIN)
    // Eight hours pass with no sweep running, then a note comes due and the sweep wakes up
    w.clock.t += 8 * 60 * MIN
    const note = w.mail.post(first.thread.id, S1, { kind: 'note', body: 'only a note' })
    w.clock.t += 3_000
    await w.delivery.sweep()
    expect(toS2(w)).toEqual([])
    expect(w.store.mail.receiptsOf(note.message.id)[0]!.deliveredAt).toBeNull()

    // A host that kept sweeping is not away: the same note wakes the sleeper
    const awake = world()
    asleep(awake, 's2')
    const second = assign(awake)
    awake.mail.read(second.thread.id, S2)
    awake.delivery.start()
    stop = () => { w.delivery.stop(); awake.delivery.stop() }
    await awake.advance(3 * MIN)
    awake.mail.post(second.thread.id, S1, { kind: 'note', body: 'only a note' })
    await awake.advance(10_000)
    expect(toS2(awake)).toHaveLength(1)
  })

  it('the ordinary sweep resumes sleeping sessions two at a time too', async () => {
    const w = world()
    const ids = Array.from({ length: 6 }, (_, i) => `a${i}`)
    for (const id of ids) {
      asleep(w, id)
      openBy(w.mail, { by: S1, kind: 'assign', subject: id, body: 'x', assignee: sessionAddress(HOST, id) })
    }
    w.delivery.start()
    stop = () => w.delivery.stop()
    // The sweep start() makes finishes first, with nothing due yet
    await settle()
    w.clock.t += 3_000
    let release!: () => void
    w.behaviour.hold = new Promise<void>((r) => (release = r))
    const swept = w.delivery.sweep()
    await settle()
    expect(w.delivered.filter((d) => d.sessionId.startsWith('a'))).toHaveLength(2)
    w.behaviour.hold = null
    release()
    await swept
    expect(new Set(w.delivered.map((d) => d.sessionId))).toEqual(new Set(ids))
  })
})

describe('a session that runs without asking holds mail from the sessions and apps it has no work with (§7.7)', () => {
  const S3 = sessionAddress(HOST, 's3')
  const auto = (w: ReturnType<typeof world>, id: string, over: { live?: boolean } = {}) =>
    w.states.set(id, { kind: 'ready', live: over.live ?? true, quiet: over.live ?? true, auto: true })

  it('a member’s word is told of without a turn and held for the person; the owner’s still wakes it', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    auto(w, 's2')
    const { thread } = assign(w)
    w.mail.addMember(thread.id, S1, S3)
    await w.advance(3_000)
    w.delivered.length = 0

    const note = w.mail.post(thread.id, S3, { kind: 'note', body: 'a word from the side' })
    await w.advance(40_000)
    const toS2 = w.delivered.filter((d) => d.sessionId === 's2')
    expect(toS2).toHaveLength(1)
    expect(toS2[0]!.input.quiet).toBe(true)
    expect(w.store.mail.receiptsOf(note.message.id).find((r) => r.recipient === S2)).toMatchObject({ held: 'policy', deliveredAt: expect.any(Number) })
    expect(w.store.mail.heldReceipts().map((r) => r.messageId)).toContain(note.message.id)

    // The owner's word is not held
    w.mail.post(thread.id, S1, { kind: 'note', body: 'from the owner' })
    await w.advance(40_000)
    const last = w.delivered.filter((d) => d.sessionId === 's2').at(-1)!
    expect(last.input.quiet).toBe(false)
  })

  it('released by the person it goes as the mail it is: it wakes the session, and is not held again', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    auto(w, 's2')
    const { thread } = assign(w)
    w.mail.addMember(thread.id, S1, S3)
    await w.advance(3_000)
    const note = w.mail.post(thread.id, S3, { kind: 'question', body: 'a question from the side' })
    await w.advance(40_000)
    w.delivered.length = 0

    expect(w.mail.resendHeld(S2, [note.message.id])).toBe(1)
    await w.advance(40_000)
    expect(w.delivered).toHaveLength(1)
    expect(w.delivered[0]!.input.quiet).toBe(false)
    expect(w.store.mail.receiptsOf(note.message.id).find((r) => r.recipient === S2)).toMatchObject({ held: 'released', deliveredAt: expect.any(Number) })
    expect(w.store.mail.heldReceipts()).toEqual([])
  })

  it('a session asleep is not woken by it, and under safe or normal nothing is held', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    auto(w, 's2', { live: false })
    const { thread } = assign(w)
    w.mail.addMember(thread.id, S1, S3)
    await w.advance(3_000)
    w.delivered.length = 0
    // The assign already woke it once; now it is asleep again and a member writes
    w.mail.post(thread.id, S3, { kind: 'note', body: 'a word' })
    await w.advance(5 * 60_000)
    expect(w.delivered.filter((d) => d.sessionId === 's2')).toEqual([])
    // And it is listed for the person, with Release, though nothing was told of: no wake is coming to carry it
    expect(w.store.mail.heldReceipts().map((r) => [r.recipient, r.held])).toEqual([[S2, 'policy']])

    const normal = world()
    normal.delivery.start()
    const later = assign(normal)
    normal.mail.addMember(later.thread.id, S1, S3)
    await normal.advance(3_000)
    normal.mail.post(later.thread.id, S3, { kind: 'note', body: 'a word' })
    await normal.advance(40_000)
    expect(normal.delivered.filter((d) => d.sessionId === 's2').at(-1)!.input.quiet).toBe(false)
    expect(normal.store.mail.heldReceipts()).toEqual([])
    normal.delivery.stop()
  })
})

describe('one turn, one thread (§5, §6)', () => {
  it('a wake carries one work thread, and the other thread goes with the next turn', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const S3 = sessionAddress(HOST, 's3')
    const first = assign(w)
    const second = openBy(w.mail, { by: S3, kind: 'assign', subject: 'other work', body: 'also this', assignee: S2 })
    await w.advance(2_000)
    expect(w.delivered).toHaveLength(1)
    expect(w.delivered[0]!.input.text).toContain(first.thread.id)
    expect(w.delivered[0]!.input.text).not.toContain(second.thread.id)
    expect(w.store.mail.receiptsOf(second.message.id)[0]).toMatchObject({ deliveredAt: null, held: null, attempts: 0 })

    // The turn ends: the session pokes, and the second thread's mail is the next turn's
    w.mail.read(first.thread.id, S2)
    w.delivery.poke('s2')
    await w.advance(35_000)
    expect(w.delivered).toHaveLength(2)
    expect(w.delivered[1]!.input.text).toContain(second.thread.id)
  })
})
