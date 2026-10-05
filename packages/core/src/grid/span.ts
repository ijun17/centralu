import { GRID_SPAN_MAX, type GridSpan } from '@cc/protocol'
import { MAX_PANEL_H, MIN_PANEL_W } from './layout.js'

/**
 * Panels that span more than one cell (#306).
 *
 * An app panel on the grid can be wider or taller than one cell — a board that is too narrow in one cell takes two
 * columns. The person sets it: for one placement from the panel's top bar, or for the app in Settings; the app may
 * recommend one in its manifest. A session panel is always 1 × 1.
 *
 * Everything else about the grid stays as `layout.ts` says. The screen decides the number of columns (a panel is never
 * narrower than MIN_PANEL_W), the grid does not scroll, rows share the height, and the arrangement is one order — no
 * coordinates are stored. What changes is that a cell is no longer always one panel, so the columns are chosen, and the
 * panels placed, with the spans counted in. When every span is 1 × 1 the result is exactly the grid `columnsFor` and
 * `rowsFor` give, cell for cell (layout.test.ts holds the two together), so a grid where nobody set a span is unchanged.
 */

/** One cell, the size of every session panel and of an app panel nobody has sized */
export const ONE_CELL: GridSpan = { cols: 1, rows: 1 }

/** A span kept whole and within 1..GRID_SPAN_MAX, or undefined for anything that is not one */
export function sanitizeGridSpan(raw: unknown): GridSpan | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { cols, rows } = raw as { cols?: unknown; rows?: unknown }
  const side = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) ? Math.min(GRID_SPAN_MAX, Math.max(1, n)) : 0)
  const c = side(cols)
  const r = side(rows)
  return c && r ? { cols: c, rows: r } : undefined
}

/**
 * An app panel's span, by who decided it — the first that is set:
 *
 *   the person's choice for this placement (the panel's top bar)
 *   > the person's setting for the app (Settings → Apps)
 *   > the app's recommendation (its manifest's `view.span`)
 *   > 1 × 1
 *
 * The person outranks the app at both levels: the app only says what suits it, and an app that says nothing stands
 * as it always did.
 */
export function resolveGridSpan(
  placement: GridSpan | undefined,
  setting: GridSpan | undefined,
  recommended: GridSpan | undefined,
): GridSpan {
  return explainGridSpan(placement, setting, recommended).span
}

/** Who decided a panel's span: the placement's own choice, the person's setting for the app, the app, or nobody */
export type GridSpanSource = 'placement' | 'setting' | 'app' | 'default'

/** `resolveGridSpan`, saying which of the four it came from — what the span picker shows as the default it falls back to */
export function explainGridSpan(
  placement: GridSpan | undefined,
  setting: GridSpan | undefined,
  recommended: GridSpan | undefined,
): { span: GridSpan; from: GridSpanSource } {
  const p = sanitizeGridSpan(placement)
  if (p) return { span: p, from: 'placement' }
  const s = sanitizeGridSpan(setting)
  if (s) return { span: s, from: 'setting' }
  const r = sanitizeGridSpan(recommended)
  if (r) return { span: r, from: 'app' }
  return { span: ONE_CELL, from: 'default' }
}

/** Where one panel stands: its first column and row (from 0) and the cells it covers */
export type GridCell = { col: number; row: number; cols: number; rows: number }

/** The grid's tracks and every panel's cell, in the order the panels were given */
export type GridArrangement = { cols: number; rows: number; cells: GridCell[] }

/**
 * The fewest rows that keep a panel under MAX_PANEL_H — `columnsFor`'s guard, 1 on any ordinary screen and when the
 * height has not been measured yet (0).
 */
function minRowsFor(height: number): number {
  return Math.floor(height / MAX_PANEL_H) + 1
}

/**
 * The largest span a panel can have in a grid of `cols` columns: every column across, and as many rows as the grid
 * may have before it is taller than it is wide (`columnsFor`'s bound). A span past it is placed at this size.
 */
export function gridSpanRoom(cols: number, height: number): GridSpan {
  return { cols: Math.max(1, cols), rows: Math.max(1, cols, minRowsFor(height)) }
}

/**
 * The largest span the window has room for at all: as many columns as fit at MIN_PANEL_W, and the rows that many
 * columns allow. What the span picker calls "fits", and what decides whether a panel says it was clamped — not the
 * columns one arrangement happened to choose, because a panel spanning every column of a two-column grid is already
 * as wide as the window lets it be, even if it asked for three.
 */
