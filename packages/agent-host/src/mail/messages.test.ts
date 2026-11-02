/**
 * `MessageService`: sending, the guards, the one hold, trust, reports and reading (docs/plans/mailbox.md §16 M2). Each test asks one rule of a real
 * store, so a rule that is dropped fails the test that names it.
 */
import { describe, expect, it } from 'vitest'
import { PERSON } from './address.js'
import { A, B, C, ORC, W, X, Y, HOST, NOW, addr, refusedFor, world } from './messages.test-helpers.js'
import { MAX_DEPTH } from './rules.js'

const MINUTE = 60_000

describe('sending', () => {
  it('send to several recipients writes one message and a row each', () => {
    const w = world()
    const r = w.send(A, { to: [B, C, B], text: 'hello all' })
    expect(r.message).toMatchObject({ sender: A, kind: 'message', body: 'hello all', needsReply: true, origin: 'mail', senderProject: 'p1', depth: 0, causeId: null, replyTo: null })
    expect(r.message.rootId).toBe(r.message.id)
    const rows = w.records.recipients(r.message.id)
    expect(rows.map((x) => [x.recipient, x.recipientProject, x.held, x.deliveredAt])).toEqual([[B, 'p1', null, null], [C, 'p2', null, null]])
    expect(rows[0]?.dueAt).toBe(w.clock.t + 2_000)
    expect(refusedFor(() => w.send(A, { to: [B, C, X, Y, W, ORC, addr('d1'), addr('d2'), addr('d3'), addr('d4'), addr('d5')], text: 'too many' }))).toBe('recipients')
  })

  it('tells the listeners once the message has committed, and not when it did not', () => {
    const w = world()
    const heard: string[] = []
    w.mail.onChange((c) => heard.push(`${c.messageId}>${c.recipients.join(',')}`))
    const r = w.send(A, { to: [B, C], text: 'x' })
    expect(heard).toEqual([`${r.message.id}>${B},${C}`])
    expect(refusedFor(() => w.send(A, { to: [addr('nobody')], text: 'y' }))).toBe('gone')
    expect(heard).toHaveLength(1)
  })

  it('send with replyTo settles the sender’s own row on the target as answered', () => {
    const w = world()
    const q = w.send(B, { to: [A], text: 'which branch?' }).message
    expect(w.rowOf(q.id, A).settled).toBeNull()
    const a = w.send(A, { replyTo: q.id, text: 'main' })
    expect(a.answered).toBe(q.id)
    expect(w.rowOf(q.id, A)).toMatchObject({ settled: 'answered', answerId: a.message.id })
    expect(a.message).toMatchObject({ replyTo: q.id, rootId: q.id, needsReply: false })
  })

  it('a reply goes to the target’s sender only; send id= on one’s own message is refused own_message', () => {
    const w = world()
    const group = w.send(A, { to: [B, C], text: 'to both' }).message
    const answer = w.send(B, { replyTo: group.id, text: 'got it' }).message
    expect(w.records.recipients(answer.id).map((r) => r.recipient)).toEqual([A])
    expect(refusedFor(() => w.send(A, { replyTo: group.id, text: 'again' }))).toBe('own_message')
    // Naming who it is for is allowed
    expect(w.send(A, { replyTo: group.id, to: [C], text: 'only you' }).message.replyTo).toBe(group.id)
  })

  it('send with an id that is not stored, or that the sender may not read, is refused unknown_message', () => {
    const w = world()
    const m = w.send(A, { to: [B], text: 'private' }).message
    expect(refusedFor(() => w.send(B, { replyTo: `${HOST}.m_01J00000000000000000000000`, to: [A], text: 'x' }))).toBe('unknown_message')
    expect(refusedFor(() => w.send(C, { replyTo: m.id, to: [A], text: 'x' }))).toBe('unknown_message')
  })

  it('refuses what the reach does not allow: an unreadable seat, a session that is gone, another computer, a bad address, oneself, a bad body', () => {
    const w = world()
    w.sessions.set('nomail', { projectId: 'p1', canReadMail: false })
    w.sessions.set('away', { projectId: 'p1', here: false })
    expect(refusedFor(() => w.send(A, { to: [addr('nomail')], text: 'x' }))).toBe('no_mailbox')
    expect(refusedFor(() => w.send(A, { to: [addr('away')], text: 'x' }))).toBe('gone')
    expect(refusedFor(() => w.send(A, { to: ['session:hub-bbbbbbbb/z'], text: 'x' }))).toBe('elsewhere')
    expect(refusedFor(() => w.send(A, { to: ['not an address'], text: 'x' }))).toBe('bad_address')
    expect(refusedFor(() => w.send(A, { to: ['centralu'], text: 'x' }))).toBe('not_allowed')
    expect(refusedFor(() => w.send(A, { to: [A], text: 'x' }))).toBe('bad_value')
    expect(refusedFor(() => w.send(A, { to: [B], text: '  ' }))).toBe('empty')
    expect(refusedFor(() => w.send(A, { to: [B], text: 'x'.repeat(16_001) }))).toBe('too_long')
    expect(refusedFor(() => w.send(A, { to: [PERSON], text: 'ok' }))).toBe('NOT REFUSED')
    expect(refusedFor(() => w.mail.send('centralu', { to: [A], text: 'x' }))).toBe('not_allowed')
    // Nothing was written by a refused call, a bad body included
    expect(w.records.watchedFrom(A).map((r) => r.recipient)).toEqual([PERSON])
  })

  it('a new message is sent with needsReply true unless false is given; an answer with false unless true is given', () => {
    const w = world()
    expect(w.send(A, { to: [B], text: 'one' }).message.needsReply).toBe(true)
    expect(w.send(A, { to: [B], text: 'two', needsReply: false }).message.needsReply).toBe(false)
    const q = w.send(B, { to: [A], text: 'q' }).message
    expect(w.send(A, { replyTo: q.id, text: 'a1' }).message.needsReply).toBe(false)
    const q2 = w.send(B, { to: [A], text: 'q2' }).message
    expect(w.send(A, { replyTo: q2.id, text: 'a2', needsReply: true }).message.needsReply).toBe(true)
    // A task is never watched for a reply, whatever is asked
    expect(w.mail.task(A, B, { text: 'work', origin: 'start_agent', delivered: true }).needsReply).toBe(false)
  })

  it('only needsReply messages and tasks are watched', () => {
    const w = world()
    const plain = w.send(A, { to: [B], text: 'fyi', needsReply: false }).message
    const asked = w.send(A, { to: [B], text: 'q' }).message
    const task = w.mail.task(A, B, { text: 'work', origin: 'start_agent', delivered: true })
    expect(w.mail.watchedFrom(A).map((r) => r.messageId).sort()).toEqual([asked.id, task.id].sort())
    expect(w.mail.watchedTo(B).map((r) => r.messageId)).not.toContain(plain.id)
  })

  it('the person’s message has no project, is due at once and may be urgent; an app’s urgent flag and a session’s over-long text are refused', () => {
    const w = world()
    const r = w.mail.send(PERSON, { to: [A], text: 'go', urgent: true }).message
    expect(r).toMatchObject({ sender: PERSON, senderProject: null, origin: 'person', urgent: true })
    expect(w.rowOf(r.id, A).dueAt).toBe(w.clock.t)
  })
})

