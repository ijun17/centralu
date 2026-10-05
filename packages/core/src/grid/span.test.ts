import { describe, expect, it } from 'vitest'
import type { GridSpan } from '@cc/protocol'
import { MAX_PANEL_H, MIN_PANEL_W, columnsFor, rowsFor } from './layout.js'
import {
  ONE_CELL,
  arrangeGrid,
  explainGridSpan,
  gridSpanRoom,
  windowSpanRoom,
  packGrid,
  resolveGridSpan,
  sanitizeGridSpan,
  spanClamped,
  type GridCell,
} from './span.js'

/** An ordinary screen height: the MAX_PANEL_H guard does nothing (layout.test.ts) */
const H = 900
const one = (n: number): GridSpan[] => Array.from({ length: n }, () => ONE_CELL)
const span = (cols: number, rows: number): GridSpan => ({ cols, rows })

/** No two panels share a cell, and none leaves the grid */
function expectNoOverlap(cells: GridCell[], cols: number, rows: number) {
  const seen = new Set<string>()
  for (const c of cells) {
    expect(c.col + c.cols).toBeLessThanOrEqual(cols)
    expect(c.row + c.rows).toBeLessThanOrEqual(rows)
    for (let r = c.row; r < c.row + c.rows; r++)
      for (let k = c.col; k < c.col + c.cols; k++) {
        const key = `${r},${k}`
        expect(seen.has(key), key).toBe(false)
        seen.add(key)
      }
  }
}

describe('resolveGridSpan (#306)', () => {
  it('the placement’s choice, then the person’s setting for the app, then the app’s recommendation, then 1 × 1', () => {
    expect(resolveGridSpan(span(3, 1), span(2, 2), span(1, 2))).toEqual(span(3, 1))
    expect(resolveGridSpan(undefined, span(2, 2), span(1, 2))).toEqual(span(2, 2))
    expect(resolveGridSpan(undefined, undefined, span(1, 2))).toEqual(span(1, 2))
    expect(resolveGridSpan(undefined, undefined, undefined)).toEqual(ONE_CELL)
    expect(
      [
        explainGridSpan(span(3, 1), span(2, 2), span(1, 2)),
        explainGridSpan(undefined, span(2, 2), span(1, 2)),
        explainGridSpan(undefined, undefined, span(1, 2)),
        explainGridSpan(undefined, undefined, undefined),
      ].map((e) => e.from),
    ).toEqual(['placement', 'setting', 'app', 'default'])
  })

  it('a value that is not a span is passed over, and one out of bounds is clamped', () => {
    expect(sanitizeGridSpan({ cols: 9, rows: 0 })).toEqual(span(4, 1))
    for (const bad of [null, 'x', { cols: 2 }, { cols: 1.5, rows: 1 }, { cols: '2', rows: 1 }]) {
      expect(sanitizeGridSpan(bad), JSON.stringify(bad)).toBeUndefined()
    }
    expect(resolveGridSpan({ cols: 2 } as GridSpan, undefined, span(2, 1))).toEqual(span(2, 1))
  })
})

describe('packGrid (#306)', () => {
  it('1 × 1 panels go row by row, in order', () => {
    expect(packGrid(one(5), 3, gridSpanRoom(3, H)).cells).toEqual([
      { col: 0, row: 0, cols: 1, rows: 1 },
      { col: 1, row: 0, cols: 1, rows: 1 },
      { col: 2, row: 0, cols: 1, rows: 1 },
      { col: 0, row: 1, cols: 1, rows: 1 },
      { col: 1, row: 1, cols: 1, rows: 1 },
    ])
  })

  it('a wide panel that does not fit at the end of a row goes to the next, and a later panel fills the hole it left', () => {
    // s1 s2 board board? Three columns: the board cannot stand at column 2, so it opens row 1 and s3 takes column 2
    const { rows, cells } = packGrid([ONE_CELL, ONE_CELL, span(2, 1), ONE_CELL], 3, gridSpanRoom(3, H))
    expect(rows).toBe(2)
    expect(cells).toEqual([
      { col: 0, row: 0, cols: 1, rows: 1 },
      { col: 1, row: 0, cols: 1, rows: 1 },
      { col: 0, row: 1, cols: 2, rows: 1 },
      { col: 2, row: 0, cols: 1, rows: 1 },
    ])
  })

  it('a tall panel holds its column for the rows it spans', () => {
    const { rows, cells } = packGrid([span(1, 2), ONE_CELL, ONE_CELL], 2, gridSpanRoom(2, H))
    expect(rows).toBe(2)
    expect(cells).toEqual([
      { col: 0, row: 0, cols: 1, rows: 2 },
      { col: 1, row: 0, cols: 1, rows: 1 },
      { col: 1, row: 1, cols: 1, rows: 1 },
    ])
  })

  it('a span past the room is cut to it — never wider than the grid, never taller than it may be', () => {
    const { cells } = packGrid([span(4, 4)], 2, gridSpanRoom(2, H))
    expect(cells).toEqual([{ col: 0, row: 0, cols: 2, rows: 2 }])
  })
})

