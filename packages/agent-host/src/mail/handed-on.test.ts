/**
 * Work handed on (docs/plans/mailbox.md §9.4, §10.6.3): B works on task T1 from A and gives C task T2 (caused by T1). While T2 is open, B's last
 * response answers nothing of T1; C's report wakes B with T1 as that turn's work; once T2 is answered, B's last response answers T1.
 */
import { describe, expect, it } from 'vitest'
import { parseAddress } from './address.js'
import type { LastResponse } from './last-response.js'
import { A, B, C, world } from './messages.test-helpers.js'
import { MessageService } from './messages.js'
import { MailTurns } from './turns.js'

function setup() {
  const w = world()
  // Filled once the turns exist: the service reads a session's turn through it
  const box: { turns?: MailTurns } = {}
  const mail = new MessageService(w.store.mailbox, w.reach, {
    hostId: 'hub-aaaaaaaa',
    now: () => w.clock.t,
    turn: (address) => {
      const party = parseAddress(address)
      return (party?.kind === 'session' && box.turns?.current(party.sessionId)) || null
    },
  })
  box.turns = new MailTurns(w.store.mailbox, { now: () => w.clock.t })
  return { ...w, mail, turns: box.turns }
}
/** A last response that answers every session's tasks */
const last = (answer: string): LastResponse => ({ body: () => 'The session ended its turn.', answer, released: true, answers: () => true })

describe('work handed on (§9.4)', () => {
  it('a last response answers nothing while the task handed on is open; C’s report wakes B with T1 as its work; the next last response answers T1', () => {
    const w = setup()
    const t1 = w.mail.task(A, B, { text: 'land #12', origin: 'start_agent', delivered: true })
    w.turns.beginOther('b', 'caller', t1.id, 'a')
    w.clock.t += 10
    const t2 = w.mail.task(B, C, { text: 'write the tests for #12', origin: 'start_agent', delivered: true })
    expect(t2.causeId).toBe(t1.id)
    // B's turn ends while T2 is open: that work is not done, so its last response answers nothing
    w.turns.observe({ type: 'turn_complete', sessionId: 'b' } as never, true)
    expect(w.mail.lastResponse(B, last('Waiting on C.'))).toEqual([])
    expect(w.rowOf(t1.id, B).settled).toBeNull()
    expect(w.store.mailbox.reportsOn(t1.id)).toEqual([])
    // C answers T2 with its last response
    expect(w.mail.lastResponse(C, last('Tests written.'))).toEqual([t2.id])
    const [fromC] = w.store.mailbox.reportsOn(t2.id)
    expect(fromC!.replyTo).toBe(t2.id)
    // The wake of B that carries C's report (due after its debounce) is T1's work
    w.clock.t += 3_000
    expect(w.mail.drain(B, {}).workMessage).toBe(t1.id)
    w.turns.begin('b', { workMessage: t1.id, starter: t1.id })
    w.turns.observe({ type: 'turn_complete', sessionId: 'b' } as never, true)
    expect(w.mail.lastResponse(B, last('#12 landed with its tests.'))).toEqual([t1.id])
    expect(w.store.mailbox.reportsOn(t1.id).map((r) => [r.facts.outcome, r.facts.answer])).toEqual([['finished', '#12 landed with its tests.']])
    expect(w.rowOf(t1.id, B).settled).toBe('reported')
  })
})