describe('the guards', () => {
  it('the sixth non-reply message an hour to one session is refused pair_rate; replies pass', () => {
    const w = world()
    for (let i = 1; i <= 5; i++) w.send(A, { to: [B], text: `new ${i}` })
    expect(refusedFor(() => w.send(A, { to: [B], text: 'new 6' }))).toBe('pair_rate')
    // The other direction is another pair, another recipient is another pair, and a reply is no new conversation
    expect(refusedFor(() => w.send(B, { to: [A], text: 'ping' }))).toBe('NOT REFUSED')
    expect(refusedFor(() => w.send(A, { to: [C], text: 'new 6' }))).toBe('NOT REFUSED')
    const q = w.send(B, { to: [A], text: 'a question' }).message
    expect(refusedFor(() => w.send(A, { replyTo: q.id, text: 'an answer' }))).toBe('NOT REFUSED')
    // An hour later the pair is free again
    w.clock.t += 61 * MINUTE
    expect(refusedFor(() => w.send(A, { to: [B], text: 'new 7' }))).toBe('NOT REFUSED')
  })

  it('the same text to the same session within 10 minutes is refused repeat', () => {
    const w = world()
    w.send(A, { to: [B], text: 'ping' })
    expect(refusedFor(() => w.send(A, { to: [B], text: 'ping' }))).toBe('repeat')
    expect(refusedFor(() => w.send(A, { to: [C], text: 'ping' }))).toBe('NOT REFUSED')
    w.clock.t += 10 * MINUTE + 1
    expect(refusedFor(() => w.send(A, { to: [B], text: 'ping' }))).toBe('NOT REFUSED')
  })

  it('a session posts at most 30 a minute, counted in the store', () => {
    const w = world()
    const t = w.send(B, { to: [A], text: 'start', needsReply: false }).message
    for (let i = 1; i <= 30; i++) w.send(A, { replyTo: t.id, text: `reply ${i}` })
    expect(refusedFor(() => w.send(A, { replyTo: t.id, text: 'reply 31' }))).toBe('rate_limited')
    w.clock.t += MINUTE
    expect(refusedFor(() => w.send(A, { replyTo: t.id, text: 'reply 32' }))).toBe('NOT REFUSED')
  })

  it('a request to the orchestrator has no one-open rule; the sixth an hour from one group is refused ask_rate; an answer to its needsReply message is no request', () => {
    const w = world()
    // Three from A and two from B (one project, one group): none waits for the first to be answered
    for (let i = 1; i <= 3; i++) w.send(A, { to: [ORC], text: `A asks ${i}` })
    w.send(B, { to: [ORC], text: 'B asks 1' })
    w.send(B, { to: [ORC], text: 'B asks 2' })
    expect(refusedFor(() => w.send(B, { to: [ORC], text: 'B asks 3' }))).toBe('ask_rate')
    // Another project is another group
    expect(refusedFor(() => w.send(C, { to: [ORC], text: 'C asks' }))).toBe('NOT REFUSED')
    // The orchestrator asks B something; B's answer is no request and is not counted or refused
    const q = w.send(ORC, { to: [B], text: 'which?' }).message
    expect(refusedFor(() => w.send(B, { replyTo: q.id, text: 'this one' }))).toBe('NOT REFUSED')
    expect(w.records.requestsSince([A, B], ORC, NOW)).toBe(5)
    // And once the hour is over the group may ask again
    w.clock.t += 61 * MINUTE
    expect(refusedFor(() => w.send(B, { to: [ORC], text: 'B asks 3' }))).toBe('NOT REFUSED')
  })

  it('a session writes to the orchestrator only while its tool can put a request’s steps to the person; an answer to the orchestrator is no request', () => {
    const w = world()
    const q = w.send(ORC, { to: [B], text: 'which?' }).message
    w.state.asks = false
    expect(refusedFor(() => w.send(B, { to: [ORC], text: 'may I?' }))).toBe('orchestrator_asks')
    expect(refusedFor(() => w.send(B, { replyTo: q.id, text: 'this one' }))).toBe('NOT REFUSED')
    // The orchestrator itself writes to whomever it likes
    expect(refusedFor(() => w.send(ORC, { to: [B], text: 'carry on' }))).toBe('NOT REFUSED')
  })
})