describe('arrangeGrid (#306)', () => {
  it('with every span 1 × 1 it is exactly the grid columnsFor and rowsFor give, cell for cell', () => {
    for (const w of [300, 500, 800, 1024, 1280, 1440, 1640, 2200, 2560, 4000, 5120]) {
      for (const h of [0, 600, 900, 1400, 2560, 2880]) {
        for (let n = 1; n <= 16; n++) {
          const a = arrangeGrid(one(n), w, h)
          const cols = columnsFor(w, h, n)
          expect(a.cols, `${w}×${h}, ${n}`).toBe(cols)
          expect(a.rows, `${w}×${h}, ${n}`).toBe(rowsFor(n, cols))
          expect(a.cells, `${w}×${h}, ${n}`).toEqual(
            Array.from({ length: n }, (_, i) => ({ col: i % cols, row: Math.floor(i / cols), cols: 1, rows: 1 })),
          )
        }
      }
    }
  })

  it('one session and a 2 × 1 board: three columns in one row, the board two of them', () => {
    const a = arrangeGrid([ONE_CELL, span(2, 1)], 1640, H)
    expect(a).toEqual({
      cols: 3,
      rows: 1,
      cells: [
        { col: 0, row: 0, cols: 1, rows: 1 },
        { col: 1, row: 0, cols: 2, rows: 1 },
      ],
    })
  })

  it('the owner’s grid — three sessions and a 2 × 1 board — keeps every panel, the board two cells wide', () => {
    const a = arrangeGrid([ONE_CELL, ONE_CELL, ONE_CELL, span(2, 1)], 1640, H)
    expect(a.cols).toBe(3)
    expect(a.rows).toBe(2)
    expect(a.cells[3]).toEqual({ col: 0, row: 1, cols: 2, rows: 1 })
    expectNoOverlap(a.cells, a.cols, a.rows)
  })

  it('a span that does not fit the window is clamped, and every panel still stands, none below the minimum width', () => {
    // Room for two columns: a 4 × 1 board is cut to the two there are
    const a = arrangeGrid([span(4, 1), ONE_CELL, ONE_CELL], 800, H)
    expect(a.cols).toBe(2)
    expect(a.cells[0]).toEqual({ col: 0, row: 0, cols: 2, rows: 1 })
    expect(a.cells).toHaveLength(3)
    expectNoOverlap(a.cells, a.cols, a.rows)
    // One column: everything is 1 × 1
    const narrow = arrangeGrid([span(3, 2), ONE_CELL], 500, H)
    expect(narrow.cols).toBe(1)
    expect(narrow.cells.map((c) => [c.cols, c.rows])).toEqual([
      [1, 1],
      [1, 1],
    ])
  })

  it('never divides the width below MIN_PANEL_W and never overlaps, over many mixes of spans', () => {
    const spans = [ONE_CELL, span(2, 1), span(1, 2), span(2, 2), span(3, 1), span(4, 4)]
    let seed = 7
    const next = () => (seed = (seed * 48271) % 2147483647)
    for (let round = 0; round < 400; round++) {
      const n = 1 + (next() % 9)
      const list = Array.from({ length: n }, () => spans[next() % spans.length]!)
      const w = 300 + (next() % 4000)
      const h = next() % 3000
      const a = arrangeGrid(list, w, h)
      if (a.cols > 1) expect(w / a.cols).toBeGreaterThanOrEqual(MIN_PANEL_W)
      expect(a.cells).toHaveLength(n)
      expectNoOverlap(a.cells, a.cols, a.rows)
      // The same list in the same room always comes out the same way
      expect(arrangeGrid(list, w, h)).toEqual(a)
    }
  })

  it('reflows when the window changes: wider gives the span its cells back', () => {
    const list = [span(2, 1), ONE_CELL]
    expect(arrangeGrid(list, 500, H).cells[0]).toEqual({ col: 0, row: 0, cols: 1, rows: 1 })
    expect(arrangeGrid(list, 1640, H).cells[0]).toEqual({ col: 0, row: 0, cols: 2, rows: 1 })
  })

  it('on a very tall screen the rows MAX_PANEL_H asks for are room a tall span may use', () => {
    const h = MAX_PANEL_H * 2 + 10
    const a = arrangeGrid([span(1, 3), ONE_CELL, ONE_CELL], 800, h)
    expect(a.cols).toBe(2)
    expect(a.rows).toBe(3)
    expect(a.cells[0]).toEqual({ col: 0, row: 0, cols: 1, rows: 3 })
    expect(h / a.rows).toBeLessThanOrEqual(MAX_PANEL_H)
  })

  it('nothing on the grid: no rows', () => {
    expect(arrangeGrid([], 1000, H)).toEqual({ cols: 1, rows: 0, cells: [] })
  })
})

describe('spanClamped (#306)', () => {
  it('says a panel was cut only when the window has no room for its span, and not when it fills the grid', () => {
    const room = windowSpanRoom(800, H) // two columns fit
    expect(room).toEqual(span(2, 2))
    // A 3 × 1 in a window that holds two columns: cut, and it says so
    expect(spanClamped(span(3, 1), { col: 0, row: 1, cols: 2, rows: 1 }, { cols: 2, rows: 2 }, room)).toBe(true)
    // Standing at what it asked for
    expect(spanClamped(span(2, 1), { col: 0, row: 1, cols: 2, rows: 1 }, { cols: 2, rows: 2 }, room)).toBe(false)
    // A lone panel is the whole grid whatever it asked for
    expect(
      spanClamped(span(3, 1), { col: 0, row: 0, cols: 1, rows: 1 }, { cols: 1, rows: 1 }, windowSpanRoom(500, H)),
    ).toBe(false)
    // Room for three columns, but the arrangement chose two: the panel spans all of them, as wide as it can be — no word
    const wide = windowSpanRoom(1200, H)
    const a = arrangeGrid([ONE_CELL, span(3, 1)], 1200, H)
    expect(a.cols).toBe(2)
    expect(spanClamped(span(3, 1), a.cells[1]!, a, wide)).toBe(false)
  })
})
