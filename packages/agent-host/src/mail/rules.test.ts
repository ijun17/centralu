import { describe, expect, it } from 'vitest'
import type { MailRow } from '../dev-services/store/mailbox.js'
import { PERSON } from './address.js'
import {
  HOLD_OTHER_MS,
  HOLD_QUESTION_MS,
  HOLD_UNTRUSTED_OUT,
  HOST_MAIL_TURNS_PER_HOUR,
  HOST_SHARE,
  MAX_DEPTH,
  MAX_RECIPIENTS,
  PAIR_NEW_PER_HOUR,
  REFUSAL_TEXT,
  REMINDER,
  depthOf,
  flowsDownTo,
  pickWork,
  pickWorkThread,
  quietAnswer,
  refusalReason,
  refuse,
  wakesMessage,
} from './rules.js'

describe('a refusal (the protocol’s `refused`)', () => {
  it('is an error with the code `refused`, not worth a retry, and a reason the caller can act on', () => {
    const e = refuse('not_participant', 'S3 is not in that thread', { thread: 't1' })
    expect(e).toMatchObject({ message: 'S3 is not in that thread', code: 'refused', retryable: false, data: { reason: 'not_participant', thread: 't1' } })
    expect(refusalReason(e)).toBe('not_participant')
    // And it is told from an error that is not one, and from a reason this build does not have
    expect(refusalReason(new Error('boom'))).toBeUndefined()
    expect(refusalReason(null)).toBeUndefined()
    expect(refusalReason(Object.assign(new Error('x'), { data: { reason: 'something_new' } }))).toBeUndefined()
    expect(refusalReason(Object.assign(new Error('x'), { code: 'internal', data: { reason: 'not_participant' } }))).toBe('not_participant')
  })
})

describe('which thread a wake carries (§5)', () => {
  const NOW = 1_800_000_000_000
  const c = (threadId: string, over: Partial<{ decides: boolean; question: boolean; ago: number }> = {}) => ({
    threadId,
    decides: over.decides ?? false,
    question: over.question ?? false,
    dueAt: NOW - (over.ago ?? 1_000),
  })

  it('is none without a candidate, and the oldest when none is more pressing', () => {
    expect(pickWorkThread([], NOW)).toBeNull()
    expect(pickWorkThread([c('a', { ago: 5_000 }), c('b', { ago: 1_000 })], NOW)).toBe('a')
  })

  it('goes by class: the person’s words or urgent mail, then a question, then the rest', () => {
    expect(pickWorkThread([c('a'), c('b', { question: true }), c('c', { decides: true })], NOW)).toBe('c')
    expect(pickWorkThread([c('a'), c('b', { question: true })], NOW)).toBe('b')
  })

  it('moves a thread up to the first class once its mail has waited past its hold: 5 minutes for a question, 15 for the rest', () => {
    expect(pickWorkThread([c('old', { ago: HOLD_OTHER_MS + 1 }), c('new', { question: true })], NOW)).toBe('old')
    expect(pickWorkThread([c('old', { ago: HOLD_OTHER_MS - 1_000 }), c('new', { question: true })], NOW)).toBe('new')
    expect(pickWorkThread([c('old', { question: true, ago: HOLD_QUESTION_MS + 1 }), c('person', { decides: true })], NOW)).toBe('old')
    expect(pickWorkThread([c('old', { question: true, ago: HOLD_QUESTION_MS - 1_000 }), c('person', { decides: true })], NOW)).toBe('person')
  })

  it('judges a thread by its most pressing mail', () => {
    expect(pickWorkThread([c('a'), c('b', { ago: 10_000 }), c('a', { question: true })], NOW)).toBe('a')
  })
})