describe('done', () => {
  it('by a recipient settles its row; by the sender withdraws every unsettled row; on an unwatched message says so', () => {
    const w = world()
    const m = w.send(A, { to: [B, C], text: 'need an answer' }).message
    expect(w.mail.done(B, m.id)).toEqual({ settled: 1, how: 'done' })
    expect(w.rowOf(m.id, B).settled).toBe('done')
    expect(w.mail.done(B, m.id)).toEqual({ settled: 0, how: 'none' })
    expect(w.mail.done(A, m.id)).toEqual({ settled: 1, how: 'withdrawn' })
    expect(w.rowOf(m.id, B).settled).toBe('done')
    expect(w.rowOf(m.id, C).settled).toBe('withdrawn')
    expect(w.mail.done(A, m.id)).toEqual({ settled: 0, how: 'none' })
    const note = w.send(A, { to: [B], text: 'fyi', needsReply: false }).message
    expect(w.mail.done(B, note.id)).toEqual({ settled: 0, how: 'unwatched' })
    expect(w.mail.done(A, note.id)).toEqual({ settled: 0, how: 'unwatched' })
  })

  it('refuses a message that is not stored, and one the caller was not sent and did not send; a task’s receiver cannot close it', () => {
    const w = world()
    const m = w.send(A, { to: [B], text: 'x' }).message
    expect(refusedFor(() => w.mail.done(B, `${HOST}.m_01J00000000000000000000000`))).toBe('unknown_message')
    expect(refusedFor(() => w.mail.done(C, m.id))).toBe('not_yours')
    const t = w.mail.task(A, B, { text: 'work', origin: 'start_agent', delivered: true })
    expect(w.mail.done(B, t.id)).toEqual({ settled: 0, how: 'unwatched' })
    expect(w.rowOf(t.id, B).settled).toBeNull()
    expect(w.mail.done(A, t.id)).toEqual({ settled: 1, how: 'withdrawn' })
  })
})

