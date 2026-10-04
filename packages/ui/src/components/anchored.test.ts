import { describe, expect, it } from 'vitest'
import { placeUnder } from './anchored.js'

const WIN = { width: 1100, height: 760 }
const LIST = { width: 384, height: 120 }

describe('placeUnder', () => {
  it('hangs under the anchor with the left edges lined up when there is room', () => {
    expect(placeUnder({ top: 410, bottom: 432, left: 353 }, LIST, WIN)).toEqual({ top: 436, left: 353, maxHeight: 316 })
  })

  it('shifts left so its right edge stays inside the window', () => {
    expect(placeUnder({ top: 52, bottom: 74, left: 780 }, LIST, WIN).left).toBe(1100 - 8 - 384)
  })

  it('never shifts past the window left edge, even when the window is narrower than it', () => {
    expect(placeUnder({ top: 52, bottom: 74, left: 100 }, LIST, { width: 300, height: 760 }).left).toBe(8)
  })

  it('opens upward when it does not fit below and there is more room above', () => {
    const at = placeUnder({ top: 700, bottom: 722, left: 300 }, LIST, WIN)
    expect(at.top).toBe(700 - 4 - 120)
    expect(at.maxHeight).toBe(700 - 4 - 8)
  })

  it('stays below, scrolling, when it fits neither way and below has the more room', () => {
    const at = placeUnder({ top: 300, bottom: 322, left: 300 }, { width: 384, height: 900 }, WIN)
    expect(at).toEqual({ top: 326, left: 300, maxHeight: 760 - 8 - 326 })
  })

  it('caps its height by the room above when it opens upward, starting at the window top margin', () => {
    const at = placeUnder({ top: 500, bottom: 522, left: 300 }, { width: 384, height: 900 }, WIN)
    expect(at).toEqual({ top: 8, left: 300, maxHeight: 488 })
  })
})
