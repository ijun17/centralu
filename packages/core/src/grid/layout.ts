/**
 * 그리드 배치.
 *
 * 자동 흐름 그리드라 **배치 = 순서 하나**다. 칸의 좌표를 따로 들고 있지 않으므로
 * 추가·제거·순서 바꾸기가 전부 "목록을 이렇게 만들어라" 한 가지로 표현된다 —
 * 사이드바 순서에서 내린 것과 같은 결정이다.
 *
 * 칸 수는 화면이 정한다. 사람이 고르게 하면 창 크기를 바꿀 때마다 다시 골라야 한다.
 */

/**
 * The narrowest a panel may get — below this neither the conversation nor the input box
 * can be read. With the three-column cap gone (#51) this is the **only** hard limit on
 * how far the width gets divided, so it is the whole design rather than a detail.
 */
export const MIN_PANEL_W = 380

/**
 * The tallest a panel may get before the grid splits another row off.
 *
 * Four times the minimum width — this is not the mirror of MIN_PANEL_W. A conversation
 * flows downwards: a taller panel shows more of it, and the input box is pinned to the
 * bottom either way. Unlike narrow, **tall is not bad in itself**, so this is a guard
 * against the pathological rather than a preference.
 *
 * Which is why it does nothing on almost every screen. Measured, as the height a panel
 * would have in a single row: 13" 1440×900 → 848px · 16" 1728×1117 → 1065px ·
 * 24" 1920×1080 → 1028px · 27" 2560×1440 → 1388px — all of them under. It fires on
 * 5K 5120×2880 → 2828px and on a portrait 1440×2560 → 2508px, and nowhere else we
 * measured. **Never firing on an ordinary screen is the intent**, not evidence that the
 * rule is dead: what it stops only exists on the two screens where it does fire.
 */
export const MAX_PANEL_H = MIN_PANEL_W * 4

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
 * How many columns the screen gets divided into.
 *
 * §5.4's first reason for holding the grid back was "600×400 per panel and you can see
 * nothing". That reason still stands, so the column count is **computed from the screen**
 * and a panel is never divided below MIN_PANEL_W. Narrow the window and columns fall away
 * until one is left — at which point this is effectively the focus view. None of that has
 * changed.
 *
 * What changed is what happens above that floor (#51). This used to stop at three columns
 * and otherwise take the widest count that fit, so four panels came out 3 + 1: two empty
 * cells, and every panel half again narrower than a 2×2 would have made it. The cap stated
 * §5.4's constraint in the wrong unit. What makes a panel useless is its width in pixels,
 * which MIN_PANEL_W already says; "no more than three" was a proxy for that, and a proxy
 * that is wrong on a 2560px screen, where four columns are each wider than three columns
 * are at 1280px. So the arrangement is now chosen rather than capped:
 *
 *   of the counts that fit, take the one leaving the fewest cells empty,
 *   and where two of them tie, the one that makes panels wider.
 *
 * Empty cells are counted rather than tolerated because a cell nobody is using is width
 * taken away from every panel that is being used — the two are the same mistake, not a
 * trade.
 *
 * Two things bound that search, and without them it has no answer. It may not come out
 * taller than it is wide (`rows <= cols`), which is the same thing as saying no panel is
 * proportionally wider than the window it sits in — a grid taller than it is wide divides
 * the screen's *shorter* side more often than its longer one, and the panels end up narrow
 * and short at once. Without it the rule would collapse to a single column every time: one
 * column always leaves nothing empty and is always the widest. And it may not come out so
 * short that a panel exceeds MAX_PANEL_H, which is the only condition allowed to push rows
 * past that limit — on the screens where it fires, tall is what there is too much of.
 */
export function columnsFor(width: number, height: number, count: number): number {
  if (count <= 1) return 1
  // More columns than panels would only ever be empty cells; more than fit would be too narrow
  const widest = Math.min(count, Math.max(1, Math.floor(width / MIN_PANEL_W)))
  // The fewest rows that keep a panel under MAX_PANEL_H. 1 on any ordinary screen, and 1
  // when the height has not been measured yet (0) — the guard cannot invent a constraint
  const minRows = Math.floor(height / MAX_PANEL_H) + 1

  let best = 0
  let fewest = Infinity
  // Ascending, and a strict improvement is required — so a tie keeps the wider panels
  for (let cols = 1; cols <= widest; cols++) {
    const rows = rowsFor(count, cols)
    if (rows < minRows || rows > Math.max(cols, minRows)) continue
    if (cols * rows < fewest) {
      fewest = cols * rows
      best = cols
    }
  }
  // Nothing satisfies both bounds — more panels than a square-ish grid of this width holds,
  // or too few to divide a very tall screen. Then the width decides on its own, as before
  return best || widest
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
