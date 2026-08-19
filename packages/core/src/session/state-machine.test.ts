/**
 * G2 게이트: FR-12 표를 테스트 케이스로 옮겨 적어 스펙-구현 일치를 기계 검증한다.
 * (플랜 v2에서 사람 검토를 자동 검증으로 대체한 항목)
 */
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent, SessionState } from '@cc/protocol'
import { URGENCY, canTransition, isWaiting, transition } from './state-machine.js'

const ev = (e: Partial<NormalizedEvent> & { type: NormalizedEvent['type'] }) =>
  ({ sessionId: 's1', ...e }) as NormalizedEvent

describe('FR-12 스펙 대응', () => {
  it('상태 6종이 정확히 존재한다', () => {
    const spec: SessionState[] = ['idle', 'working', 'waiting_approval', 'waiting_input', 'limited', 'error']
    expect(Object.keys(URGENCY).sort()).toEqual([...spec].sort())
  })

  it('waiting_approval이 waiting_input보다 급하다 (뱃지 분리의 근거)', () => {
    expect(URGENCY.waiting_approval).toBeLessThan(URGENCY.waiting_input)
  })

  it('인박스 대상은 승인·오류·응답대기 3종', () => {
    const waiting = (['idle', 'working', 'waiting_approval', 'waiting_input', 'limited', 'error'] as SessionState[])
      .filter(isWaiting)
    expect(waiting.sort()).toEqual(['error', 'waiting_approval', 'waiting_input'])
  })
})

describe('이벤트 → 전이', () => {
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

  it('state_change는 어댑터 지시를 그대로 따른다', () => {
    expect(transition('working', ev({ type: 'state_change', state: 'idle' } as never)).state).toBe('idle')
  })

  it('usage/context/title/files_touched는 상태를 바꾸지 않는다', () => {
    for (const type of ['usage_update', 'context_update', 'session_title', 'files_touched'] as const) {
      expect(transition('waiting_input', ev({ type } as never)).state).toBe('waiting_input')
    }
  })
})

describe('불법 전이 차단', () => {
  it('추론 전이로는 idle에서 곧장 waiting_approval로 갈 수 없다', () => {
    expect(canTransition('idle', 'waiting_approval')).toBe(false)
    const r = transition('idle', ev({ type: 'state_change', state: 'waiting_approval' } as never))
    expect(r.illegal).toBe(true)
    expect(r.state).toBe('idle') // 상태 유지
  })

  it('승인·질문 요청은 사실이므로 표가 삼키지 못한다 (resume 직후 idle에서도)', () => {
    // 호스트가 실제로 보낸 요청을 무시하면 에이전트가 영원히 막힌다 — 표는 추론만 거른다
    for (const type of ['approval_request', 'question_request'] as const) {
      const r = transition('idle', ev({ type } as never))
      expect(r.illegal).toBe(false)
      expect(r.state).toBe('waiting_approval')
    }
  })

  it('idle에서 turn_complete는 불법 (턴이 없었으므로)', () => {
    expect(transition('idle', ev({ type: 'turn_complete' })).illegal).toBe(true)
  })

  it('승인 대기 중 인터럽트로 턴이 끝나면 waiting_input으로 빠져나온다 (막다른 상태 금지)', () => {
    expect(canTransition('waiting_approval', 'waiting_input')).toBe(true)
    const r = transition('waiting_approval', ev({ type: 'turn_complete' }))
    expect(r.illegal).toBe(false)
    expect(r.state).toBe('waiting_input')
  })

  it('같은 상태로의 전이는 항상 합법 (멱등)', () => {
    for (const s of Object.keys(URGENCY) as SessionState[]) expect(canTransition(s, s)).toBe(true)
  })

  it('working에서는 모든 대기 상태로 갈 수 있다', () => {
    for (const s of ['waiting_approval', 'waiting_input', 'limited', 'error'] as SessionState[]) {
      expect(canTransition('working', s)).toBe(true)
    }
  })
})
