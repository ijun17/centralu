import type { NormalizedEvent, SessionState } from '@cc/protocol'

/**
 * 세션 상태 머신 (product-spec FR-12).
 * UI에서 if문으로 상태를 추론하지 않는다 — 전이는 전부 여기를 통과한다.
 */

/** 긴급도: 인박스 정렬·알림 정책의 근거. 낮을수록 급하다. */
export const URGENCY: Record<SessionState, number> = {
  waiting_approval: 0, // 에이전트가 막혀 있음 — 내가 안 누르면 아무 일도 안 일어남
  error: 1,
  waiting_input: 2, // 턴이 끝남 — 안 급함
  limited: 3,
  working: 9,
  idle: 9,
}

/** 사용자 개입을 기다리는 상태인가 (인박스 대상) */
export function isWaiting(state: SessionState): boolean {
  return state === 'waiting_approval' || state === 'waiting_input' || state === 'error'
}

/** FR-12 표의 합법 전이. 여기 없으면 불법. */
const ALLOWED: Record<SessionState, readonly SessionState[]> = {
  idle: ['working', 'error'],
  working: ['waiting_approval', 'waiting_input', 'limited', 'error', 'idle'],
  waiting_approval: ['working', 'error', 'idle'],
  waiting_input: ['working', 'error', 'idle'],
  limited: ['working', 'idle', 'error'],
  error: ['working', 'idle'],
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return from === to || (ALLOWED[from] ?? []).includes(to)
}

/**
 * 이벤트가 함의하는 다음 상태. null이면 상태 변화 없음.
 * state_change 이벤트는 어댑터가 명시적으로 보낸 것이므로 그대로 따른다.
 */
export function nextStateFor(event: NormalizedEvent): SessionState | null {
  switch (event.type) {
    case 'state_change':
      return event.state
    case 'message_delta':
    case 'tool_call':
    case 'tool_result':
      return 'working'
    case 'approval_request':
      return 'waiting_approval'
    case 'approval_resolved':
      return 'working'
    case 'turn_complete':
      return 'waiting_input'
    case 'limit_reached':
      return 'limited'
    case 'error':
      return 'error'
    default:
      return null
  }
}

export type TransitionResult = {
  state: SessionState
  /** 불법 전이라 무시됐는가 (dev에서 경고, prod에서 로그) */
  illegal: boolean
}

export function transition(from: SessionState, event: NormalizedEvent): TransitionResult {
  const to = nextStateFor(event)
  if (to === null) return { state: from, illegal: false }
  if (!canTransition(from, to)) return { state: from, illegal: true }
  return { state: to, illegal: false }
}
