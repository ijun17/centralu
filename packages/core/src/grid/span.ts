import { GRID_SPAN_MAX, type GridSpan } from '@cc/protocol/client'
import { MAX_PANEL_H, MIN_PANEL_W } from './layout.js'

/**
 * App panels that span more than one cell (#306); a session panel is always 1 × 1. Everything else is `layout.ts`'s
 * rule with spans counted in: with every span 1 × 1 the result is `columnsFor`/`rowsFor` cell for cell (layout.test.ts).
 */

export const ONE_CELL: GridSpan = { cols: 1, rows: 1 }

export function sanitizeGridSpan(raw: unknown): GridSpan | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { cols, rows } = raw as { cols?: unknown; rows?: unknown }
  const side = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) ? Math.min(GRID_SPAN_MAX, Math.max(1, n)) : 0)
  const c = side(cols)
  const r = side(rows)
  return c && r ? { cols: c, rows: r } : undefined
}

/** The first set: this placement (top bar) > the person's app setting > the app's manifest `view.span` > 1 × 1 */
export function resolveGridSpan(
  placement: GridSpan | undefined,
  setting: GridSpan | undefined,
  recommended: GridSpan | undefined,
): GridSpan {
  return explainGridSpan(placement, setting, recommended).span
}

export type GridSpanSource = 'placement' | 'setting' | 'app' | 'default'

/** The span picker shows `from` as the default it falls back to */
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

/** col and row count from 0 */
export type GridCell = { col: number; row: number; cols: number; rows: number }

/** cells in the order the panels were given */
export type GridArrangement = { cols: number; rows: number; cells: GridCell[] }

/** `columnsFor`'s MAX_PANEL_H guard; 1 also when the height is not measured yet (0) */
function minRowsFor(height: number): number {
  return Math.floor(height / MAX_PANEL_H) + 1
}

/** Every column across, and as many rows as `columnsFor`'s rows <= cols bound allows; a larger span is cut to it */
export function gridSpanRoom(cols: number, height: number): GridSpan {
  return { cols: Math.max(1, cols), rows: Math.max(1, cols, minRowsFor(height)) }
}

/**
 * What the span picker calls "fits" and what decides whether a panel says it was clamped: not the columns one
 * arrangement chose, since a panel spanning all of a two-column grid is as wide as the window allows.
 */
export function windowSpanRoom(width: number, height: number): GridSpan {
  return gridSpanRoom(Math.max(1, Math.floor(width / MIN_PANEL_W)), height)
}

/**
 * First fit from the top left, not after the last panel (CSS's default "sparse" flow), so a 1 × 1 after a wide panel
 * fills the hole it left: an empty cell is width taken from the panels in use.
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
 * `columnsFor`'s rule with spans counted in. Empty cells are counted after each count's spans are cut to fit, so one
 * session and a 2 × 1 board come out as three columns in one row, not the board over the session beside a hole.
 */
export function arrangeGrid(spans: readonly GridSpan[], width: number, height: number): GridArrangement {
  if (spans.length === 0) return { cols: 1, rows: 0, cells: [] }
  const across = spans.reduce((n, s) => n + Math.max(1, s.cols), 0)
  const widest = Math.min(across, Math.max(1, Math.floor(width / MIN_PANEL_W)))
  const minRows = minRowsFor(height)
  const at = (cols: number) => ({ cols, ...packGrid(spans, cols, gridSpanRoom(cols, height)) })

  let best: GridArrangement | null = null
  let fewest = Infinity
  // Ascending, with a strict improvement required: a tie keeps the wider panels
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
 * Whether the top bar says the window has no room for the asked span: only past `windowSpanRoom`, and never for a
 * panel that fills the whole grid.
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
