import { describe, expect, it } from 'vitest'
import { MAX_PANEL_H, MIN_PANEL_W, addPanel, columnsFor, removePanel, rowsFor, visiblePanels } from './layout.js'

/**
 * A screen height that leaves the height guard inert, which is every ordinary one
 * (see MAX_PANEL_H). Cases that pass this are about the width, as they always were.
 */
const H = 900

describe('rowsFor', () => {
  it('열 수로 나눈 만큼 줄이 생긴다', () => {
    expect(rowsFor(6, 3)).toBe(2)
    expect(rowsFor(4, 3)).toBe(2)
    expect(rowsFor(3, 3)).toBe(1)
  })

  it('빈 배치는 줄이 없다', () => {
    expect(rowsFor(0, 3)).toBe(0)
  })

  it('열이 0으로 들어와도 나눗셈이 깨지지 않는다', () => {
    expect(rowsFor(3, 0)).toBe(3)
  })
})

describe('columnsFor', () => {
  it('넓으면 여러 열, 좁으면 한 열', () => {
    expect(columnsFor(1600, H, 6)).toBe(3)
    expect(columnsFor(800, H, 6)).toBe(2)
    expect(columnsFor(400, H, 6)).toBe(1)
  })

  it('패널이 최소 폭 아래로 내려가지 않는다 — 그게 그리드를 보류했던 이유다', () => {
    // With the three-column cap gone this is the only hard limit left, so it is checked
    // over every count and width we expect to see rather than one of each (#51)
    for (const w of [500, 900, 1400, 2200, 2560, 4000]) {
      for (let n = 2; n <= 12; n++) {
        const cols = columnsFor(w, H, n)
        if (cols > 1) expect(w / cols).toBeGreaterThanOrEqual(MIN_PANEL_W)
      }
    }
  })

  it('항목보다 많은 열을 만들지 않는다 — 빈칸만 생긴다', () => {
    expect(columnsFor(2000, H, 2)).toBe(2)
    expect(columnsFor(2000, H, 1)).toBe(1)
  })

  it('four panels go 2×2 — three across leaves two cells empty and every panel narrower', () => {
    for (const w of [1280, 1440, 1600, 1800, 2560]) expect(columnsFor(w, H, 4)).toBe(2)
  })

  it('the same rule for every count, not a special case for four', () => {
    // at 1600 (four columns fit): 2 | 3 | 2×2 | 3+2 | 3+3 | 4+3 | 4+4 | 3×3
    expect([2, 3, 4, 5, 6, 7, 8, 9].map((n) => columnsFor(1600, H, n))).toEqual([2, 3, 2, 3, 3, 4, 4, 3])
    // at 1280 (three fit) the same rule gives up columns rather than the minimum width
    expect([2, 3, 4, 5, 6, 7, 8, 9].map((n) => columnsFor(1280, H, n))).toEqual([2, 3, 2, 3, 3, 3, 3, 3])
  })

  it('a wide screen may hold more than three columns — the limit is the panel width, not a count', () => {
    // 12 panels at 4000: four columns are 1000px each, where the old cap of three insisted on
    // 1333px and a fourth row. Both fill every cell, so the wider-panel tie-break is not what
    // decides it — three columns would be a row deeper.
    expect(columnsFor(4000, H, 12)).toBe(4)
    // Seven and eight panels only ever fit without a wasted cell above three columns
    expect(columnsFor(2560, H, 7)).toBe(4)
    expect(columnsFor(2560, H, 8)).toBe(4)
    // Five is the count where filling every cell costs the most width: 512px against 853px
    expect(columnsFor(2560, H, 5)).toBe(5)
  })

  it('where two counts leave the same cells empty, the wider panels win', () => {
    // six at 2560: 3×2 and 6×1 both fill every cell — 853px each against 426px
    expect(columnsFor(2560, H, 6)).toBe(3)
    // four at 2560: 2×2 and 4×1 both fill every cell — 1280px each against 640px
    expect(columnsFor(2560, H, 4)).toBe(2)
  })

  it('no column count that fits leaves fewer cells empty', () => {
    for (const w of [1280, 1440, 1600, 1800, 2560]) {
      const fits = Math.max(1, Math.floor(w / MIN_PANEL_W))
      for (let n = 2; n <= 9; n++) {
        const cols = columnsFor(w, H, n)
        const empty = cols * rowsFor(n, cols) - n
        for (let c = 1; c <= Math.min(n, fits); c++) {
          const rows = rowsFor(n, c)
          // A grid taller than it is wide is not on the table — see columnsFor
          if (rows > c) continue
          expect(c * rows - n).toBeGreaterThanOrEqual(empty)
        }
      }
    }
  })

  it('never comes out taller than it is wide while the width allows otherwise', () => {
    for (const w of [1280, 1440, 1600, 1800, 2560, 4000]) {
      const fits = Math.max(1, Math.floor(w / MIN_PANEL_W))
      for (let n = 2; n <= 12; n++) {
        // Too narrow for any such arrangement (fits² panels is the most one holds) — a strip is all there is
        if (fits * fits < n) continue
        expect(rowsFor(n, columnsFor(w, H, n))).toBeLessThanOrEqual(columnsFor(w, H, n))
      }
    }
  })

  it('a screen tall enough to make a panel absurd gets another row — and only then', () => {
    // 27" 2560×1440: three in a row would be 1388px tall, under the limit. Nothing happens
    expect(columnsFor(2260, 1388, 3)).toBe(3)
    // 5K 5120×2880: the same three in a row would be 2828px tall, so a row is split off
    expect(columnsFor(4820, 2828, 3)).toBe(2)
    // A portrait monitor is the only other screen it fires on — 2508px in one row
    expect(columnsFor(1140, 2508, 3)).toBe(2)
    // The limit itself is already too tall, and a pixel under it is not
    expect(columnsFor(1140, MAX_PANEL_H, 2)).toBe(1)
    expect(columnsFor(1140, MAX_PANEL_H - 1, 2)).toBe(2)
  })

  it('two panels on a 5K screen give the shape up rather than the height limit', () => {
    // There is nothing else available: two panels are one row or one column, and one row
    // is 2828px tall. The height limit is the decided one, so the shape rule is what yields
    expect(columnsFor(4820, 2828, 2)).toBe(1)
  })

  it('the height decides nothing at all on any screen under the limit', () => {
    // Measured screen heights — 13", 16", 24", 27" (see MAX_PANEL_H). 0 is the first render,
    // before the grid has been measured: an unknown height may not invent a constraint either
    for (const h of [848, 1028, 1065, 1388]) {
      for (const w of [1140, 1428, 1620, 2260]) {
        for (let n = 2; n <= 12; n++) expect(columnsFor(w, h, n)).toBe(columnsFor(w, 0, n))
      }
    }
  })
})

describe('addPanel / removePanel', () => {
  it('맨 뒤에 붙는다', () => {
    expect(addPanel(['a'], 'b')).toEqual(['a', 'b'])
  })

  it('두 번 놓아도 두 개가 되지 않는다', () => {
    expect(addPanel(['a', 'b'], 'a')).toEqual(['a', 'b'])
  })

  it('빼면 나머지 순서는 그대로', () => {
    expect(removePanel(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  it('원본을 건드리지 않는다', () => {
    const ids = ['a', 'b']
    addPanel(ids, 'c')
    removePanel(ids, 'a')
    expect(ids).toEqual(['a', 'b'])
  })
})

describe('visiblePanels', () => {
  it('사라진 세션은 그리지 않는다', () => {
    expect(visiblePanels(['a', 'gone', 'b'], new Set(['a', 'b']))).toEqual(['a', 'b'])
  })

  it('순서는 그대로', () => {
    expect(visiblePanels(['b', 'a'], new Set(['a', 'b']))).toEqual(['b', 'a'])
  })
})
