/**
 * What the old delegation paths call (docs/plans/mailbox.md §9, §10.6.3): a delegation writes a task, a turn that mail did not start is recorded with
 * the task it is the work of, the end of the Assistant's request turn is S12 on each request, a call that returned the answer is the report, and the
 * person's work (a script's or the RPC's first message) is the person's task.
 */
import { describe, expect, it } from 'vitest'
import { PERSON } from './address.js'
import { answerRecorder, delegationRecorder, linkedGoneRecorder, personOwes, personReportRecorder, personWorkRecorder, requestTurnRecorder, turnRecorder } from './delegation.js'
import { A, B, ORC, W, world } from './messages.test-helpers.js'
import { MessageService } from './messages.js'
import { MailTurns } from './turns.js'
import { parseAddress } from './address.js'
import { turnsOf } from '../dev-services/store/mailbox-turns.test-helpers.js'

/** The message world with real turns behind the service's `turn` option */
function turnWorld() {
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
  const end = (sessionId: string) => t.observe({ type: 'turn_complete', sessionId } as never, true)
  return { ...w, mail, turns: t, end }
}

describe('a delegation written down (§9.1)', () => {
  it('is a task from the caller to the child, delivered and read (the old path gave it the words), and the turn it started is that task’s', () => {
    const w = turnWorld()
    w.turns.beginOther('w', 'caller', null, 'a')
    delegationRecorder(w.mail, w.turns)('a', 'w', 'start_agent', 'Write the export\nand test it')
    const task = w.store.mailbox.newestTask(A, W)!
    expect(task).toMatchObject({ kind: 'task', sender: A, body: 'Write the export\nand test it', origin: 'start_agent', depth: 0 })
    expect(w.rowOf(task.id, W)).toMatchObject({ deliveredAt: w.clock.t, readAt: w.clock.t, settled: null })
    expect(w.turns.current('w')).toMatchObject({ by: 'caller', messageId: task.id, starter: task.id })
    expect(turnsOf(w.store, 'w')[0]).toMatchObject({ messageId: task.id, starterId: task.id })
  })

  it('each delegation is its own task; one handed on in the middle of work is caused by that work', () => {
    const w = turnWorld()
    const record = delegationRecorder(w.mail, w.turns)
    record('a', 'w', 'start_agent', 'first')
    record('a', 'w', 'agent_session', 'second')
    expect(w.store.mailbox.watchedFrom(A).map((r) => w.message(r.messageId).body)).toEqual(['first', 'second'])
    // w works on a's task and hands some of it on to b
    w.turns.beginOther('w', 'caller', w.store.mailbox.newestTask(A, W)!.id, 'a')
    record('w', 'b', 'send_to_session', 'part of it')
    expect(w.store.mailbox.newestTask(W, B)).toMatchObject({ causeId: w.store.mailbox.newestTask(A, W)!.id })
  })
})

describe('a turn the mailbox did not start', () => {
  it('a caller’s message starts a turn of that caller’s task; the person’s own turn is nobody’s work', () => {
    const w = turnWorld()
    const task = w.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    const record = turnRecorder(w.mail, w.store.mailbox, w.turns)
    record('w', { by: 'work', cli: false, source: 'caller', ownerId: 'a' })
    expect(w.turns.current('w')).toMatchObject({ by: 'caller', messageId: task.id, starter: task.id })
    w.end('w')
    record('w', { by: 'person', cli: false, source: 'caller' })
    expect(w.turns.current('w')).toMatchObject({ by: 'person', messageId: null, starter: null })
  })

  it('the CLI running on after the work’s background tasks is a turn of that task; a report or an app’s message is a turn of its own kind', () => {
    const w = turnWorld()
    const task = w.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    const record = turnRecorder(w.mail, w.store.mailbox, w.turns)
    record('w', { by: 'work', cli: true, source: 'caller', ownerId: 'a' })
    expect(w.turns.current('w')).toMatchObject({ by: 'cli', messageId: task.id, starter: null })
    w.end('w')
    record('w', { by: 'work', cli: false, source: 'report' })
    expect(w.turns.current('w')).toMatchObject({ by: 'report', messageId: null })
  })

  /*
   * #1639: a turn is decided at its start by the oldest message given before it, and decided again when the tool names the input it opened from.
   * The same turn's row is corrected in place: no second turn is begun, and the first is not closed lost
   */
  it('a turn decided again by the input the tool names is the same turn, its row corrected in place', () => {
    const w = turnWorld()
    const task = w.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    const record = turnRecorder(w.mail, w.store.mailbox, w.turns)
    record('w', { by: 'person', cli: false, source: 'caller', ownerId: 'a' })
    const seq = w.turns.current('w')!.turnSeq
    record('w', { by: 'work', cli: false, source: 'caller', ownerId: 'a', again: true })
    expect(w.turns.current('w')).toMatchObject({ turnSeq: seq, by: 'caller', messageId: task.id, starter: task.id })
    expect(turnsOf(w.store, 'w')).toEqual([expect.objectContaining({ turnSeq: seq, startedBy: 'caller', messageId: task.id, starterId: task.id, outcome: null })])
    // And back to the CLI's own: what it sends has no cause
    record('w', { by: 'work', cli: true, source: 'caller', again: true })
    expect(turnsOf(w.store, 'w')).toEqual([expect.objectContaining({ turnSeq: seq, startedBy: 'cli', starterId: null, outcome: null })])
    // A turn the mailbox's delivery started is the mailbox's: not decided again
    w.end('w')
    const mailSeq = w.turns.begin('w', { workMessage: null, starter: null })
    record('w', { by: 'person', cli: false, source: 'caller', again: true })
    expect(w.turns.current('w')).toMatchObject({ turnSeq: mailSeq, by: 'mail' })
  })

  it('the person’s work: the turn its first message starts is the person’s task', () => {
    const w = turnWorld()
    personWorkRecorder(w.mail)('w', 'Sort the photos')
    const task = w.store.mailbox.newestTask(PERSON, W)!
    turnRecorder(w.mail, w.store.mailbox, w.turns)('w', { by: 'work', cli: false, source: 'caller' })
    expect(w.turns.current('w')).toMatchObject({ messageId: task.id })
  })
})

