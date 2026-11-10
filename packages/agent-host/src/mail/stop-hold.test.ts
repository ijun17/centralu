/**
 * A stop notice that waits for an older report path (docs/plans/turn-owned-by-no-one.md §4.1, `StopNotices.sessionStopped`'s `held`), and what a
 * stop notice quotes of the stopped session's cut turn (`StopNotices.quotes`, security-boundaries.md): one stop of a pair held at a time, a hold
 * that never ends rescued after the wait, the words taken when the turn was cut, and nothing quoted unless each part of that rule holds.
 */
import { describe, expect, it } from 'vitest'
import { parseAddress } from './address.js'
import { MessageService } from './messages.js'
import { OLD_PATH_WAIT_MS } from './stop-notices.js'
import { A, B, C, HOST, W, world } from './messages.test-helpers.js'

/** A message service over the helpers' store with the stop notice's hooks under the test's control; `noInputs`: with no `turnInputs` */
function stops(o: { noInputs?: boolean } = {}) {
  const w = world()
  const words = { now: 'Rebased onto main; running the tests.' as string | null }
  const reads = { ok: true }
  /** What else entered each session's latest turn (`turnInputs`): the asker's own rows unless a test adds another's */
  const entered = new Map<string, (string | null)[]>()
  const mail = new MessageService(w.store.mailbox, w.reach, {
    hostId: HOST,
    now: () => w.clock.t,
    stoppedWords: () => words.now,
    mayRead: () => reads.ok,
    ...(o.noInputs ? {} : { turnInputs: (id: string) => entered.get(id) ?? [] }),
  })
  /** `sender` asks `to` a question that starts `to`'s next turn (`own`), or is given into a turn the CLI started */
  const askInTurn = (sender: string, to: string, own = true) => {
    w.clock.t += 10
    const q = mail.send(sender, { to: [to], text: `which branch? (${w.clock.t})`, needsReply: true }).message
    const turn = w.startTurn(to, own ? q.id : null)
    w.store.mailbox.markDelivered(to, [q.id], w.clock.t, turn.turnSeq)
    return { q, seq: turn.turnSeq }
  }
  const notices = (to: string) =>
    w.store.mailbox
      .pendingFor(to, w.clock.t + 60_000)
      .filter((p) => p.message.kind === 'notice' && p.message.facts.unanswered)
      .map((p) => ({ ids: (p.message.facts.unanswered as { id: string }[]).map((u) => u.id), body: p.message.body }))
  return { w, mail, words, reads, entered, askInTurn, notices }
}

const idOf = (address: string) => {
  const p = parseAddress(address)
  return p?.kind === 'session' ? p.sessionId : ''
}

describe('a stop notice held for an older report path', () => {
  it('a second stop while the first is held is told at once; the first is told when its path ends without telling, and only once', () => {
    const { w, mail, askInTurn, notices } = stops()
    const first = askInTurn(A, B)
    mail.stops.sessionStopped(B, 'limit', { turnSeq: first.seq, held: [A] })
    expect(notices(A)).toEqual([])
    w.clock.t += 1_000
    const second = askInTurn(A, B)
    mail.stops.sessionStopped(B, 'limit', { turnSeq: second.seq, held: [A] })
    expect(notices(A).map((n) => n.ids)).toEqual([[second.q.id]])
    mail.stops.oldPathEnded(B, A, false)
    expect(notices(A).map((n) => n.ids)).toEqual([[second.q.id], [first.q.id]])
    // A late second end of the same path adds nothing
    mail.stops.oldPathEnded(B, A, false)
    expect(notices(A)).toHaveLength(2)
  })

  it('a hold whose path never reports is listed by the sender’s next notice once the wait is over', () => {
    const { w, mail, askInTurn, notices } = stops()
    const held = askInTurn(A, B)
    mail.stops.sessionStopped(B, 'limit', { turnSeq: held.seq, held: [A] })
    w.clock.t += OLD_PATH_WAIT_MS + 60_000
    const other = askInTurn(A, W)
    mail.stops.sessionStopped(W, 'limit', { turnSeq: other.seq })
    expect(notices(A).map((n) => n.ids.sort())).toEqual([[held.q.id, other.q.id].sort()])
  })

  it('quotes the words the session had when its turn was cut, not what it says by the time the path ends', () => {
    const { mail, words, askInTurn, notices } = stops()
    const { seq } = askInTurn(A, B)
    words.now = 'Stopped while rebasing onto main.'
    mail.stops.sessionStopped(B, 'stopped', { turnSeq: seq, held: [A] })
    words.now = 'Something said later, in no turn of the asker.'
    mail.stops.oldPathEnded(B, A, false)
    const [notice] = notices(A)
    expect(notice?.body).toContain('> Stopped while rebasing onto main.')
    expect(notice?.body).not.toContain('Something said later')
  })
})

