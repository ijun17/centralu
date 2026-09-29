import type { SessionState } from '@cc/protocol'

/**
 * 접힌 프로젝트의 이름 줄이 대신 말하는 것 (#205).
 *
 * 사이드바는 "누가 나를 기다리는가"를 한눈에 보는 자리다 (FR-1). 접기가 세션 줄을 가리면서 그 신호까지
 * 가리면, 접기는 정리 기능이 아니라 신호를 숨기는 기능이 된다. 그래서 접힌 줄은 가려진 줄들의 상태를
 * **센 수로** 남긴다.
 *
 * 세는 상태는 넷, 순서는 인박스의 긴급도 그대로다 (승인 → 오류 → 응답 대기, 그다음 도는 중).
 * 오류는 요청에 없던 것이지만 뺄 수 없다: 인박스와 ⌘⇧A가 기다리는 세션으로 세는 상태이고(core
 * `isWaiting`), 접힌 프로젝트에서 멈춘 세션이 아무 표시도 없이 숨으면 접기가 바로 그 일을 한 것이다.
 * 쉬는 중·한도는 세지 않는다 — 사람을 부르지도, 움직이지도 않는 줄이다.
 *
 * 절대 합산하지 않는다 (FR-12의 계기판과 같은 규칙): "3"만 보이면 승인 셋인지 도는 것 셋인지 모른다.
 */
export const FOLD_SUMMARY_STATES = ['waiting_approval', 'error', 'waiting_input', 'working'] as const

export type FoldSummaryState = (typeof FOLD_SUMMARY_STATES)[number]

export function foldSummary(
  sessions: readonly { state: SessionState }[],
): { state: FoldSummaryState; count: number }[] {
  const counts = new Map<SessionState, number>()
  for (const s of sessions) counts.set(s.state, (counts.get(s.state) ?? 0) + 1)
  return FOLD_SUMMARY_STATES.flatMap((state) => {
    const count = counts.get(state) ?? 0
    return count > 0 ? [{ state, count }] : []
  })
}