describe('the one hold (D12)', () => {
  it('an untrusted project’s session to another project’s session and to the orchestrator is held policy; to its own project and to the person it is not', () => {
    const w = world()
    const m = w.send(X, { to: [C, ORC, Y, PERSON, A], text: 'out and in' })
    expect(m.held.map((h) => [h.recipient, h.why])).toEqual([[C, 'policy'], [ORC, 'policy'], [A, 'policy']])
    expect(w.records.recipients(m.message.id).map((r) => [r.recipient, r.held])).toEqual([[PERSON, null], [A, 'policy'], [C, 'policy'], [ORC, 'policy'], [Y, null]])
  })

  it('a trusted session’s message is never held, whatever it read (D11)', () => {
    const w = world()
    const m = w.send(A, { to: [X, C, B, ORC], text: 'relayed' })
    expect(m.held).toEqual([])
    expect(w.records.heldPolicy()).toEqual([])
  })

  it('a report is never held, and neither is a task', () => {
    const w = world()
    const task = w.mail.task(X, C, { text: 'work', origin: 'start_agent', delivered: true })
    expect(w.rowOf(task.id, C).held).toBeNull()
    const out = w.mail.report(task.id, { outcome: 'finished', body: 'done' })
    expect('message' in out && w.rowOf(out.message.id, X).held).toBeNull()
  })

  it('refused writes a delivered, read record; trustChanged posts one S16 per caller listing them, deletes them and says whom to poke', () => {
    const w = world()
    w.mail.refused('x', { tool: 'start_agent', target: 'session c', firstLine: 'build\nthe thing', projectId: 'px' })
    w.mail.refused('x', { tool: 'ask_project', target: 'project p2', firstLine: 'help', projectId: 'px' })
    w.mail.refused('y', { tool: 'agent_session', target: 'session c', firstLine: 'again', projectId: 'px' })
    const records = w.records.refusedRecords('px')
    expect(records).toHaveLength(3)
    expect(records[0]?.row).toMatchObject({ recipient: X })
    expect(records.every((r) => r.row.deliveredAt !== null && r.row.readAt !== null)).toBe(true)
    expect(records[0]?.message.facts.refused).toEqual({ tool: 'start_agent', target: 'session c', firstLine: 'build the thing', projectId: 'px' })
    expect(w.records.pendingFor(X, w.clock.t + 10_000)).toEqual([])
    // The same refusal again within the minute is the same record
    w.mail.refused('y', { tool: 'agent_session', target: 'session c', firstLine: 'again', projectId: 'px' })
    expect(w.records.refusedRecords('px')).toHaveLength(3)

    w.projects.set('px', { trusted: true, name: 'Pex' })
    expect(w.mail.trustChanged('px').sort()).toEqual([X, Y])
    expect(w.records.refusedRecords('px')).toEqual([])
    const told = w.records.pendingFor(X, w.clock.t + 10_000)
    expect(told).toHaveLength(1)
    expect(told[0]?.message).toMatchObject({ sender: 'centralu', kind: 'notice', facts: { trusted: { project: 'px', refused: ['start_agent to session c ("build the thing")', 'ask_project to project p2 ("help")'] } } })
    expect(told[0]?.message.body).toBe('Pex is trusted now. The calls refused for it can be given again: start_agent to session c ("build the thing"), ask_project to project p2 ("help")')
    expect(w.records.pendingFor(Y, w.clock.t + 10_000)).toHaveLength(1)
  })

  it('trustChanged lets go the rows held for that project, in the order sent, and answers the questions they answer', () => {
    const w = world()
    const q = w.send(C, { to: [X], text: 'a question' }).message
    const one = w.send(X, { to: [C], text: 'first' }).message
    const answer = w.send(X, { replyTo: q.id, text: 'the answer' }).message
    const two = w.send(X, { to: [ORC, C], text: 'second' }).message
    expect(w.rowOf(q.id, X)).toMatchObject({ settled: null, answerId: answer.id })
    const messagesTo = (who: string) => w.records.pendingFor(who, w.clock.t + 10_000).filter((p) => p.message.kind === 'message')
    expect(messagesTo(C)).toEqual([])

    w.projects.set('px', { trusted: true })
    expect(w.mail.trustChanged('px').sort()).toEqual([C, ORC].sort())
    expect(messagesTo(C).map((p) => p.message.id)).toEqual([one.id, answer.id, two.id])
    expect(w.rowOf(two.id, ORC).held).toBeNull()
    expect(w.rowOf(q.id, X)).toMatchObject({ settled: 'answered', answerId: answer.id })
    // Held for nothing else, and not released: the next hold judges them afresh
    expect(w.rowOf(one.id, C).held).toBeNull()
  })

  it('an answer that is held leaves the question open with answer_id and tells the asker once, quietly; let go it settles; dismissed it reopens', () => {
    const w = world()
    const q = w.send(A, { to: [X], text: 'a question' }).message
    const answer = w.send(X, { replyTo: q.id, text: 'the answer' })
    expect(answer.held).toEqual([{ recipient: A, why: 'policy' }])
    expect(w.rowOf(q.id, X)).toMatchObject({ settled: null, answerId: answer.message.id })
    const told = w.records.pendingFor(A, w.clock.t + 10_000).filter((p) => p.message.kind === 'notice')
    expect(told).toHaveLength(1)
    expect(told[0]?.message).toMatchObject({
      sender: 'centralu',
      facts: { quiet: true, answerHeld: { question: q.id, answer: answer.message.id } },
      dedupeKey: `answer_held:${A}:${answer.message.id}`,
    })
    expect(told[0]?.message.body).toBe(
      `xi answered your ${q.id} with ${answer.message.id}, and the answer is held for the person (Pex is not trusted). It reaches you if the person lets it through; until then Centralu does not remind xi of it.`,
    )

    // Dismissed: the answer is gone and the question is open again
    expect(w.mail.dismissProject('px')).toMatchObject({ rows: 1, senders: [X] })
    expect(w.rowOf(q.id, X)).toMatchObject({ settled: null, answerId: null })
    expect(w.records.message(answer.message.id)).toBeUndefined()

    // Let go: the same again, then the person trusts the project
    const q2 = w.send(A, { to: [X], text: 'another question' }).message
    const a2 = w.send(X, { replyTo: q2.id, text: 'another answer' }).message
    w.projects.set('px', { trusted: true })
    w.mail.trustChanged('px')
    expect(w.rowOf(q2.id, X)).toMatchObject({ settled: 'answered', answerId: a2.id })
  })

  it('dismissProject deletes the project’s held rows, and their messages when no row is left, notices each sender once, and drops refused records', () => {
    const w = world()
    const alone = w.send(X, { to: [C], text: 'to c only' }).message
    const shared = w.send(Y, { to: [C, X], text: 'to c and a friend' }).message
    const another = w.send(Y, { to: [ORC], text: 'to the orchestrator' }).message
    w.mail.refused('x', { tool: 'start_agent', target: 'session c', firstLine: 'build', projectId: 'px' })
    w.send(A, { to: [B], text: 'unrelated' })

    const out = w.mail.dismissProject('px')
    expect(out.rows).toBe(3)
    expect(out.senders.sort()).toEqual([X, Y])
    expect(w.records.message(alone.id)).toBeUndefined()
    expect(w.records.message(another.id)).toBeUndefined()
    // The friend’s row stays, so the message does
    expect(w.records.recipients(shared.id).map((r) => r.recipient)).toEqual([X])
    expect(w.records.refusedRecords('px')).toEqual([])
    expect(w.records.heldPolicy()).toEqual([])

    const toY = w.records.pendingFor(Y, w.clock.t + 10_000)
    expect(toY).toHaveLength(1)
    expect(toY[0]?.message.body).toBe(`The person dismissed 2 of your messages that were waiting for project Pex to be trusted (${shared.id}, ${another.id}). They were not delivered and will not be.`)
    // A second dismissal tells nobody again
    expect(w.mail.dismissProject('px')).toEqual({ rows: 0, senders: [] })
    expect(w.records.pendingFor(Y, w.clock.t + 10_000)).toHaveLength(1)
  })

  it('heldByProject counts held rows and refused calls per project, and names whom they were for', () => {
    const w = world()
    w.send(X, { to: [C], text: 'one' })
    w.send(Y, { to: [ORC, C], text: 'two' })
    w.mail.refused('x', { tool: 'start_agent', target: 'session c', firstLine: 'build', projectId: 'px' })
    expect(w.mail.heldByProject()).toEqual([{ projectId: 'px', count: 3, refused: 1, recipients: [C, ORC, 'session c'] }])
    w.mail.dismissProject('px')
    expect(w.mail.heldByProject()).toEqual([])
  })
})

describe('quiet answers (D3)', () => {
  it('an answer that needs nothing to a message that needed nothing is delivered quiet; to a needsReply message it wakes', () => {
    const w = world()
    const note = w.send(A, { to: [B], text: 'starting Y', needsReply: false }).message
    const thanks = w.send(B, { replyTo: note.id, text: 'thanks' })
    expect(thanks.quiet).toBe(true)
    expect(thanks.message.facts).toEqual({ quiet: true })
    const ask = w.send(A, { to: [B], text: 'a question' }).message
    const answer = w.send(B, { replyTo: ask.id, text: 'the answer' })
    expect(answer.quiet).toBe(false)
    expect(answer.message.facts).toEqual({})
    // An answer that asks something back is not quiet either
    const q = w.send(A, { to: [B], text: 'another note', needsReply: false }).message
    expect(w.send(B, { replyTo: q.id, text: 'and you?', needsReply: true }).quiet).toBe(false)
  })

  it('such an answer wakes when urgent, from the receiver’s parent, from the person, or from a session with an unsettled task to it', () => {
    const w = world()
    const quietWith = (sender: string, receiver: string, over: { urgent?: boolean } = {}) => {
      const note = w.send(receiver, { to: [sender === PERSON ? B : sender], text: `note ${Math.random()}`, needsReply: false }).message
      return w.send(sender, { replyTo: note.id, text: `answer ${Math.random()}`, ...over }).quiet
    }
    expect(quietWith(C, B)).toBe(true)
    expect(quietWith(C, B, { urgent: true })).toBe(false)
    // W was started by A: A's answer to W's note wakes W
    expect(quietWith(A, W)).toBe(false)
    expect(quietWith(W, A)).toBe(true)
    // The person's answer always wakes
    const note = w.send(B, { to: [PERSON], text: 'fyi', needsReply: false }).message
    expect(w.mail.send(PERSON, { to: [], replyTo: note.id, text: 'noted' }).quiet).toBe(false)
    // A has given B work that is not reported yet: A's answer to B's note wakes B
    w.mail.task(A, B, { text: 'work', origin: 'start_agent', delivered: true })
    expect(quietWith(A, B)).toBe(false)
  })
})

