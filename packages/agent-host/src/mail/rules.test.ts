import { describe, expect, it } from 'vitest'
import { refusalReason, refuse } from './rules.js'

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
