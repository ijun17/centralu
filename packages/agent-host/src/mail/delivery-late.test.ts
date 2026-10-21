/**
 * A tool that stayed silent past the wait counts as having taken a wake (§7.6.2), and fails it after that: it never ran it, so the
 * mail is put back and tried again, not left delivered and read for ever.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../dev-services/store.js'
import { sessionAddress } from './address.js'
import { MailDelivery, type MailInput, type ReceiverState } from './delivery.js'
import { MailService } from './service.js'
import { openBy } from './mail.test-helpers.js'

const HOST = 'hub-aaaaaaaa'
const NOW = 1_800_000_000_000
const S1 = sessionAddress(HOST, 's1')
const S2 = sessionAddress(HOST, 's2')

function world() {
  const store = new Store()
  const clock = { t: NOW }
  const timers: { at: number; fn: () => void; id: number }[] = []
  let nextId = 1
  const mail = new MailService(store.mail, { hostId: () => HOST, now: () => clock.t })
  const sent: string[] = []
  const sentTexts: string[] = []
  const notes: { sessionId: string; text: string }[] = []
  const lates: ((e: Error) => void)[] = []
  // Not annotated as the port: later steps add members to it, and this test needs only these
  const sessions = {
    receiver: (): ReceiverState => ({ kind: 'ready', live: true, quiet: true }),
    note: (sessionId: string, text: string) => void notes.push({ sessionId, text }),
    deliver: async (sessionId: string, input: MailInput, late?: (e: Error) => void) => {
      sent.push(`${sessionId}: ${input.line}`)
      sentTexts.push(input.text)
      if (late) lates.push(late)
    },
  }
  const delivery = new MailDelivery(mail, store.mail, sessions, {
    now: () => clock.t,
    schedule: (ms: number, fn: () => void) => {
      const id = nextId++
      timers.push({ at: clock.t + ms, fn, id })
      return () => {
        const i = timers.findIndex((t) => t.id === id)
        if (i >= 0) timers.splice(i, 1)
      }
    },
  })
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise<void>((r) => setImmediate(r))
  }
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
  return { store, mail, clock, sent, sentTexts, notes, lates, delivery, advance }
}

let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
})

describe('a wake the tool failed after the wait for it ran out', () => {
  it('is unread and undelivered again and held uncertain, like a restart’s: said to the sender and the receiver, not sent again by itself', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { message, thread } = openBy(w.mail, { by: S1, kind: 'assign', subject: 'work', body: 'land #12', assignee: S2 })
    await w.advance(2_000)
    expect(w.sent).toHaveLength(1)
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ deliveredAt: NOW + 2_000, readAt: NOW + 2_000 })

    w.lates[0]!(new Error('the session closed with it queued'))
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ deliveredAt: null, readAt: null, attemptAt: null, held: 'uncertain' })
    expect(w.store.mail.heldReceipts().map((r) => r.messageId)).toEqual([message.id])
    // The sender reads it in the thread, without the tool's words; the receiver in its conversation
    const event = w.store.mail.messagesAfter(thread.id, 0).find((m) => m.kind === 'event' && m.facts.change === 'delivery_uncertain')
    expect(event).toMatchObject({ sender: 'centralu', facts: { cause: 'late', recipient: S2, messages: 1 } })
    expect(event?.body).not.toContain('closed with it queued')
    expect(w.notes).toEqual([{ sessionId: 's2', text: expect.stringContaining('may have reached you although the tool reported a failure') }])
    // An assign taken just before the failure would start the same work twice: nothing sends it again but the person's Send again
    await w.advance(60 * 60_000)
    expect(w.sent).toHaveLength(1)

    w.store.mail.setHeld(S2, [message.id], null)
    w.delivery.poke('s2')
    await w.advance(60_000)
    expect(w.sent).toHaveLength(2)
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ deliveredAt: expect.any(Number), held: null })
  })

  it('goes again by itself for news that starts no work and for Centralu’s own words, with the note that it may be a repeat', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { thread } = openBy(w.mail, { by: S1, kind: 'assign', subject: 'work', body: 'land #12', assignee: S2 })
    await w.advance(2_000)
    w.mail.postAsCentralu(thread.id, { kind: 'notice', body: 'FYI the queue is long', wake: true, to: [S2] })
    await w.advance(60_000)
    expect(w.sent).toHaveLength(2)
    // Both went in the two wakes; the second wake fails late
    w.lates[1]!(new Error('late'))
    expect(w.store.mail.heldReceipts()).toEqual([])
    expect(w.notes).toEqual([])
    await w.advance(60_000)
    expect(w.sent).toHaveLength(3)
    expect(w.sentTexts[2]).toContain('maybeRepeated="1"')
  })

  it('does not undo a delivery of the same mail by a later wake', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { message } = openBy(w.mail, { by: S1, kind: 'assign', subject: 'work', body: 'land #12', assignee: S2 })
    await w.advance(2_000)
    // The mail went again in a later wake (released after it was held back), delivered at another time
    w.store.mail.markDelivered(S2, [message.id], [], NOW + 50_000)
    w.lates[0]!(new Error('the first wake failed late'))
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ deliveredAt: NOW + 50_000, held: null })
  })

  it('leaves mail alone that was handled by then', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { message, thread } = openBy(w.mail, { by: S1, kind: 'assign', subject: 'work', body: 'land #12', assignee: S2 })
    await w.advance(2_000)
    w.store.mail.markHandled(thread.id, S2, 1_000_000, NOW + 3_000)
    w.lates[0]!(new Error('late'))
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ deliveredAt: NOW + 2_000, handledAt: NOW + 3_000 })
    await w.advance(60_000)
    expect(w.sent).toHaveLength(1)
  })

  it('leaves mail alone that was held for the person (it is in the Inbox either way)', async () => {
    const w = world()
    w.delivery.start()
    stop = () => w.delivery.stop()
    const { message } = openBy(w.mail, { by: S1, kind: 'assign', subject: 'work', body: 'land #12', assignee: S2 })
    await w.advance(2_000)
    w.store.mail.setHeld(S2, [message.id], 'policy')
    w.lates[0]!(new Error('late'))
    expect(w.store.mail.receiptsOf(message.id)[0]).toMatchObject({ deliveredAt: NOW + 2_000, held: 'policy' })
    await w.advance(60_000)
    expect(w.sent).toHaveLength(1)
  })
})