describe('cause, depth and clarifications (D9, §9.7)', () => {
  it('a message sent in a turn a message started carries that message as its cause', () => {
    const w = world()
    const m1 = w.send(A, { to: [B], text: 'first' }).message
    w.startTurn(B, m1.id)
    expect(w.send(B, { to: [C], text: 'onward' }).message).toMatchObject({ causeId: m1.id, depth: 1 })
    // A turn the person or the session itself started has no cause
    w.startTurn(B, null)
    expect(w.send(B, { to: [C], text: 'on its own' }).message).toMatchObject({ causeId: null, depth: 0 })
    w.startTurn(B, m1.id, { by: 'person' })
    expect(w.send(B, { to: [C], text: 'person turn' }).message).toMatchObject({ causeId: null, depth: 0 })
  })

  it('a ring of messages adds a hop at each party; the sixth message (depth 5) is held loop, and the person’s word in its sender does not let it go', () => {
    const w = world()
    const ring = [A, B, C, A, B, C]
    let last = w.send(ring[0] ?? A, { to: [ring[1] ?? B], text: 'round 0' }).message
    const depths = [last.depth]
    for (let i = 1; i < 6; i++) {
      w.startTurn(ring[i] ?? A, last.id)
      const r = w.send(ring[i] ?? A, { to: [ring[(i + 1) % 3] ?? A], text: `round ${i}` })
      depths.push(r.message.depth)
      if (i < 5) expect(r.held).toEqual([])
      else expect(r.held).toEqual([{ recipient: A, why: 'loop' }])
      last = r.message
    }
    expect(depths).toEqual([0, 1, 2, 3, 4, 5])
    expect(depths[5]).toBeGreaterThan(MAX_DEPTH)
    expect(w.rowOf(last.id, A).held).toBe('loop')

    // The person writes to C: what C sends from then on starts at depth 0, but the held row stays held
    const word = w.mail.send(PERSON, { to: [C], text: 'carry on' }).message
    w.startTurn(C, word.id)
    expect(w.send(C, { to: [B], text: 'after the word' }).message.depth).toBe(0)
    expect(w.rowOf(last.id, A).held).toBe('loop')

    // Only Resume lets it go, and then it is never held loop again
    expect(w.mail.resumeDepth(last.id)).toBe(1)
    expect(w.rowOf(last.id, A).held).toBe('released')
    expect(w.mail.resumeDepth(last.id)).toBe(0)
  })

  it('a held loop answer leaves its question open; Resume settles it', () => {
    const w = world()
    const q = w.send(A, { to: [B], text: 'what now?' }).message
    // B is deep into a chain when it answers
    const deep = w.mail.send(C, { to: [B], text: 'x' }).message
    w.db.prepare(`UPDATE mail SET depth = 4 WHERE id = ?`).run(deep.id)
    w.startTurn(B, deep.id)
    const answer = w.send(B, { replyTo: q.id, text: 'the answer', to: [A, C] })
    expect(answer.message.depth).toBe(5)
    expect(answer.held.map((h) => h.why)).toEqual(['loop', 'loop'])
    expect(w.rowOf(q.id, B)).toMatchObject({ settled: null, answerId: answer.message.id })
    const notice = w.records.pendingFor(A, w.clock.t + 10_000).find((p) => p.message.kind === 'notice')
    expect(notice?.message.body).toContain('it is the 5th hop in a row')
    expect(w.mail.resumeDepth(answer.message.id)).toBe(2)
    expect(w.rowOf(q.id, B)).toMatchObject({ settled: 'answered', answerId: answer.message.id })
  })

  it('a message caused by a task from its recipient is stored with clarifies and is no request; the owner’s answer to it is stored as a task with reply_to', () => {
    const w = world()
    const t = w.mail.task(ORC, W, { text: 'build it', origin: 'start_agent', delivered: true })
    w.startTurn(W, t.id)
    const q = w.send(W, { to: [ORC], text: 'which branch?' })
    expect(q.message).toMatchObject({ kind: 'message', needsReply: true, causeId: t.id, depth: 0, facts: { clarifies: t.id } })
    // It is not a request: the orchestrator's relation word, the ask count and the work pick all leave it out
    expect(w.records.requestsSince([W], ORC, NOW)).toBe(0)
    for (let i = 0; i < 3; i++) w.send(W, { to: [ORC], text: `clarify ${i}` })
    expect(w.records.requestsSince([W], ORC, NOW)).toBe(0)

    const answer = w.send(ORC, { replyTo: q.message.id, text: 'main' })
    expect(answer).toMatchObject({ asWork: true, quiet: false, answered: q.message.id })
    expect(answer.message).toMatchObject({ kind: 'task', replyTo: q.message.id, rootId: q.message.id, needsReply: false, origin: 'mail' })
    expect(w.records.recipients(answer.message.id).map((r) => r.recipient)).toEqual([W])
    expect(w.rowOf(q.message.id, ORC)).toMatchObject({ settled: 'answered', answerId: answer.message.id })
    expect(w.records.newestTask(ORC, W)?.id).toBe(answer.message.id)
  })

  it('an answer to a clarification by someone other than the task’s owner is a plain message, and the person’s answer is a task', () => {
    const w = world()
    const t = w.mail.task(PERSON, W, { text: 'build it', origin: 'person', delivered: true })
    w.startTurn(W, t.id)
    const q = w.send(W, { to: [PERSON], text: 'which branch?' }).message
    expect(q.facts.clarifies).toBe(t.id)
    // A third session may read it only if it was sent it: here B cannot answer
    expect(refusedFor(() => w.send(B, { replyTo: q.id, text: 'main', to: [W] }))).toBe('unknown_message')
    const answer = w.mail.send(PERSON, { to: [], replyTo: q.id, text: 'main' })
    expect(answer).toMatchObject({ asWork: true })
    expect(answer.message).toMatchObject({ kind: 'task', sender: PERSON })
    expect(w.rowOf(q.id, PERSON).settled).toBe('answered')
  })

  it('an answer to a task settles nothing: its report does', () => {
    const w = world()
    const t = w.mail.task(A, B, { text: 'work', origin: 'start_agent', delivered: true })
    w.send(B, { replyTo: t.id, text: 'on it' })
    expect(w.rowOf(t.id, B).settled).toBeNull()
  })

  it('covering: a row is covered by a watched row sent after it was delivered, caused by the starter of its delivery turn or by nothing; not by one sent before, nor by one a later turn’s other starter caused', () => {
    const w = world()
    const before = w.send(B, { to: [C], text: 'sent before' }).message
    const r = w.send(A, { to: [B], text: 'a question for b' }).message
    const other = w.send(C, { to: [B], text: 'something else' }).message
    w.clock.t += 100
    w.records.markDelivered(B, [r.id], w.clock.t, 1)
    w.startTurn(B, r.id)
    const delivered = w.rowOf(r.id, B)
    const owes = () => true
    w.clock.t += 10
    const inTurn = w.send(B, { to: [C], text: 'asked in the delivery turn' }).message
    expect(w.records.covering(delivered, owes)?.messageId).toBe(inTurn.id)
    expect(inTurn.causeId).toBe(r.id)
    expect(before.createdAt).toBeLessThan(delivered.deliveredAt ?? 0)

    // Settled, it covers nothing; a later turn that another message started covers nothing
    w.mail.done(C, inTurn.id)
    expect(w.records.covering(delivered, owes)).toBeNull()
    w.startTurn(B, other.id)
    const later = w.send(B, { to: [A], text: 'asked in a later turn' }).message
    expect(later.causeId).toBe(other.id)
    expect(w.records.covering(delivered, owes)).toBeNull()
    // A turn the session started itself has no cause, and covers
    w.startTurn(B, null)
    const own = w.send(B, { to: [C], text: 'asked on its own' }).message
    expect(w.records.covering(delivered, owes)?.messageId).toBe(own.id)
  })
})

