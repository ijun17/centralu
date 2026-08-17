/**
 * 대화창이 바닥을 따라갈지 말지.
 *
 * DOM에서 떼어낸 이유가 있다. 이 판단이 `ChatStream` 안에서 rAF·ResizeObserver와
 * 뒤엉켜 있을 때 **경합 하나를 고치고도 회귀 테스트를 만들지 못했다** — 재현이
 * 타이밍에 달려 있어서, 기다림을 넣으면 고치기 전 코드에서도 같이 깨졌다.
 * 판단만 떼어내면 그 경합은 값 세 개로 표현된다.
 */

/** 이만큼 안쪽이면 '바닥에 있다'로 본다. 픽셀 단위로 딱 맞을 일은 없다 */
export const BOTTOM_SLACK = 80

/**
 * 이보다 많이 올라갔으면 사람이 올린 것으로 본다.
 * 0이 아닌 이유: 브라우저가 반올림으로 1~2px을 흔든다.
 */
export const MOVED_UP_SLACK = 4

export type ScrollPos = { scrollTop: number; scrollHeight: number; clientHeight: number }

export const distanceFromBottom = (p: ScrollPos): number => p.scrollHeight - p.scrollTop - p.clientHeight

export const isAtBottom = (p: ScrollPos): boolean => distanceFromBottom(p) < BOTTOM_SLACK

/**
 * 내용이 바뀐 지금 무엇을 할 것인가.
 *
 * - `follow`  바닥까지 내린다
 * - `release` 사람이 올렸다 — 따라가기를 놓는다
 * - `ignore`  이미 놓은 상태다
 */
export type FollowDecision = 'follow' | 'release' | 'ignore'

/**
 * **플래그만 믿으면 안 된다.**
 *
 * 스크롤 이벤트는 비동기다. 사람이 위로 올린 직후 가상 스크롤이 줄을 재면서 총 높이가
 * 바뀌면, 스크롤 이벤트가 처리되기 전에 "따라가기"가 먼저 돈다. 그때 플래그는 아직
 * true라서 사람을 도로 바닥으로 끌어내렸다.
 *
 * 위치를 함께 보면 그 경합이 사라진다: 내용이 늘어도 scrollTop은 그대로지만,
 * 사람이 올리면 줄어든다.
 */
export function decideFollow(p: { sticking: boolean; scrollTop: number; lastTop: number }): FollowDecision {
  if (!p.sticking) return 'ignore'
  if (p.scrollTop < p.lastTop - MOVED_UP_SLACK) return 'release'
  return 'follow'
}

/**
 * 미뤄둔 프레임에서 한 번 더 내릴 것인가.
 *
 * 새 줄은 다음 프레임에 측정되므로 그 전 높이로 내리면 몇 픽셀 모자란다.
 * 다만 그 사이에 사람이 올렸을 수 있으니 **그때 위치를 다시 재서** 판단한다 —
 * 예약할 때의 판단을 그대로 쓰면 사람을 이겨버린다.
 */
export const shouldFollowAgain = (p: ScrollPos): boolean => distanceFromBottom(p) <= BOTTOM_SLACK
