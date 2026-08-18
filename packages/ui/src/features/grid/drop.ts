/**
 * 그리드에서 칸을 끌 때의 표시.
 *
 * 사이드바는 세로 목록이라 위/아래였고 여기는 격자라 좌/우다. 방향만 다르고 이유는 같다:
 * **선이 없으면 손을 떼기 전까지 어디로 갈지 알 수 없다.**
 */

export type DropTarget = { id: string; before: boolean } | null

/**
 * 놓일 자리 표시 — 칸의 왼쪽이냐 오른쪽이냐.
 *
 * inset 그림자인 이유: border는 박스를 키워서 격자 전체를 민다. 끌고 다니는 동안
 * 칸들이 밀리면 손이 노리는 지점이 계속 움직인다 (사이드바에서 겪은 그 문제).
 *
 * 사이드바(2px)보다 굵다 — 칸이 크면 가는 선은 테두리와 구분되지 않는다.
 * 실제로 "위치 표시자가 안 보인다"는 지적이 있었다.
 */
export function dropEdge(over: DropTarget, id: string): string {
  if (over?.id !== id) return ''
  return over.before
    ? 'shadow-[inset_3px_0_0_0_var(--color-chalk)]'
    : 'shadow-[inset_-3px_0_0_0_var(--color-chalk)]'
}

/** 화면에 넘길 표시값 — 테스트와 접근성이 같은 것을 본다 */
export function dropSide(over: DropTarget, id: string): 'before' | 'after' | undefined {
  if (over?.id !== id) return undefined
  return over.before ? 'before' : 'after'
}