describe('reports (§9.3)', () => {
  it('settles the task and every other open task of the pair delivered before the turn began; a task queued during the turn stays open', () => {
    const w = world()
    const t1 = w.mail.task(A, W, { text: 'one', origin: 'start_agent', delivered: true })
    w.clock.t += 5
    const t2 = w.mail.task(A, W, { text: 'two', origin: 'agent_session', delivered: true })
    const other = w.mail.task(B, W, { text: 'for someone else', origin: 'start_agent', delivered: true })
    w.clock.t += 5
    w.startTurn(W, t1.id)
    w.clock.t += 5
    const queued = w.mail.task(A, W, { text: 'queued during the turn', origin: 'agent_session', delivered: true })

    const out = w.mail.report(t1.id, { outcome: 'finished', body: '[Centralu] done', answer: 'all fine' })
    expect(out).toMatchObject({ duplicate: false, first: true })
    if (!('message' in out)) throw new Error('settled already')
    expect(out.message).toMatchObject({ sender: 'centralu', kind: 'report', replyTo: t1.id, rootId: t1.id, body: '[Centralu] done' })
    expect(out.message.facts).toEqual({ outcome: 'finished', about: { session: W }, answer: 'all fine', covers: [t2.id] })
    expect(w.records.recipients(out.message.id).map((r) => r.recipient)).toEqual([A])
    expect(w.rowOf(t1.id, W).settled).toBe('reported')
    expect(w.rowOf(t2.id, W).settled).toBe('reported')
    expect(w.rowOf(other.id, W).settled).toBeNull()
    expect(w.rowOf(queued.id, W).settled).toBeNull()
    // Reported once: a second report of the same task is told so
    expect(w.mail.report(t1.id, { outcome: 'finished', body: 'again' })).toEqual({ settledAlready: true })
  })

  it('paused and waiting leave the task open; the first pause wakes and later ones are quiet; the same pause again is a duplicate', () => {
    const w = world()
    const t = w.mail.task(A, W, { text: 'work', origin: 'start_agent', delivered: true })
    w.startTurn(W, t.id)
    const first = w.mail.report(t.id, { outcome: 'paused', body: 'paused', paused: 1 })
    expect(first).toMatchObject({ duplicate: false, first: true })
    if (!('message' in first)) throw new Error('settled already')
    expect(first.message.facts.quiet).toBeUndefined()
    expect(w.rowOf(t.id, W).settled).toBeNull()

    const again = w.mail.report(t.id, { outcome: 'paused', body: 'paused', paused: 1 })
    expect(again).toMatchObject({ duplicate: true })
    if (!('message' in again)) throw new Error('settled already')
    expect(again.message.id).toBe(first.message.id)

    const later = w.mail.report(t.id, { outcome: 'paused', body: 'paused', paused: 2 })
    expect(later).toMatchObject({ duplicate: false, first: false })
    if (!('message' in later)) throw new Error('settled already')
    expect(later.message.facts).toMatchObject({ quiet: true, paused: 2 })
    const waiting = w.mail.report(t.id, { outcome: 'waiting', body: 'waiting', waitingOn: 1 })
    expect('message' in waiting && waiting.message.facts).toMatchObject({ quiet: true, waitingOn: 1, outcome: 'waiting' })
    expect(w.rowOf(t.id, W).settled).toBeNull()
    expect(w.records.reportsOn(t.id)).toHaveLength(3)

    expect(w.mail.report(t.id, { outcome: 'failed', body: 'failed', error: 'rate_limit' })).toMatchObject({ first: true })
    expect(w.rowOf(t.id, W).settled).toBe('reported')
  })

  it('does not report what is not a task, and a task that was withdrawn or is gone is settled already', () => {
    const w = world()
    const m = w.send(A, { to: [B], text: 'x' }).message
    expect(refusedFor(() => w.mail.report(m.id, { outcome: 'finished', body: 'x' }))).toBe('unknown_message')
    const t = w.mail.task(A, W, { text: 'work', origin: 'start_agent', delivered: true })
    w.mail.done(A, t.id)
    expect(w.mail.report(t.id, { outcome: 'finished', body: 'x' })).toEqual({ settledAlready: true })
  })

  it('a request to the orchestrator that a turn carried is settled reported when that turn ends (§7.6)', () => {
    const w = world()
    const mine = w.send(B, { to: [ORC], text: 'please look' }).message
    const mine2 = w.send(B, { to: [ORC], text: 'and this' }).message
    const theirs = w.send(A, { to: [ORC], text: 'other asker' }).message
    const note = w.send(B, { to: [ORC], text: 'no answer needed', needsReply: false }).message
    const q = w.send(ORC, { to: [B], text: 'which?' }).message
    const answer = w.send(B, { replyTo: q.id, text: 'this one', needsReply: true }).message
    w.records.markDelivered(ORC, [mine.id, mine2.id, theirs.id, note.id, answer.id], w.clock.t, 3)
    expect(w.mail.requestTurnEnded(ORC, B, 3)).toBe(2)
    expect(w.rowOf(mine.id, ORC)).toMatchObject({ settled: 'reported' })
    expect(w.rowOf(mine2.id, ORC)).toMatchObject({ settled: 'reported' })
    expect(w.rowOf(theirs.id, ORC).settled).toBeNull()
    // An answer to the orchestrator's own question is no request, and an earlier turn's request is not this turn's
    expect(w.rowOf(answer.id, ORC).settled).toBeNull()
    expect(w.mail.requestTurnEnded(ORC, B, 4)).toBe(0)
  })
})

