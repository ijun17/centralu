/**
 * The grid arrangement: an auto-flow grid, so the arrangement is a single order of ids with no coordinates.
 * The screen decides the number of cells; a chosen count would need choosing again on every resize.
 */

/** Below this neither the conversation nor the input box can be read; the only hard limit on dividing the width (#51). */
export const MIN_PANEL_W = 380

/**
 * The tallest a panel may get before the grid splits another row off; a guard against the pathological, since
 * tall is not bad in itself. Measured as one row's panel height, it fires only on 5K 5120×2880 (2828px) and portrait
 * 1440×2560 (2508px); 13" 1440×900 → 848, 16" 1728×1117 → 1065, 24" 1920×1080 → 1028, 27" 2560×1440 → 1388 stay under.
 */
export const MAX_PANEL_H = MIN_PANEL_W * 4

/** The grid does not scroll: what is on screen is everything, so each row gets 1fr once the count is known. */
export function rowsFor(count: number, cols: number): number {
  if (count <= 0) return 0
  return Math.ceil(count / Math.max(1, cols))
}

/**
 * Of the column counts that keep panels at least MIN_PANEL_W wide (§5.4: a divided screen shows nothing), the one
 * leaving the fewest empty cells, a tie going to wider panels. A count cap is the wrong unit (#51): it makes four
 * panels 3 + 1. Bounds: rows <= cols, or one column always wins; MAX_PANEL_H is the only thing that pushes rows past that.
 */
export function columnsFor(width: number, height: number, count: number): number {
  if (count <= 1) return 1
  // More columns than panels would only ever be empty cells; more than fit would be too narrow
  const widest = Math.min(count, Math.max(1, Math.floor(width / MIN_PANEL_W)))
  // 1 also when the height is not measured yet (0)
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
  // Nothing satisfies both bounds: the width decides alone
  return best || widest
}

export function addPanel(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? [...ids] : [...ids, id]
}

export function removePanel(ids: readonly string[], id: string): string[] {
  return ids.filter((x) => x !== id)
}

/**
 * Drops ids of deleted sessions before seating them. The stored order is not corrected: here a session not yet
 * listed cannot be told from one that is gone.
 */
export function visiblePanels(ids: readonly string[], known: ReadonlySet<string>): string[] {
  return ids.filter((id) => known.has(id))
}