export function windowSpanRoom(width: number, height: number): GridSpan {
  return gridSpanRoom(Math.max(1, Math.floor(width / MIN_PANEL_W)), height)
}

/**
 * Places panels, in order, on a grid `cols` wide: each at the first place, reading row by row from the top left, where
 * its span fits on free cells. A span wider or taller than `room` is cut to it first.
 *
 * First fit from the top rather than after the last panel placed (CSS's default "sparse" flow), so a 1 × 1 panel after
 * a wide one fills the hole the wide one could not, instead of leaving it empty: an empty cell is width taken from the
 * panels in use (`columnsFor`). The order still decides everything — the same list always comes out the same way —
 * and with every span 1 × 1 the result is plain row-by-row order.
 */
export function packGrid(spans: readonly GridSpan[], cols: number, room: GridSpan): { rows: number; cells: GridCell[] } {
  const width = Math.max(1, cols)
  const taken: boolean[][] = []
  const free = (row: number, col: number, w: number, h: number) => {
    for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) if (taken[r]?.[c]) return false
    return true
  }
  const cells: GridCell[] = []
  let rows = 0
  for (const span of spans) {
    const w = Math.min(span.cols, width, room.cols)
    const h = Math.min(span.rows, room.rows)
    let placed: GridCell | null = null
    for (let row = 0; !placed; row++) {
      for (let col = 0; col + w <= width; col++) {
        if (free(row, col, w, h)) {
          placed = { col, row, cols: w, rows: h }
          break
        }
      }
    }
    for (let r = placed.row; r < placed.row + h; r++) {
      const line = (taken[r] ??= [])
      for (let c = placed.col; c < placed.col + w; c++) line[c] = true
    }
    rows = Math.max(rows, placed.row + h)
    cells.push(placed)
  }
  return { rows, cells }
}

/**
 * The grid for these panels' spans in a room `width` × `height` real pixels: `columnsFor`'s rule with spans counted in.
 *
 * Of the column counts that fit (no panel below MIN_PANEL_W, and no more columns than the spans could fill side by
 * side), take the one leaving the fewest cells empty, and on a tie the fewer columns, so panels are wider. The same two
 * bounds hold: no taller than it is wide (`rows <= cols`), and tall enough to keep a panel under MAX_PANEL_H. When no
 * count meets both, the widest decides, as in `columnsFor`. Empty cells are counted after each count's spans are cut
 * to fit it, so a count where a wide panel fits whole beats one where it would leave a hole beside it: one session and
 * a 2 × 1 board come out as three columns in one row, not the board over the session with a hole next to it.
 */
export function arrangeGrid(spans: readonly GridSpan[], width: number, height: number): GridArrangement {
  if (spans.length === 0) return { cols: 1, rows: 0, cells: [] }
  const across = spans.reduce((n, s) => n + Math.max(1, s.cols), 0)
  const widest = Math.min(across, Math.max(1, Math.floor(width / MIN_PANEL_W)))
  const minRows = minRowsFor(height)
  const at = (cols: number) => ({ cols, ...packGrid(spans, cols, gridSpanRoom(cols, height)) })

  let best: GridArrangement | null = null
  let fewest = Infinity
  // Ascending, and a strict improvement is required — so a tie keeps the wider panels
  for (let cols = 1; cols <= widest; cols++) {
    const a = at(cols)
    if (a.rows < minRows || a.rows > Math.max(cols, minRows)) continue
    const used = a.cells.reduce((n, c) => n + c.cols * c.rows, 0)
    const empty = cols * a.rows - used
    if (empty < fewest) {
      fewest = empty
      best = a
    }
  }
  return best ?? at(widest)
}

/**
 * Whether a panel stands smaller than its span asked for because the window has no room for it — and so whether its
 * top bar should say so. A panel that is cut only because it already spans the whole grid in that direction is as
 * large as the window lets it be; only a span past what the window holds at all (`windowSpanRoom`) is worth a word.
 * Not when the panel fills the whole grid either: a lone panel is the whole screen whatever it asked for.
 */
export function spanClamped(
  asked: GridSpan,
  cell: GridCell,
  grid: { cols: number; rows: number },
  room: GridSpan,
): boolean {
  if (cell.cols >= asked.cols && cell.rows >= asked.rows) return false
  if (cell.cols === grid.cols && cell.rows === grid.rows) return false
  return asked.cols > room.cols || asked.rows > room.rows
}
