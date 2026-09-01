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
  /**
   * 세션 하나가 **보이지 않는 곳에서** 응답을 마쳤을 때.
   *
   * 원래는 "전부 끝났을 때 한 번"만 울렸다. 그런데 화면 밖 완료마다 카드가 남게 되면서
   * 어긋났다 — 카드는 매번 쌓이는데 소리는 마지막에만 나서, 자리를 비운 사이 둘이 끝나면
   * 카드 두 장이 조용히 쌓여 있었다. 카드와 소리는 같은 사건이므로 함께 간다.
   */
  done: boolean
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
  done: true,
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
  sessions: readonly { id: string; state: SessionState }[],
  prevSessions: readonly { id: string; state: SessionState }[],
  ctx: NotifyContext,
): NotifyRequest | null {
  const policy = ctx.policy ?? DEFAULT_NOTIFY_POLICY
  if (!policy.allDone) return null
  if (ctx.appFocused && !policy.whenFocused) return null

  /*
   * "끝났다"의 반대는 working만이 아니다.
   *
   * waiting_approval은 에이전트가 막혀 있는 것이지 손이 빈 게 아니고,
   * limited는 해제되면 스스로 재개한다 — 이 상태에서 "All done"이 울리면
   * 승인 카드가 쌓여 있는데 사람은 다 끝난 줄 알고 자리를 뜬다.
   */
  const isBusy = (s: { state: SessionState }) =>
    s.state === 'working' || s.state === 'waiting_approval' || s.state === 'limited'

  const active = sessions.length

  /*
   * **개수가 아니라 신원으로 판정한다.**
   *
   * busy(prev)>0 && busy(now)===0 식의 개수 비교는, 마지막 working 세션을
   * **아카이브·삭제한 순간**에도 성립한다 — 일이 끝난 게 아니라 치운 것인데
   * "All done"이 울린다. 바쁘던 바로 그 세션들이 **여전히 목록에 있고,
   * 치워지지 않았고, 실제로 손을 뗐을 때**만 끝난 것이다.
   */
  const prevBusy = prevSessions.filter(isBusy).map((s) => s.id)
  if (prevBusy.length === 0 || active === 0) return null
  const now = new Map(sessions.map((s) => [s.id, s]))
  for (const id of prevBusy) {
    const s = now.get(id)
    if (!s || isBusy(s)) return null
  }
  // 그 사이 새로 바빠진 세션이 있어도 아직 끝난 게 아니다
  if (sessions.some(isBusy)) return null

  const waiting = sessions.filter((s) => isWaiting(s.state)).length
  return {
    kind: 'all_done',
    title: 'All done',
    body: waiting > 0 ? `${waiting} sessions are waiting for input` : 'Every session has finished',
  }
}

/** 독 뱃지 숫자 — 승인과 오류만 센다 (응답 대기는 급하지 않으므로 뱃지를 태우지 않는다) */
export function badgeCount(counts: { approval: number; error: number }): number {
  return counts.approval + counts.error
}