describe('reading (§8.4)', () => {
  it('read with no id returns unread oldest first within the limits and marks them read', () => {
    const w = world()
    const ids = Array.from({ length: 12 }, (_, i) => w.send([A, C, W, ORC][i % 4] ?? A, { to: [B], text: `message ${i}`, needsReply: false }).message.id)
    const first = w.mail.read(B)
    expect(first.items.map((i) => i.message.id)).toEqual(ids.slice(0, 10))
    expect(first).toMatchObject({ older: null, marked: 10 })
    expect(w.rowOf(ids[0] ?? '', B).readAt).not.toBeNull()
    expect(w.mail.read(B).items.map((i) => i.message.id)).toEqual(ids.slice(10))
    expect(w.mail.read(B)).toMatchObject({ items: [], marked: 0 })

    // About 20,000 characters, never half a message, and at least one
    const big = [1, 2, 3].map((i) => w.send(A, { to: [C], text: `${i}`.repeat(9_000), needsReply: false }).message.id)
    expect(w.mail.read(C).items.map((i) => i.message.id)).toEqual(big.slice(0, 2))
    expect(w.mail.read(C).items.map((i) => i.message.id)).toEqual(big.slice(2))
  })

  it('read does not list what is held from the reader, or a request that is not for its asker’s turn', () => {
    const w = world()
    w.send(X, { to: [C], text: 'held for trust' })
    const request = w.send(B, { to: [ORC], text: 'please look' }).message
    expect(w.mail.read(C).items).toEqual([])
    expect(w.mail.read(ORC).items).toEqual([])
    expect(w.rowOf(request.id, ORC).readAt).toBeNull()
    // In the asker's turn the words are shown
    w.startTurn(ORC, request.id, { asker: B })
    expect(w.mail.read(ORC).items.map((i) => i.message.body)).toEqual(['please look'])
  })

  it('read with an id returns the chain oldest first with phantoms; a held message reads as a phantom to its recipient', () => {
    const w = world()
    const m1 = w.send(A, { to: [B], text: 'one' }).message
    const m2 = w.send(B, { replyTo: m1.id, to: [A], text: 'two' }).message
    const m3 = w.send(A, { replyTo: m2.id, to: [C], text: 'three' }).message
    const view = w.mail.read(C, { id: m3.id })
    expect(view.items.map((i) => [i.message.id, i.phantom ?? null, i.message.body])).toEqual([
      [m1.id, 'not_sent', ''],
      [m2.id, 'not_sent', ''],
      [m3.id, null, 'three'],
    ])
    expect(view.items[0]?.relation).toBe('a session of another project')
    expect(view.marked).toBe(1)
    expect(w.rowOf(m3.id, C).readAt).not.toBeNull()
    // The sender reads all of its own; a party reads what it was sent
    expect(w.mail.read(A, { id: m3.id }).items.map((i) => i.phantom ?? null)).toEqual([null, null, null])
    expect(refusedFor(() => w.mail.read(C, { id: m1.id }))).toBe('unknown_message')

    // A held row reads as a phantom to its recipient, and whole to its sender
    const held = w.send(X, { to: [C], text: 'held for trust' }).message
    const feed = w.mail.feed(C, { limit: 10 })
    expect(feed.items.find((i) => i.message.id === held.id)).toMatchObject({ phantom: 'held', message: { body: '' } })
    expect(w.mail.feed(X, { limit: 10 }).items.find((i) => i.message.id === held.id)).toMatchObject({ message: { body: 'held for trust' } })
    expect(refusedFor(() => w.mail.read(C, { id: held.id }))).toBe('unknown_message')
  })

  it('read of a long chain returns the last nine ancestors and where to read on with before; a message that is no longer kept is one line', () => {
    const w = world()
    const ids = [w.send(A, { to: [B], text: 'm0', needsReply: false }).message.id]
    for (let i = 1; i < 12; i++) ids.push(w.send(i % 2 ? B : A, { replyTo: ids[i - 1] ?? '', to: [i % 2 ? A : B], text: `m${i}`, needsReply: false }).message.id)
    const view = w.mail.read(B, { id: ids[11] ?? '' })
    expect(view.items.map((i) => i.message.id)).toEqual(ids.slice(2))
    expect(view.older).toBe(ids[2])
    const older = w.mail.read(B, { before: view.older ?? '' })
    expect(older.items.map((i) => i.message.id)).toEqual(ids.slice(0, 2))
    expect(older.older).toBeNull()
    expect(older.marked).toBe(0)

    w.db.prepare(`DELETE FROM mail WHERE id = ?`).run(ids[0])
    const gone = w.mail.read(B, { before: ids[2] ?? '' })
    expect(gone.items.map((i) => [i.phantom ?? null, i.message.id])).toEqual([['gone', ids[0]], [null, ids[1]]])
  })

  it('inbox lists what waits for the reader’s answer, what is unread, what it asked and is not answered, and its mail held for the person', () => {
    const w = world()
    const asked = w.send(A, { to: [B], text: 'a question' }).message
    const note = w.send(C, { to: [B], text: 'fyi', needsReply: false }).message
    const mine = w.send(B, { to: [A], text: 'my question' }).message
    const heldOne = w.send(Y, { to: [C], text: 'held out' }).message
    const view = w.mail.inbox(B)
    expect(view.needReply.map((i) => i.message.id)).toEqual([asked.id])
    expect(view.unread.map((i) => i.message.id)).toEqual([note.id])
    expect(view.waiting.map((x) => x.message.id)).toEqual([mine.id])
    expect(w.mail.inbox(Y).held.map((x) => [x.message.id, x.why])).toEqual([[heldOne.id, 'policy']])
    expect(w.mail.inbox(C).held).toEqual([])
    // Answered, it no longer waits for the answer
    w.send(B, { replyTo: asked.id, text: 'the answer' })
    expect(w.mail.inbox(B).needReply).toEqual([])
  })
})

