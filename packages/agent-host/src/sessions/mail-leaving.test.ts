/**
 * Mail for a session that is waking while the host starts to leave (#1347, docs/plans/mailbox.md §4.2): the stop cannot cut the
 * wait for the resume, so the delivery looks again when it ends, and sends nothing from the leaving host.
 */
import { describe, expect, it } from 'vitest'
import { MailNotAtRest } from '../mail/delivery.js'
import { SessionEvents, type SessionEventsHost } from './session-events.js'

function world() {
  const sent: string[] = []
  const events: unknown[] = []
  let leaving = false
  let atRest = true
  let finishResume!: () => void
  const resumed = new Promise<void>((r) => (finishResume = r))
  const handles = new Map<string, { send(text: string): void }>()
  const host = {
    restartPolicy: { deferredRestarts: new Map() },
    openSession: () => {},
    resuming: new Set<string>(),
    handles,
    resumeSession: async (id: string) => {
      await resumed
      handles.set(id, { send: (text: string) => void sent.push(text) })
      return { resumed: true }
    },
    notBeingRemoved: () => {},
    requireHandle: (id: string) => handles.get(id),
    record: { closeStream: () => {} },
    cardRests: { turnAsked: () => {} },
  }
  const sessionEvents = new SessionEvents(host as unknown as SessionEventsHost)
  Object.assign(sessionEvents, { onEvent: (e: unknown) => void events.push(e) })
  const gate = { leaving: () => leaving, atRest: () => atRest }
  return { sessionEvents, sent, events, leave: () => (leaving = true), personTypes: () => (atRest = false), gate, finishResume, handles }
}

describe('mail for a session that is being woken (§4.2, §7.1)', () => {
  const input = { text: 'mail', quiet: false, line: '✉ 1 message' }

  it('is not sent into a turn the person started while the session was waking: it waits for that turn’s end', async () => {
    const w = world()
    const delivery = w.sessionEvents.deliverMail('s1', input, w.gate)
    const refused = expect(delivery).rejects.toBeInstanceOf(MailNotAtRest)
    w.personTypes()
    w.finishResume()
    await refused
    expect(w.sent).toEqual([])
    expect(w.events).toEqual([])
  })

  it('also quiet mail for a process that is live: the check is right before the send', async () => {
    const w = world()
    w.handles.set('s1', { send: (text: string) => void w.sent.push(text) })
    w.personTypes()
    await expect(w.sessionEvents.deliverMail('s1', { ...input, quiet: true }, w.gate)).rejects.toBeInstanceOf(MailNotAtRest)
    expect(w.sent).toEqual([])
  })
})

describe('mail for a session that is waking when the host starts to leave', () => {
  it('is not sent by the leaving host, and the delivery is refused so that the next host delivers it', async () => {
    const w = world()
    const delivery = w.sessionEvents.deliverMail('s1', { text: 'mail', quiet: false, line: '✉ 1 message' }, w.gate)
    const refused = expect(delivery).rejects.toThrow('Centralu is restarting')
    w.leave()
    w.finishResume()
    await refused
    expect(w.sent).toEqual([])
    expect(w.events).toEqual([])
  })

  it('goes as ever when the host is not leaving', async () => {
    const w = world()
    const delivery = w.sessionEvents.deliverMail('s1', { text: 'mail', quiet: false, line: '✉ 1 message' }, w.gate)
    w.finishResume()
    await delivery
    expect(w.sent).toEqual(['mail'])
    expect(w.events).toHaveLength(1)
  })
})
