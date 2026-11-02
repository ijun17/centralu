/**
 * A tool that stayed silent past the wait counts as having taken a wake, and fails it after that (docs/plans/mailbox.md §8.1): it never ran it, so
 * the mail is put back, not left delivered and read for ever, and work is held for the person rather than sent twice.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { deliveryWorld } from './delivery.test-helpers.js'
import { A, B, W } from './messages.test-helpers.js'

let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
})
const started = () => {
  const w = deliveryWorld()
  w.delivery.start()
  stop = () => w.delivery.stop()
  return w
}

describe('a wake the tool failed after the wait for it ran out', () => {
  it('a task is undelivered again and held uncertain, like a restart’s, said to the receiver, and not sent again by itself; its turn is cancelled', async () => {
    const w = started()
    const task = w.mail.task(A, W, { text: 'land #12', origin: 'start_agent', delivered: false })
    await w.advance(2_000)
    expect(w.rowOf(task.id, W).deliveredAt).not.toBeNull()
    w.lates[0]!(new Error('the session was stopped'))
    expect(w.rowOf(task.id, W)).toMatchObject({ deliveredAt: null, readAt: null, held: 'uncertain', turnSeq: null })
    expect(w.notes).toEqual([{ sessionId: 'w', text: expect.stringContaining('may have reached you although the tool reported a failure') }])
    expect(w.store.mailbox.turnsOf('w')[0]).toMatchObject({ outcome: 'canceled' })
    await w.advance(60 * 60_000)
    expect(w.to('w')).toHaveLength(1)
  })

  it('news and Centralu’s own words go again by themselves, with the note that they may be a repeat', async () => {
    const w = started()
    const n = w.mail.notice(B, { body: 'PR landed', facts: {}, dedupeKey: 'watch:b:1' })!
    await w.advance(2_000)
    w.lates[0]!(new Error('failed late'))
    await w.advance(31_000)
    expect(w.to('b')).toHaveLength(2)
    expect(w.to('b')[1]!.input.text).toContain('maybeRepeated="1"')
    expect(w.rowOf(n.id, B).held).toBeNull()
  })

  it('does not undo a delivery of the same mail by a later wake, nor touch mail held for the person since', async () => {
    const w = started()
    const { message } = w.send(A, { to: [B], text: 'one' })
    await w.advance(2_000)
    const first = w.rowOf(message.id, B).deliveredAt
    w.store.mailbox.markDelivered(B, [message.id], (first ?? 0) + 5, null)
    w.lates[0]!(new Error('late'))
    expect(w.rowOf(message.id, B).deliveredAt).toBe((first ?? 0) + 5)
  })
})
