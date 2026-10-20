import { describe, expect, it } from 'vitest'
import { HOLD_OTHER_MS, HOLD_QUESTION_MS, pickWorkThread, refusalReason, refuse } from './rules.js'

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