describe('the end of the Assistant’s request turn (§7.6)', () => {
  it('S12 replies to the turn’s request, carries none of the Assistant’s words, and settles it', () => {
    const w = turnWorld()
    w.clock.t += 10
    const request = w.mail.send(A, { to: [ORC], text: 'please check CI', needsReply: true })
    const seq = w.turns.begin('orc', { workMessage: request.message.id, starter: request.message.id })
    w.store.mailbox.markDelivered(ORC, [request.message.id], w.clock.t, seq)
    w.end('orc')
    requestTurnRecorder(w.mail, w.turns, (id) => w.mail.sessionAddress(id))('orc')
    const [r] = w.store.mailbox.reportsOn(request.message.id)
    expect(r!.body).toContain('The Assistant ended its turn on your request.')
    expect(r!.facts.answer).toBeUndefined()
    expect(w.rowOf(request.message.id, ORC).settled).toBe('reported')
  })
})

describe('a call that returned the answer (§9.6)', () => {
  it('is the report: written as told, delivered and read, and the task is settled, so nothing wakes the caller', () => {
    const w = turnWorld()
    const task = w.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    answerRecorder(w.mail, w.store.mailbox)('a', 'w', { ok: true, text: 'all done' })
    const [r] = w.store.mailbox.reportsOn(task.id)
    expect(r!.facts).toMatchObject({ outcome: 'finished', answer: 'all done' })
    // All the host knows is that the turn ended: whether the work is done is the child's own word (#1902)
    expect(r!.body).toContain('ended its turn')
    expect(r!.body).not.toMatch(/finished/i)
    expect(w.rowOf(r!.id, A)).toMatchObject({ deliveredAt: expect.any(Number), readAt: expect.any(Number) })
    expect(w.rowOf(task.id, W).settled).toBe('reported')
  })

  it('a failure says its kind; an answer over 600 characters is cut; a read of where it stands only marks the reports read', () => {
    const w = turnWorld()
    const task = w.mail.task(A, W, { text: 'job', origin: 'start_agent', delivered: true })
    const paused = w.mail.report(task.id, { outcome: 'paused', paused: 1, body: 'paused' })
    answerRecorder(w.mail, w.store.mailbox)('a', 'w')
    expect('message' in paused && w.rowOf(paused.message.id, A).readAt).not.toBeNull()
    expect(w.rowOf(task.id, W).settled).toBeNull()
    answerRecorder(w.mail, w.store.mailbox)('a', 'w', { ok: false, error: 'network' })
    expect(w.store.mailbox.reportsOn(task.id).at(-1)!.facts).toMatchObject({ outcome: 'failed', error: 'network' })
    const t2 = w.mail.task(A, W, { text: 'again', origin: 'agent_session', delivered: true })
    answerRecorder(w.mail, w.store.mailbox)('a', 'w', { ok: true, text: 'x'.repeat(700) })
    expect(w.store.mailbox.reportsOn(t2.id)[0]!.facts.answer).toHaveLength(601)
  })
})

describe('the person’s work (§9.6)', () => {
  it('is a task from the person, delivered; the person is owed its turn’s report until it is reported, and a pause leaves it owed', () => {
    const w = turnWorld()
    personWorkRecorder(w.mail)('w', 'Sort the photos', { credential: 'cred-1' })
    const task = w.store.mailbox.newestTask(PERSON, W)!
    expect(task).toMatchObject({ kind: 'task', origin: 'script' })
    const owes = personOwes(w.mail, w.store.mailbox)
    const report = personReportRecorder(w.mail, w.store.mailbox)
    expect(owes('w')).toBe(true)
    expect(report('w', { outcome: 'paused', body: 'paused', paused: 1, then: 'running' })).toBe(true)
    expect(owes('w')).toBe(true)
    expect(report('w', { outcome: 'finished', body: 'done', answer: 'sorted', then: 'review' })).toBe(true)
    expect(owes('w')).toBe(false)
    expect(w.store.mailbox.reportsOn(task.id).map((r) => r.facts.outcome)).toEqual(['paused', 'finished'])
    // Nothing more to report
    expect(report('w', { outcome: 'finished', body: 'again', then: 'review' })).toBe(false)
  })
})

describe('notes the hub held for a child on a linked machine that is gone (#2114)', () => {
  it('are the tasks they were, never delivered, released gone: the caller is told once, in the stop notice, naming each', () => {
    const w = turnWorld()
    w.sessions.set('r', { projectId: null, name: 'Child on Box', canReadMail: false })
    linkedGoneRecorder(w.mail, w.store.mailbox)('r', 'a', ['use staging', 'and the docs'])
    const R = w.mail.sessionAddress('r')
    const told = w.records.pendingFor(A, w.clock.t + 60_000).filter((p) => p.message.kind === 'notice' && p.message.facts.unanswered)
    expect(told).toHaveLength(1)
    const ids = (told[0]!.message.facts.unanswered ?? []).map((u) => u.id)
    expect(ids.map((id) => [w.message(id).body, w.rowOf(id, R).deliveredAt, w.rowOf(id, R).releasedWhy])).toEqual([
      ['use staging', null, 'gone'],
      ['and the docs', null, 'gone'],
    ])
    expect(told[0]!.message.body).toContain('Child on Box')
  })
})
