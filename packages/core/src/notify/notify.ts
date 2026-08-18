import type { SessionState } from '@cc/protocol'
import { isWaiting } from '../session/state-machine.js'

/**
 * 알림 정책 (FR-12 표시 계층 ④).
 * 원칙: **알림은 사람의 주의를 강제로 가져오는 유일한 수단**이므로 가장 아껴 쓴다.
 * 승인·오류만 즉시 알리고, 응답 대기는 뱃지로만. 대신 "전부 끝났을 때" 한 번 알린다.
 */

export type NotifyPolicy = {
  /** 승인 대기 발생 시 즉시 알림 */
  approval: boolean
  /** 오류 발생 시 즉시 알림 */
  error: boolean
  /** 모든 세션이 일을 마쳤을 때 1회 */
  allDone: boolean
  /** 앱이 포그라운드일 때도 알릴지 (기본: 안 알림 — 눈앞에 있는데 알림은 소음) */
  whenFocused: boolean
  /**
   * 소리를 낼지.
   *
   * macOS 배너 경로가 죽어 있는 것을 실측한 뒤로 **소리가 자리 비움의 주력**이 됐다.
   * 옆방에 가 있어도 닿는 유일한 신호라서 기본값이 켜짐이다.
   */
  sound: boolean
}

export const DEFAULT_NOTIFY_POLICY: NotifyPolicy = {
  approval: true,
  error: true,
  allDone: true,
  whenFocused: false,
  sound: true,
}

export type NotifyRequest = { kind: 'approval' | 'error' | 'all_done'; sessionId?: string; title: string; body: string }

export type NotifyContext = {
  appFocused: boolean
  policy?: NotifyPolicy
}

/** 세션 상태 전이 → 알림 (없으면 null) */
export function notificationFor(
  session: { id: string; name: string; state: SessionState },
  prevState: SessionState,
  ctx: NotifyContext,
): NotifyRequest | null {
  const policy = ctx.policy ?? DEFAULT_NOTIFY_POLICY
  if (ctx.appFocused && !policy.whenFocused) return null
  if (session.state === prevState) return null

  if (session.state === 'waiting_approval' && policy.approval) {
    return { kind: 'approval', sessionId: session.id, title: 'Awaiting approval', body: `${session.name} — agent is blocked, waiting` }
  }
  if (session.state === 'error' && policy.error) {
    return { kind: 'error', sessionId: session.id, title: 'Error', body: `${session.name} — session stopped` }
  }
  return null
}

/**
 * "전부 완료" 판정 (product-spec에서 결정한 정책).
 * 개별 세션이 끝날 때마다가 아니라, 일이 다 끝났을 때 한 번만 알린다 —
 * 자리를 뜬 사람에게 필요한 신호는 그것이다.
 */
export function allDoneNotification(
  sessions: readonly { state: SessionState; archived: boolean }[],
  prevSessions: readonly { state: SessionState; archived: boolean }[],
  ctx: NotifyContext,
): NotifyRequest | null {
  const policy = ctx.policy ?? DEFAULT_NOTIFY_POLICY
  if (!policy.allDone) return null
  if (ctx.appFocused && !policy.whenFocused) return null

  const busy = (list: readonly { state: SessionState; archived: boolean }[]) =>
    list.filter((s) => !s.archived && s.state === 'working').length

  const active = (list: readonly { state: SessionState; archived: boolean }[]) =>
    list.filter((s) => !s.archived).length

  // 방금 마지막 작업이 끝났고, 알릴 세션이 실제로 있었을 때만
  if (busy(prevSessions) > 0 && busy(sessions) === 0 && active(sessions) > 0) {
    const waiting = sessions.filter((s) => !s.archived && isWaiting(s.state)).length
    return {
      kind: 'all_done',
      title: 'All done',
      body: waiting > 0 ? `${waiting} sessions are waiting for input` : 'Every session has finished',
    }
  }
  return null
}

/** 독 뱃지 숫자 — 승인과 오류만 센다 (응답 대기는 급하지 않으므로 뱃지를 태우지 않는다) */
export function badgeCount(counts: { approval: number; error: number }): number {
  return counts.approval + counts.error
}
