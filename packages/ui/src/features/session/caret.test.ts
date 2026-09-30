import { describe, expect, it } from 'vitest'
import { rowsFromMetrics } from './caret.js'

/**
 * Measured values → "is it the first row, or the last?" The side that draws the mirror can only
 * be tested in a real browser (jsdom has no layout), so this only checks the judgment. The
 * actual arrow-key behavior is covered by e2e.
 */
describe('rowsFromMetrics', () => {
  const LH = 20

  it('a single line is both the first row and the last — it must keep scrolling up and down', () => {
    expect(rowsFromMetrics(0, 20, LH)).toEqual({ first: true, last: true })
  })

  it('the middle row of text wrapped to three lines is neither the first row nor the last', () => {
    expect(rowsFromMetrics(20, 60, LH)).toEqual({ first: false, last: false })
  })

  it('the last row is the last row', () => {
    expect(rowsFromMetrics(40, 60, LH)).toEqual({ first: false, last: true })
  })

  it('a fractional height (like 16.5px) does not throw off the row count', () => {
    // Two lines, line height 16.5 → the caret starts the second line (16.5), total 33
    expect(rowsFromMetrics(16.5, 33, 16.5)).toEqual({ first: false, last: true })
    expect(rowsFromMetrics(0, 33, 16.5)).toEqual({ first: true, last: false })
  })

  it('returns null when it cannot be measured — the caller falls back to the old judgment (counting newlines)', () => {
    expect(rowsFromMetrics(0, 0, 0)).toBeNull()
    expect(rowsFromMetrics(0, 20, Number.NaN)).toBeNull()
  })
})