describe('tasks, notices and the feed', () => {
  it('a task is written delivered and read when the old path delivered its words, else due like any message; it carries its cause and origin', () => {
    const w = world()
    const m = w.send(C, { to: [A], text: 'the request' }).message
    w.startTurn(A, m.id)
    const told = w.mail.task(A, B, { text: 'work', origin: 'send_to_session', delivered: true })
    expect(told).toMatchObject({ kind: 'task', needsReply: false, origin: 'send_to_session', causeId: m.id, depth: 0, senderProject: 'p1' })
    expect(w.rowOf(told.id, B)).toMatchObject({ deliveredAt: w.clock.t, readAt: w.clock.t, dueAt: w.clock.t })
    expect(w.records.pendingFor(B, w.clock.t + 10_000)).toEqual([])
    const queued = w.mail.task(PERSON, B, { text: 'later', origin: 'person', delivered: false })
    expect(w.rowOf(queued.id, B)).toMatchObject({ deliveredAt: null, dueAt: w.clock.t })
    const plain = w.mail.task(A, C, { text: 'plain', origin: 'agent_session', delivered: false })
    expect(w.rowOf(plain.id, C)).toMatchObject({ deliveredAt: null, dueAt: w.clock.t + 2_000 })
    expect(refusedFor(() => w.mail.task(A, B, { text: 'x'.repeat(16_001), origin: 'start_agent', delivered: true }))).toBe('too_long')
    expect(refusedFor(() => w.mail.task('centralu', B, { text: 'x', origin: 'script', delivered: true }))).toBe('not_allowed')
  })

  it('a notice from Centralu is a notice with its facts, and the same key is the same notice', () => {
    const w = world()
    const first = w.mail.notice(A, { body: 'news', facts: { quiet: true, handedOver: true }, dedupeKey: 'k' })
    expect(first).toMatchObject({ sender: 'centralu', kind: 'notice', body: 'news', facts: { quiet: true, handedOver: true }, depth: 0, needsReply: false, origin: 'centralu' })
    expect(w.mail.notice(A, { body: 'again', facts: {}, dedupeKey: 'k' })).toBeUndefined()
    expect(w.mail.notice(B, { body: 'other recipient', facts: {}, dedupeKey: 'k2' })).toBeDefined()
  })

  it('the feed lists the messages to or from an address newest first, one page at a time, and says whether there are older', () => {
    const w = world()
    const ids = Array.from({ length: 5 }, (_, i) => w.send(i % 2 ? B : A, { to: [i % 2 ? A : B], text: `message ${i}`, needsReply: false }).message.id)
    const page = w.mail.feed(A, { limit: 3 })
    expect(page.items.map((i) => i.message.id)).toEqual([ids[4], ids[3], ids[2]])
    expect(page.older).toBe(true)
    const next = w.mail.feed(A, { limit: 3, before: ids[2] ?? '' })
    expect(next.items.map((i) => i.message.id)).toEqual([ids[1], ids[0]])
    expect(next.older).toBe(false)
    // Reading the feed marks nothing
    expect(w.rowOf(ids[0] ?? '', B).readAt).toBeNull()
  })
})
