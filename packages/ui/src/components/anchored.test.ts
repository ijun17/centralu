import { describe, expect, it } from 'vitest'
import { placeAt, placeUnder } from './anchored.js'

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

describe('placeUnder, options', () => {
  it('lines the right edges up for align right, and still keeps the left edge inside the window', () => {
    const menu = { width: 192, height: 100 }
    expect(placeUnder({ top: 52, bottom: 74, left: 700, right: 760 }, menu, WIN, { align: 'right' }).left).toBe(760 - 192)
    expect(placeUnder({ top: 52, bottom: 74, left: 0, right: 40 }, menu, WIN, { align: 'right' }).left).toBe(8)
  })

  it('tries the side asked for first, and the other only when it fits worse', () => {
    const tip = { width: 100, height: 30 }
    expect(placeUnder({ top: 300, bottom: 322, left: 300 }, tip, WIN, { side: 'above' }).top).toBe(300 - 4 - 30)
    // Near the top there is no room above: the tooltip goes below the anchor
    expect(placeUnder({ top: 12, bottom: 34, left: 300 }, tip, WIN, { side: 'above' }).top).toBe(34 + 4)
  })

  it('caps a menu by the room it has, so a tall one scrolls inside instead of running off the window', () => {
    const at = placeUnder({ top: 300, bottom: 322, left: 300, right: 360 }, { width: 192, height: 900 }, WIN, { align: 'right' })
    expect(at.maxHeight).toBe(760 - 8 - 326)
  })
})

describe('placeAt', () => {
  const MENU = { width: 224, height: 76 }
  it('puts the corner at the point', () => {
    expect(placeAt({ x: 300, y: 200 }, MENU, WIN)).toEqual({ top: 200, left: 300, maxHeight: 760 - 8 - 200 })
  })

  it('comes up from the point and out to the left of it near the bottom right corner', () => {
    const at = placeAt({ x: 1090, y: 750 }, MENU, WIN)
    expect(at.left).toBe(1100 - 8 - 224)
    expect(at.top).toBe(750 - 76)
  })
})
