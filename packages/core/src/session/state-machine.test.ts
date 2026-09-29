/**
 * Gate G2: the FR-12 table is copied out as test cases, so a machine checks that the spec and the
 * implementation agree.
 * (One of the items where plan v2 replaced human review with automatic verification)
 */
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent, SessionState } from '@cc/protocol'
import { URGENCY, canTransition, isWaiting, transition } from './state-machine.js'

const ev = (e: Partial<NormalizedEvent> & { type: NormalizedEvent['type'] }) =>
  ({ sessionId: 's1', ...e }) as NormalizedEvent

describe('matches the FR-12 spec', () => {
  it('exactly the six states exist', () => {
    const spec: SessionState[] = ['idle', 'working', 'waiting_approval', 'waiting_input', 'limited', 'error']
    expect(Object.keys(URGENCY).sort()).toEqual([...spec].sort())
  })

  it('waiting_approval is more urgent than waiting_input (the reason the badges are split)', () => {
    expect(URGENCY.waiting_approval).toBeLessThan(URGENCY.waiting_input)
  })

  it('the inbox holds three kinds: approval, error and awaiting response', () => {
    const waiting = (['idle', 'working', 'waiting_approval', 'waiting_input', 'limited', 'error'] as SessionState[])
      .filter(isWaiting)
    expect(waiting.sort()).toEqual(['error', 'waiting_approval', 'waiting_input'])
  })
})

describe('event → transition', () => {
  it.each([
    ['message_delta', 'idle', 'working'],
    ['tool_call', 'idle', 'working'],
    ['approval_request', 'working', 'waiting_approval'],
    ['approval_resolved', 'waiting_approval', 'working'],
    ['turn_complete', 'working', 'waiting_input'],
    ['limit_reached', 'working', 'limited'],
    ['error', 'working', 'error'],
  ] as const)('%s: %s → %s', (type, from, to) => {
    const r = transition(from, ev({ type } as never))
    expect(r.state).toBe(to)
    expect(r.illegal).toBe(false)
  })

  it('state_change follows what the adapter says, as is', () => {
    expect(transition('working', ev({ type: 'state_change', state: 'idle' } as never)).state).toBe('idle')
  })

  it('usage/context/title/files_touched do not change the state', () => {
    for (const type of ['usage_update', 'context_update', 'session_title', 'files_touched'] as const) {
      expect(transition('waiting_input', ev({ type } as never)).state).toBe('waiting_input')
    }
  })
})

describe('blocking illegal transitions', () => {
  it('an inferred transition cannot go straight from idle to waiting_approval', () => {
    expect(canTransition('idle', 'waiting_approval')).toBe(false)
    const r = transition('idle', ev({ type: 'state_change', state: 'waiting_approval' } as never))
    expect(r.illegal).toBe(true)
    expect(r.state).toBe('idle') // The state stays as it was
  })

  it('approval and question requests are facts, so the table cannot swallow them (even in idle right after a resume)', () => {
    // Ignoring a request the host actually sent leaves the agent blocked forever — the table filters only
    // inferences
    for (const type of ['approval_request', 'question_request'] as const) {
      const r = transition('idle', ev({ type } as never))
      expect(r.illegal).toBe(false)
      expect(r.state).toBe('waiting_approval')
    }
  })

  it('turn_complete in idle is illegal (there was no turn)', () => {
    expect(transition('idle', ev({ type: 'turn_complete' })).illegal).toBe(true)
  })

  it('when an interrupt ends the turn while approval is waiting, it gets out to waiting_input (no dead-end states)', () => {
    expect(canTransition('waiting_approval', 'waiting_input')).toBe(true)
    const r = transition('waiting_approval', ev({ type: 'turn_complete' }))
    expect(r.illegal).toBe(false)
    expect(r.state).toBe('waiting_input')
  })

  it('a transition to the same state is always legal (idempotent)', () => {
    for (const s of Object.keys(URGENCY) as SessionState[]) expect(canTransition(s, s)).toBe(true)
  })

  it('working can go to every waiting state', () => {
    for (const s of ['waiting_approval', 'waiting_input', 'limited', 'error'] as SessionState[]) {
      expect(canTransition('working', s)).toBe(true)
    }
  })
})
