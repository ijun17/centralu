import { describe, expect, it } from 'vitest'
import { MIN_PANEL_W, addPanel, columnsFor, removePanel, rowsFor, visiblePanels } from './layout.js'

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
    expect(columnsFor(1600, 6)).toBe(3)
    expect(columnsFor(800, 6)).toBe(2)
    expect(columnsFor(400, 6)).toBe(1)
  })

  it('패널이 최소 폭 아래로 내려가지 않는다 — 그게 그리드를 보류했던 이유다', () => {
    for (const w of [500, 900, 1400, 2200]) {
      const cols = columnsFor(w, 9)
      if (cols > 1) expect(w / cols).toBeGreaterThanOrEqual(MIN_PANEL_W)
    }
  })

  it('항목보다 많은 열을 만들지 않는다 — 빈칸만 생긴다', () => {
    expect(columnsFor(2000, 2)).toBe(2)
    expect(columnsFor(2000, 1)).toBe(1)
  })

  it('세 열을 넘지 않는다 — 더 나누면 대화가 아니라 띠가 된다', () => {
    expect(columnsFor(4000, 12)).toBe(3)
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
