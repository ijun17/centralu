/**
 * The unanswered reminder as the host wires it (docs/plans/mailbox.md §10, M5): the delivery's sweep runs it, the rest rule reads the sessions'
 * info, the stop hook keeps a stop on the turn it cut, and a reminder goes into the session as any mail does.
 */
import type { BackgroundTask } from '@cc/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionAddress } from './address.js'
import { HOST, at, hostWorld } from './host-mail.test-helpers.js'
import { MINUTE_MS } from './rules.js'

const A = at('a')
const B = at('b')
let stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})
const started = (w = hostWorld()) => {
  w.afterReady()
  stops.push(w.stop)
  return w
}
const shell: BackgroundTask = { id: 't1', kind: 'shell', description: 'sleep 150', status: 'running' }
const timer: BackgroundTask = { id: 't2', kind: 'other', description: '/loop', status: 'running', timer: true }

/** A asks B, B's turn on it ends, and the reminder's texts B was given since */
async function asked(w = started()) {
  const q = w.mail.send(A, { to: [B], text: 'is the build green?', needsReply: true }).message
  await w.advance(2_000)
  expect(w.to('b')).toHaveLength(1)
  w.endTurn('b')
  const reminders = () => w.to('b').filter((d) => d.input.text.includes('These messages wait for your answer'))
  return { w, q, reminders }
}

describe('the unanswered reminder over the host (§10)', () => {
  it('reminds a session at rest through the delivery, about 2 minutes after its turn ended, and the row counts it', async () => {
    const { w, q, reminders } = await asked()
    await w.advance(MINUTE_MS)
    expect(reminders()).toEqual([])
    await w.advance(2 * MINUTE_MS)
    expect(reminders()).toHaveLength(1)
    expect(reminders()[0]?.input.text).toContain(`- ${q.id} from `)
    expect(w.row(q.id, B)?.reminded).toBe(1)
  })

  it('holds the reminder while a background shell runs and reminds 2 minutes after it ends; a timer alone holds nothing', async () => {
    const { w, reminders } = await asked()
    w.more.set('b', { backgroundTasks: [shell, timer] })
    await w.advance(30 * MINUTE_MS)
    expect(reminders()).toEqual([])
    w.more.set('b', { backgroundTasks: [timer] })
    await w.advance(MINUTE_MS)
    expect(reminders()).toEqual([])
    await w.advance(2 * MINUTE_MS)
    expect(reminders()).toHaveLength(1)
  })

  it('reminds nothing after the person stopped the session, nor while an adopted process\'s work is unknown', async () => {
    // The Stop cuts a later turn of the person's: the question of the turn before stays open, and is not reminded
    const stopped = await asked()
    stopped.w.turns.beginOther('b', 'person', null)
    stopped.w.hooks.stopped?.('b', 'stopped')
    stopped.w.endTurn('b')
    await stopped.w.advance(11 * MINUTE_MS)
    expect(stopped.w.row(stopped.q.id, B)?.releasedAt).toBeNull()
    await stopped.w.advance(30 * MINUTE_MS)
    expect(stopped.reminders()).toEqual([])

    const unknown = await asked()
    unknown.w.workUnknown.add('b')
    await unknown.w.advance(30 * MINUTE_MS)
    expect(unknown.reminders()).toEqual([])
    unknown.w.workUnknown.delete('b')
    await unknown.w.advance(3 * MINUTE_MS)
    expect(unknown.reminders()).toHaveLength(1)
  })

  it('never reminds or releases a row to a session on another computer, nor to a linked machine\'s session on a hub', async () => {
    const w = started()
    // Another computer's session that has the id of one here, and a linked machine's on this hub
    const far = [sessionAddress('hub-bbbbbbbb', 'b'), at('m1.z')]
    w.store.mailbox.insert(
      { id: `${HOST}.m_01JZZZZZZZZZZZZZZZZZZZZZZ1`, senderProject: 'p1', needsReply: true, replyTo: null, causeId: null, depth: 0, urgent: false, facts: {}, choices: null, subject: null, dedupeKey: null, legacyThread: null, createdAt: w.clock.t, sender: A, kind: 'message', body: 'across', origin: 'mail' },
      [...far, at('c')].map((recipient) => ({ recipient, recipientProject: null, dueAt: w.clock.t, deliveredAt: w.clock.t })),
    )
    await w.advance(3 * 60 * MINUTE_MS)
    for (const r of far) {
      expect(w.row(`${HOST}.m_01JZZZZZZZZZZZZZZZZZZZZZZ1`, r)).toMatchObject({ reminded: 0, releasedAt: null })
      expect(w.store.mailbox.followUpsTo(r, 0)).toEqual([])
    }
    // The same message's row to a session here is this host's: reminded, then released
    expect(w.row(`${HOST}.m_01JZZZZZZZZZZZZZZZZZZZZZZ1`, at('c'))).toMatchObject({ reminded: 2, releasedWhy: 'reminders' })
  })
})
