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

/** 가상 스크롤이 재어 둔 줄 하나 (tanstack의 measurementsCache 항목 중 우리가 쓰는 부분) */
export type Measured = { index: number; start: number; end: number }

/**
 * 지금 화면 맨 위에 걸친 줄과, 그 줄 안에서 얼마나 들어갔는지 (#61).
 *
 * **픽셀이 아니라 줄로 기억하기 위한 변환이다.** 생 scrollTop은 아직 재지 않은
 * 가상 스크롤에서는 다음에 올 때 다른 곳을 가리킨다 — 위쪽 줄들이 64px 추정치에서
 * 실제 높이로 바뀌면 같은 숫자가 다른 자리가 되기 때문이다. seq는 측정과 무관하므로
 * 재고 난 뒤에도 같은 줄을 가리키고, 남은 몇 픽셀만 도착해서 다시 맞추면 된다.
 *
 * 이진 탐색인 이유: 스크롤 이벤트마다 불린다. 대화가 길어질수록 선형 훑기는
 * 스크롤을 무겁게 만드는데, 배터리 문제로 한 번 데인 적이 있다.
 *
 * 걸친 줄이 없으면(빈 대화, 아직 아무것도 안 잼) null — 기억할 자리가 없다는 뜻이다.
 */
export function anchorAt(
  scrollTop: number,
  measurements: readonly Measured[],
  items: readonly { seq: number }[],
): { seq: number; offset: number } | null {
  let lo = 0
  let hi = measurements.length - 1
  let hit: Measured | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const m = measurements[mid]!
    // 기준은 end다: 끝이 scrollTop을 넘어서는 첫 줄이 화면 맨 위에 걸친 줄이다
    if (m.end > scrollTop) {
      hit = m
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  const seq = hit ? items[hit.index]?.seq : undefined
  return seq === undefined ? null : { seq, offset: scrollTop - hit!.start }
}
