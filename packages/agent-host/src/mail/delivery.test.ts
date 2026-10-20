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
function world() {
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
  const delivery = new MailDelivery(mail, store.mail, sessions, {
    now: () => clock.t,
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
  return { store, mail, clock, states, delivered, notes, behaviour, delivery, advance, timers }
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
