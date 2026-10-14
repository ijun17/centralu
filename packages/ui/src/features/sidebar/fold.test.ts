import { describe, expect, it } from 'vitest'
import type { SessionState } from '@cc/protocol'
import { foldSummary, groupAttention } from './fold.js'

const of = (...states: SessionState[]) => states.map((state) => ({ state }))

describe('foldSummary (#205)', () => {
  it('counts waiting sessions and working sessions separately per state — never summed', () => {
    expect(
      foldSummary(of('working', 'waiting_approval', 'idle', 'waiting_input', 'waiting_approval', 'working', 'working')),
    ).toEqual([
      { state: 'waiting_approval', count: 2 },
      { state: 'waiting_input', count: 1 },
      { state: 'working', count: 3 },
    ])
  })

  it('is in urgency order — approval, error, waiting for input, working', () => {
    expect(foldSummary(of('working', 'waiting_input', 'error', 'waiting_approval')).map((x) => x.state)).toEqual([
      'waiting_approval',
      'error',
      'waiting_input',
      'working',
    ])
  })

  it('counts error too — it is a state the inbox counts as a waiting session', () => {
    expect(foldSummary(of('error', 'idle'))).toEqual([{ state: 'error', count: 1 }])
  })

  it('says nothing when only idle or rate-limited sessions are present', () => {
    expect(foldSummary(of('idle', 'limited', 'idle'))).toEqual([])
    expect(foldSummary([])).toEqual([])
  })
})

describe('groupAttention (#666)', () => {
  const row = (over: Partial<{ state: SessionState; pendingQuestions: unknown[]; lastSeq: number; lastReadSeq: number }> = {}) => ({
    state: 'idle' as SessionState, pendingQuestions: [], lastSeq: 3, lastReadSeq: 3, ...over,
  })

  it('says nothing for rows that are working, idle or read', () => {
    expect(groupAttention([])).toBeNull()
    expect(groupAttention([row(), row({ state: 'working' }), row({ state: 'waiting_input' }), row({ state: 'limited' })])).toBeNull()
  })

  it('is an alert for a hidden approval, error or open question, the strongest sign', () => {
    expect(groupAttention([row({ lastSeq: 9 }), row({ state: 'waiting_approval' })])).toBe('alert')
    expect(groupAttention([row({ state: 'error' })])).toBe('alert')
    expect(groupAttention([row({ pendingQuestions: [{}] })])).toBe('alert')
  })

  it('is the quieter unread when that is all there is', () => {
    expect(groupAttention([row(), row({ lastSeq: 4 })])).toBe('unread')
  })
})
