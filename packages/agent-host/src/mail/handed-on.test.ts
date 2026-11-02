/**
 * Work handed on (docs/plans/mailbox.md §9.4): B works on task T1 from A and gives C task T2 (caused by T1). B's turn ends while T2 is owed, so the
 * report to A says `waiting` and T1 stays open; C's report wakes B with T1 as that turn's work; the final report to A comes when a turn of T1 ends with
 * nothing owed. Only what the old report paths still owe counts (§9.5).
 */
import { describe, expect, it } from 'vitest'
import { parseAddress } from './address.js'
import { reportRecorder, type ReportDraft } from './delegation.js'
import { A, B, C, world } from './messages.test-helpers.js'
import { MessageService } from './messages.js'
import { MailTurns } from './turns.js'

function setup(owed: Set<string>) {
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
  const t = box.turns
  const oldOwes = (sender: string, recipient: string) => owed.has(`${sender}>${recipient}`)
  const waitingOn = (ownerId: string, childId: string) => mail.waitingOn(mail.sessionAddress(ownerId), mail.sessionAddress(childId), t.latest(childId)?.messageId ?? null, oldOwes)
  const report = reportRecorder(mail, w.store.mailbox, t, waitingOn)
  return { ...w, mail, turns: t, report, waitingOn }
}
const ended = (over: Partial<ReportDraft> = {}): ReportDraft => ({ outcome: 'finished', body: 'done', then: 'review', delivery: 'wake', ...over })

describe('work handed on (§9.4)', () => {
  it('the report to the first owner says waiting while the second task is owed; the turn C’s report starts is T1’s; the end with nothing owed reports T1', () => {
    const owed = new Set<string>([`${B}>${C}`])
    const w = setup(owed)
    const t1 = w.mail.task(A, B, { text: 'land #12', origin: 'start_agent', delivered: true })
    w.turns.beginOther('b', 'caller', t1.id, 'a')
    w.clock.t += 10
    const t2 = w.mail.task(B, C, { text: 'write the tests for #12', origin: 'start_agent', delivered: true })
    expect(t2.causeId).toBe(t1.id)
    expect(w.waitingOn('a', 'b')).toBe(1)
    // B's turn ends: the old path sees work handed on and words it as a pause
    w.report('a', 'b', ended({ outcome: 'paused', then: 'running' }))
    expect(w.store.mailbox.reportsOn(t1.id)[0]!.facts).toMatchObject({ outcome: 'waiting', waitingOn: 1 })
    expect(w.rowOf(t1.id, B).settled).toBeNull()
    w.turns.observe({ type: 'turn_complete', sessionId: 'b' } as never, true)
    // C reports T2; the old path no longer owes it
    w.turns.beginOther('c', 'caller', t2.id, 'b')
    w.report('b', 'c', ended())
    owed.delete(`${B}>${C}`)
    const fromC = w.store.mailbox.reportsOn(t2.id)[0]!
    // The wake of B that carries C's report (due after its debounce) is T1's work
    w.clock.t += 3_000
    expect(w.mail.drain(B, {}).workMessage).toBe(t1.id)
    expect(fromC.replyTo).toBe(t2.id)
    expect(w.waitingOn('a', 'b')).toBe(0)
    w.turns.begin('b', { workMessage: t1.id, starter: t1.id })
    w.report('a', 'b', ended())
    expect(w.store.mailbox.reportsOn(t1.id).map((r) => r.facts.outcome)).toEqual(['waiting', 'finished'])
    expect(w.rowOf(t1.id, B).settled).toBe('reported')
  })

  it('a task the old paths no longer owe does not count, whatever its row says', () => {
    const w = setup(new Set())
    const t1 = w.mail.task(A, B, { text: 'land #12', origin: 'start_agent', delivered: true })
    w.turns.beginOther('b', 'caller', t1.id, 'a')
    w.mail.task(B, C, { text: 'part', origin: 'start_agent', delivered: true })
    expect(w.waitingOn('a', 'b')).toBe(0)
  })
})