describe('what a stop notice quotes of the cut turn', () => {
  const QUOTED = '> Rebased onto main; running the tests.'

  it('a turn the sender’s own question started, with nothing else in it, to a sender that can read the session: quoted', () => {
    const { mail, askInTurn, notices } = stops()
    const { seq } = askInTurn(A, B)
    mail.stops.sessionStopped(B, 'stopped', { turnSeq: seq })
    expect(notices(A)[0]?.body).toContain(QUOTED)
  })

  it.each([
    ['a sender that cannot read the session', (s: ReturnType<typeof stops>) => void (s.reads.ok = false)],
    ['a turn the sender’s question did not start', null],
    ['another sender’s question given into the turn', (s: ReturnType<typeof stops>, seq: number) => {
      const q = s.mail.send(C, { to: [B], text: 'and mine?', needsReply: true }).message
      s.w.store.mailbox.markDelivered(B, [q.id], s.w.clock.t, seq)
    }],
    ['the person writing into the turn, or answering its question card', (s: ReturnType<typeof stops>) => void s.entered.set(idOf(B), [null])],
    ['another session’s message given into the turn outside the mailbox', (s: ReturnType<typeof stops>) => void s.entered.set(idOf(B), [idOf(A), idOf(C)])],
    ['a turn the session ran after the cut one', (s: ReturnType<typeof stops>) => void s.w.startTurn(B, null)],
  ] as const)('%s: nothing quoted, the stop still told', (_, change) => {
    const s = stops()
    const { q, seq } = s.askInTurn(A, B, change !== null)
    change?.(s, seq)
    s.w.clock.t += 10
    s.mail.stops.sessionStopped(B, 'stopped', { turnSeq: seq })
    const [notice] = s.notices(A)
    expect(notice?.ids).toEqual([q.id])
    expect(notice?.body).not.toContain(QUOTED)
  })

  /** The sender's question given into `B`'s turn `seq`, then the stop: the notice's body */
  const stopAfterAsking = (s: ReturnType<typeof stops>, seq: number) => {
    s.w.clock.t += 10
    const q = s.mail.send(A, { to: [B], text: `which branch? (${s.w.clock.t})`, needsReply: true }).message
    s.w.store.mailbox.markDelivered(B, [q.id], s.w.clock.t, seq)
    s.mail.stops.sessionStopped(B, 'stopped', { turnSeq: seq })
    return s.notices(A)[0]?.body
  }

  it('a task turn another sender’s task started, with nothing of that sender among the turn’s rows: nothing quoted to the sender that only asked in it', () => {
    const s = stops()
    const task = s.mail.send(C, { to: [B], text: 'migrate the table', needsReply: true }).message
    const { turnSeq } = s.w.startTurn(B, task.id, { by: 'caller' })
    expect(stopAfterAsking(s, turnSeq)).not.toContain(QUOTED)
  })

  it('a turn the CLI started by itself, which a task of the sender’s was attached to afterwards: nothing quoted', () => {
    const s = stops()
    const task = s.mail.send(A, { to: [B], text: 'migrate the table', needsReply: true }).message
    const { turnSeq } = s.w.startTurn(B, null)
    // `MailTurns.attach`: the CLI's turn goes on with the task's work, and the store names the task as its starter
    s.w.store.mailbox.setTurnMessage(idOf(B), turnSeq, task.id)
    expect(s.w.store.mailbox.turn(idOf(B), turnSeq)).toMatchObject({ startedBy: 'cli', starterId: task.id })
    expect(stopAfterAsking(s, turnSeq)).not.toContain(QUOTED)
  })

  it('with no record of what else entered the turn, nothing is quoted', () => {
    const s = stops({ noInputs: true })
    const { seq } = s.askInTurn(A, B)
    s.mail.stops.sessionStopped(B, 'stopped', { turnSeq: seq })
    expect(s.notices(A)[0]?.body).not.toContain(QUOTED)
  })
})
