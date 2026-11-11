import { describe, expect, it } from 'vitest'
import type { MailRow } from '../dev-services/store/mailbox.js'
import { PERSON } from './address.js'
import {
  HOLD_OTHER_MS,
  HOLD_UNTRUSTED_OUT,
  MAX_RECIPIENTS,
  REFUSAL_TEXT,
  REMINDER,
  WARNING_TEXT,
  WARN_HOST_TURNS_PER_HOUR,
  WARN_PAIR_TURNS_PER_HOUR,
  flowsDownTo,
  pickWork,
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

describe('mail without threads: the rules that need no store (docs/plans/mailbox.md §8.2, §10.10)', () => {
  const NOW = 1_800_000_000_000
  const A = 'session:h1/a'
  const B = 'session:h1/b'
  const row = (over: Partial<MailRow> = {}): MailRow => ({
    id: 'h1.m_1', sender: A, senderProject: null, kind: 'message', needsReply: false, replyTo: null, rootId: 'h1.m_1', causeId: null, depth: 0, urgent: false,
    body: 'x', facts: {}, choices: null, dedupeKey: null, origin: 'mail', legacyThread: null, createdAt: NOW, ...over,
  })

  it('keeps every constant of the design in one place', () => {
    expect([MAX_RECIPIENTS, HOLD_UNTRUSTED_OUT, WARN_PAIR_TURNS_PER_HOUR, WARN_HOST_TURNS_PER_HOUR]).toEqual([10, true, 20, 120])
    expect(REMINDER).toEqual({ graceMs: 120_000, personQuietMs: 600_000, againMs: 1_200_000, perRow: 2, gapMs: 1_200_000, perDay: 6, warmMs: 3_000_000, unansweredAfterMs: 7_200_000 })
  })

  describe('quietAnswer (D3)', () => {
    const m = (over: Partial<Pick<MailRow, 'kind' | 'sender' | 'needsReply' | 'urgent'>> = {}) => ({ kind: 'message' as const, sender: A, needsReply: false, urgent: false, ...over })
    const none = { parent: null, owesTask: false, request: false }

    it('an answer that needs nothing to a message that needed nothing is quiet', () => {
      expect(quietAnswer(m(), { kind: 'message', needsReply: false }, none)).toBe(true)
    })

    it('is never quiet when the answer is a request to the Assistant (§7.6)', () => {
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
    const f = (over: Partial<Parameters<typeof flowsDownTo>[0]> = {}) => flowsDownTo({ fromPerson: false, fromSession: true, kind: 'message', toAssistant: false, fromParent: false, ...over })

    it('is the person’s words, a task from a session, and a parent’s message; never a session’s words to the Assistant', () => {
      expect(f({ fromPerson: true, fromSession: false })).toBe(true)
      expect(f({ fromPerson: true, fromSession: false, toAssistant: true })).toBe(true)
      expect(f({ kind: 'task' })).toBe(true)
      expect(f({ fromParent: true })).toBe(true)
      expect(f()).toBe(false)
      expect(f({ kind: 'task', toAssistant: true })).toBe(false)
      expect(f({ fromParent: true, toAssistant: true })).toBe(false)
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

  it('warns the person in plain words, saying that nothing was stopped (#2014)', () => {
    expect(WARNING_TEXT.pair('alpha', 'beta', 21)).toBe(
      'alpha and beta started 21 turns of each other by mail in the last hour, with no word from you. Their mail still goes: write to either, or stop one, if they are going round in circles.',
    )
    expect(WARNING_TEXT.host(121)).toBe('Mail between sessions started 121 turns on this computer in the last hour. It still goes: look at the busy sessions if that is more than you expect.')
  })

  it('says its refusals in the words of the design (S9, S15), and has a reason for each', () => {
    expect(REFUSAL_TEXT.repeat('beta')).toBe('you sent the same text to beta less than 10 minutes ago.')
    expect(REFUSAL_TEXT.ask_rate()).toBe("your project's sessions asked the Assistant 5 times in the last hour; wait, or write to the person.")
    expect(REFUSAL_TEXT.recipients()).toBe('at most 10 recipients.')
    expect(REFUSAL_TEXT.own_message('h1.m_1')).toBe('h1.m_1 is your own message; say who it is for with to="…".')
    expect(REFUSAL_TEXT.untrusted_project('Pex', 'session c')).toBe(
      'your project Pex is not trusted, so work you give outside it (to session c) waits for the person to trust Pex. Nothing was started. Centralu shows the person how, and tells you when Pex is trusted; give it again then.',
    )
    for (const reason of ['gone', 'ambiguous', 'unknown', 'elsewhere', 'unknown_message', 'own_message', 'recipients', 'not_yours', 'repeat', 'ask_rate', 'assistant_asks', 'removed', 'untrusted_project']) {
      expect(refusalReason(refuse(reason as never, 'x')), reason).toBe(reason)
    }
  })
})
