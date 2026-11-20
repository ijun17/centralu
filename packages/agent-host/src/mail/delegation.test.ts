/**
 * What the old delegation paths call (docs/plans/mailbox.md §9, §10.6.3): a delegation writes a task, a turn that mail did not start is recorded with
 * the task it is the work of, the end of the Assistant's request turn is S12 on each request, a call that returned the answer is the report, and the
 * person's work (a script's or the RPC's first message) is the person's task.
 */
import { describe, expect, it } from 'vitest'
import { PERSON } from './address.js'
import { answerRecorder, delegationRecorder, linkedTasksOf, personWorkRecorder, requestTurnRecorder, turnRecorder } from './delegation.js'
import { A, B, ORC, W, world } from './messages.test-helpers.js'
import { MessageService } from './messages.js'
import { MailTurns } from './turns.js'
import { ANSWER_KEPT_CHARS } from './last-response.js'
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

  it('a turn a sender that is no session started (a hub’s Assistant, Centralu) is a caller’s turn of no task, not the person’s (#2290)', () => {
    const w = turnWorld()
    personWorkRecorder(w.mail)('w', 'Sort the photos')
    turnRecorder(w.mail, w.store.mailbox, w.turns)('w', { by: 'work', cli: false, source: 'caller', unowned: true })
    expect(w.turns.current('w')).toMatchObject({ by: 'caller', messageId: null, starter: null })
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

  it('a failure says its kind; an answer is kept whole up to a message’s length, and past it cut, as its words say (#2358); a read of where it stands only marks the reports read', () => {
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
    const [whole] = w.store.mailbox.reportsOn(t2.id)
    expect(whole!.facts.answer).toBe('x'.repeat(700))
    expect(whole!.body).toContain('reading this report shows it.')
    const t3 = w.mail.task(A, W, { text: 'more', origin: 'agent_session', delivered: true })
    answerRecorder(w.mail, w.store.mailbox)('a', 'w', { ok: true, text: 'y'.repeat(ANSWER_KEPT_CHARS + 50) })
    const [cut] = w.store.mailbox.reportsOn(t3.id)
    expect(cut!.facts.answer).toBe(`${'y'.repeat(ANSWER_KEPT_CHARS - 1)}…`)
    expect(cut!.body).toContain('reading this report shows its start, and read_session(sessionId="w") reads the rest.')
  })
})

describe('work this hub gave a session on a linked machine, as its copies here read (#1948 step 6)', () => {
  /** The copy of a task given across the link, as `MailAcross.sendTask` writes it once the machine took it */
  const given = (w: ReturnType<typeof turnWorld>, text: string) => {
    const id = w.mail.mintId()
    w.mail.sentAcross(A, { id, to: w.mail.sessionAddress('m1.r'), text, needsReply: false, task: { origin: 'agent_session' } })
    return id
  }
  const tasksOf = (w: ReturnType<typeof turnWorld>) => linkedTasksOf(w.mail, w.store.mailbox, { sendTask: async () => ({ ok: false, why: 'x', text: 'x' }), taskRefusal: () => null, keepAsk: () => {}, holdReports: () => () => {} }, () => () => {})

  it('is open until its report comes back, which it reads with the answer kept and whom it went to', () => {
    const w = turnWorld()
    const tasks = tasksOf(w)
    const id = given(w, 'build it')
    expect(tasks.open('a', 'm1.r')).toBe(id)
    expect(tasks.standing(id)).toEqual({ state: 'open' })
    w.mail.report(id, { outcome: 'finished', body: '[Centralu] The session ended its turn.', answer: 'built' })
    expect(tasks.standing(id)).toEqual({ state: 'reported', outcome: 'finished', answer: 'built', owner: A })
    expect(tasks.open('a', 'm1.r')).toBeUndefined()
    expect(tasks.lastAnswer('a', 'm1.r')).toBe('built')
  })

  it("is withdrawn by its sender's stop, and then reads as ended with no report", () => {
    const w = turnWorld()
    const tasks = tasksOf(w)
    const id = given(w, 'build it')
    expect(tasks.withdraw('a', 'm1.r')).toBe(1)
    expect(tasks.standing(id)).toEqual({ state: 'ended', why: 'withdrawn' })
  })

  it('is released gone with a child whose machine was removed: its sender is told once, in the stop notice', () => {
    const w = turnWorld()
    w.sessions.set('m1.r', { projectId: null, name: 'Child on Box', canReadMail: false })
    const tasks = tasksOf(w)
    const id = given(w, 'build it')
    tasks.gone('m1.r')
    expect(w.rowOf(id, w.mail.sessionAddress('m1.r')).releasedWhy).toBe('gone')
    expect(tasks.standing(id)).toEqual({ state: 'ended', why: 'gone' })
    const told = w.records.pendingFor(A, w.clock.t + 60_000).filter((p) => p.message.kind === 'notice' && p.message.facts.unanswered)
    expect(told).toHaveLength(1)
    expect(told[0]!.message.body).toContain('Child on Box')
  })
})