describe('mail without threads: the rules that need no store (docs/plans/mailbox.md §8.2, §10.10)', () => {
  const NOW = 1_800_000_000_000
  const A = 'session:h1/a'
  const B = 'session:h1/b'
  const C = 'session:h1/c'
  const row = (over: Partial<MailRow> = {}): MailRow => ({
    id: 'h1.m_1', sender: A, senderProject: null, kind: 'message', needsReply: false, replyTo: null, rootId: 'h1.m_1', causeId: null, depth: 0, urgent: false,
    body: 'x', facts: {}, dedupeKey: null, origin: 'mail', legacyThread: null, createdAt: NOW, ...over,
  })

  it('keeps every constant of the design in one place', () => {
    expect([PAIR_NEW_PER_HOUR, MAX_RECIPIENTS, HOLD_UNTRUSTED_OUT, MAX_DEPTH, HOST_MAIL_TURNS_PER_HOUR, HOST_SHARE]).toEqual([5, 10, true, 4, 120, 10])
    expect(REMINDER).toEqual({ graceMs: 120_000, personQuietMs: 600_000, againMs: 1_200_000, perRow: 2, gapMs: 1_200_000, perDay: 6, warmMs: 3_000_000, unansweredAfterMs: 7_200_000 })
  })

  describe('depthOf (D9)', () => {
    it('an answer back to the cause’s sender keeps its depth; a send on to another party adds one; with no cause it is 0', () => {
      const cause = row({ sender: A, depth: 2 })
      expect(depthOf(cause, [], [A])).toBe(2)
      expect(depthOf(cause, [], [B])).toBe(3)
      expect(depthOf(cause, [], [A, B])).toBe(3)
      expect(depthOf(null, [], [B])).toBe(0)
    })

    it('a task, a report, another notice and the person’s word give 0', () => {
      for (const over of [{ kind: 'task' as const }, { kind: 'report' as const }, { kind: 'notice' as const }, { sender: PERSON }]) {
        expect(depthOf(row({ ...over, depth: 3 }), [], [C]), JSON.stringify(over)).toBe(0)
      }
    })

    it('a reminder or a notice to a sender adds nothing: the highest depth of the messages it is about, back to their askers or receivers', () => {
      const asked = [row({ id: 'h1.m_2', sender: A, depth: 1 }), row({ id: 'h1.m_3', sender: C, depth: 3 })]
      const reminder = row({ kind: 'notice', sender: 'centralu', facts: { reminder: 1, of: ['h1.m_2', 'h1.m_3'] } })
      expect(depthOf(reminder, asked, [A, C])).toBe(3)
      expect(depthOf(reminder, asked, [A])).toBe(3)
      expect(depthOf(reminder, asked, [B])).toBe(4)
      const told = row({ kind: 'notice', sender: 'centralu', facts: { unanswered: [{ id: 'h1.m_2', recipient: B, why: 'waited' }] } })
      expect(depthOf(told, [row({ id: 'h1.m_2', sender: A, depth: 2 })], [B])).toBe(2)
      expect(depthOf(told, [row({ id: 'h1.m_2', sender: A, depth: 2 })], [C])).toBe(3)
    })
  })

  describe('quietAnswer (D3)', () => {
    const m = (over: Partial<Pick<MailRow, 'kind' | 'sender' | 'needsReply' | 'urgent'>> = {}) => ({ kind: 'message' as const, sender: A, needsReply: false, urgent: false, ...over })
    const none = { parent: null, owesTask: false, request: false }

    it('an answer that needs nothing to a message that needed nothing is quiet', () => {
      expect(quietAnswer(m(), { kind: 'message', needsReply: false }, none)).toBe(true)
    })

    it('is never quiet when the answer is a request to the orchestrator (§7.6)', () => {
      expect(quietAnswer(m(), { kind: 'message', needsReply: false }, { ...none, request: true })).toBe(false)
    })

    it('it wakes when it asks back, is urgent, answers a needsReply message or a task, is the person’s, the parent’s, or from a session that owes the receiver a task', () => {
      expect(quietAnswer(m({ needsReply: true }), { kind: 'message', needsReply: false }, none)).toBe(false)
      expect(quietAnswer(m({ urgent: true }), { kind: 'message', needsReply: false }, none)).toBe(false)
      expect(quietAnswer(m(), { kind: 'message', needsReply: true }, none)).toBe(false)
      expect(quietAnswer(m(), { kind: 'task', needsReply: false }, none)).toBe(false)
      expect(quietAnswer(m({ sender: PERSON }), { kind: 'message', needsReply: false }, none)).toBe(false)
      expect(quietAnswer(m(), { kind: 'message', needsReply: false }, { ...none, parent: A })).toBe(false)
      expect(quietAnswer(m(), { kind: 'message', needsReply: false }, { ...none, parent: B, owesTask: true })).toBe(false)
      expect(quietAnswer(m({ kind: 'task' }), { kind: 'message', needsReply: false }, none)).toBe(false)
    })
  })

  describe('pickWork (§8.2 step 3)', () => {
    const c = (key: string, over: Partial<{ decides: boolean; needsReply: boolean; ago: number }> = {}) => ({ key, decides: over.decides ?? false, needsReply: over.needsReply ?? false, dueAt: NOW - (over.ago ?? 1_000) })

    it('goes by class, and a group passed over for longer than its hold comes first', () => {
      expect(pickWork([], NOW)).toBeNull()
      expect(pickWork([c('a'), c('b', { needsReply: true }), c('c', { decides: true })], NOW)).toBe('c')
      expect(pickWork([c('a'), c('b', { needsReply: true })], NOW)).toBe('b')
      expect(pickWork([c('old', { ago: HOLD_OTHER_MS + 1 }), c('new', { needsReply: true })], NOW)).toBe('old')
      expect(pickWork([c('a'), c('b', { ago: 10_000 }), c('a', { needsReply: true })], NOW)).toBe('a')
    })
  })

  describe('flowsDownTo (§8.2 step 4)', () => {
    const f = (over: Partial<Parameters<typeof flowsDownTo>[0]> = {}) => flowsDownTo({ fromPerson: false, fromSession: true, kind: 'message', toOrchestrator: false, fromParent: false, ...over })

    it('is the person’s words, a task from a session, and a parent’s message; never a session’s words to the orchestrator', () => {
      expect(f({ fromPerson: true, fromSession: false })).toBe(true)
      expect(f({ fromPerson: true, fromSession: false, toOrchestrator: true })).toBe(true)
      expect(f({ kind: 'task' })).toBe(true)
      expect(f({ fromParent: true })).toBe(true)
      expect(f()).toBe(false)
      expect(f({ kind: 'task', toOrchestrator: true })).toBe(false)
      expect(f({ fromParent: true, toOrchestrator: true })).toBe(false)
      expect(f({ kind: 'report', fromSession: false })).toBe(false)
      expect(f({ kind: 'notice', fromParent: true })).toBe(false)
    })
  })

  it('wakesMessage: a message wakes unless it is marked quiet, whatever its kind and sender', () => {
    expect(wakesMessage(row())).toBe(true)
    expect(wakesMessage(row({ facts: { quiet: true } }))).toBe(false)
    expect(wakesMessage(row({ kind: 'notice', sender: 'centralu' }))).toBe(true)
    expect(wakesMessage(row({ kind: 'notice', sender: 'app:h1/p1/board' }))).toBe(true)
    expect(wakesMessage(row({ kind: 'report', sender: 'centralu', facts: { quiet: true } }))).toBe(false)
    expect(wakesMessage(row({ kind: 'notice', facts: { quiet: false } }))).toBe(true)
  })

  it('says its refusals in the words of the design (S9, S15), and has a reason for each', () => {
    expect(REFUSAL_TEXT.pair_rate('beta')).toBe('you started 5 conversations with beta in the last hour; answer one of its messages instead, or wait.')
    expect(REFUSAL_TEXT.repeat('beta')).toBe('you sent the same text to beta less than 10 minutes ago.')
    expect(REFUSAL_TEXT.ask_rate()).toBe("your project's sessions asked the orchestrator 5 times in the last hour; wait, or write to the person.")
    expect(REFUSAL_TEXT.recipients()).toBe('at most 10 recipients.')
    expect(REFUSAL_TEXT.own_message('h1.m_1')).toBe('h1.m_1 is your own message; say who it is for with to="…".')
    expect(REFUSAL_TEXT.untrusted_project('Pex', 'session c')).toBe(
      'your project Pex is not trusted, so work you give outside it (to session c) waits for the person to trust Pex. Nothing was started. Centralu shows the person how, and tells you when Pex is trusted; give it again then.',
    )
    for (const reason of ['gone', 'ambiguous', 'unknown', 'elsewhere', 'unknown_message', 'own_message', 'recipients', 'not_yours', 'pair_rate', 'repeat', 'ask_rate', 'orchestrator_asks', 'removed', 'untrusted_project']) {
      expect(refusalReason(refuse(reason as never, 'x')), reason).toBe(reason)
    }
  })
})
