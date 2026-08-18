/**
 * 그리드 배치.
 *
 * 자동 흐름 그리드라 **배치 = 순서 하나**다. 칸의 좌표를 따로 들고 있지 않으므로
 * 추가·제거·순서 바꾸기가 전부 "목록을 이렇게 만들어라" 한 가지로 표현된다 —
 * 사이드바 순서에서 내린 것과 같은 결정이다.
 *
 * 칸 수는 화면이 정한다. 사람이 고르게 하면 창 크기를 바꿀 때마다 다시 골라야 한다.
 */

/** 패널 하나가 쓸 수 있는 최소 폭. 이보다 좁으면 대화도 입력창도 못 읽는다 */
export const MIN_PANEL_W = 380

/**
 * 열 수가 정해졌을 때 필요한 줄 수.
 *
 * 그리드는 **스크롤하지 않는다.** 화면에 있는 것이 전부여야 한눈에 본다는 말이
 * 성립한다 — 아래에 더 있을지 모른다면 그건 목록이지 관제탑이 아니다.
 * 그래서 높이도 폭처럼 나눠 갖는다: 줄 수를 알아야 각 줄에 1fr을 줄 수 있다.
 */
export function rowsFor(count: number, cols: number): number {
  if (count <= 0) return 0
  return Math.ceil(count / Math.max(1, cols))
}

/**
 * 폭에 맞는 열 수.
 *
 * 사양서(§5.4)가 그리드를 보류한 첫 근거가 "패널당 600×400이면 아무것도 안 보인다"였다.
 * 그 지적은 여전히 유효하므로 **열 수를 폭에서 계산해** 패널이 그 아래로 내려가지 않게 한다.
 * 창이 좁으면 열이 줄고, 끝내 한 줄이 된다 — 그때는 사실상 포커스 뷰다.
 */
export function columnsFor(width: number, count: number): number {
  if (count <= 1) return 1
  const fits = Math.max(1, Math.floor(width / MIN_PANEL_W))
  // 항목보다 많은 열은 빈칸만 만든다. 셋을 넘기면 대화가 아니라 띠가 된다
  return Math.min(fits, count, 3)
}

/**
 * 그리드에 없는 세션을 넣는다. 이미 있으면 그대로 — 두 번 놓아도 두 개가 되지 않는다.
 */
export function addPanel(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? [...ids] : [...ids, id]
}

/** 화면에서만 뺀다. 세션 자체는 사이드바에 그대로 남는다 */
export function removePanel(ids: readonly string[], id: string): string[] {
  return ids.filter((x) => x !== id)
}

/**
 * 사라진 세션을 배치에서 걷어낸다.
 *
 * 세션을 지우거나 아카이브해도 배치에는 id가 남는다. 그대로 두면 그리드가 없는 것을
 * 그리려 하므로 **화면에 앉히기 전에 한 번 거른다.** 저장된 값을 고치지는 않는다 —
 * 잠깐 안 보이는 것(목록을 아직 못 읽음)과 사라진 것을 여기서 구분할 수 없다.
 */
export function visiblePanels(ids: readonly string[], known: ReadonlySet<string>): string[] {
  return ids.filter((id) => known.has(id))
}
