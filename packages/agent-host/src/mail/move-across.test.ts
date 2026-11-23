/**
 * On a machine, a hub's handoff (`host.mailMove`, `Handoffs.moveAcross`) gives its heir the rows of mail this machine's sessions sent the original
 * that the hub moved (#2530): only those, so the heir's reply answers one it may read here. Over a real store.
 */
import { describe, expect, it } from 'vitest'
import { CENTRALU, sessionAddress } from './address.js'
import { HOST, at, hostWorld } from './host-mail.test-helpers.js'

const HUB = 'hub-bbbbbbbb'
const FROM = sessionAddress(HUB, 'h1')
const TO = sessionAddress(HUB, 'h2')

describe("a hub's handoff on the machine its original's mail came from (#2530)", () => {
  it("moves the row of an unread message a session here sent the original; not Centralu's, another computer's, or one read", () => {
    const w = hostWorld()
    let n = 0
    const sent = (sender: string, readAt: number | null = null) =>
      w.store.mailbox.insert(
        {
          id: `${HOST}.m_01JZZZZZZZZZZZZZZZZZZZZZZ${++n}`, sender, senderProject: null, kind: sender === CENTRALU ? 'notice' : 'message', body: 'Done with A.', origin: 'mail',
          needsReply: false, replyTo: null, causeId: null, depth: 0, urgent: false, facts: {}, choices: null, subject: null, dedupeKey: null, legacyThread: null, createdAt: w.clock.t + n,
        },
        [{ recipient: FROM, recipientProject: null, dueAt: w.clock.t, deliveredAt: readAt, readAt }],
      ).id
    const note = sent(at('a'))
    const others = [sent(CENTRALU), sent(sessionAddress('hub-cccccccc', 'z')), sent(at('b'), w.clock.t)]
    expect(w.mail.handoffs.moveAcross(FROM, TO, [note, ...others])).toBe(1)
    expect(w.store.mailbox.recipients(note).map((r) => r.recipient)).toEqual([TO])
    for (const id of others) expect(w.store.mailbox.recipients(id).map((r) => r.recipient)).toEqual([FROM])
    w.stop()
  })
})
