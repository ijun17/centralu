import { describe, expect, it } from 'vitest'
import { pagePoint } from './dragRelay.js'

/**
 * Where an item dragged out of an app view landed in the page (#308). The relay and the drop itself
 * run in a browser (e2e/fixtures/app-drag.ts); this is the arithmetic between them.
 */

const box = { left: 17, top: 17, width: 1246, height: 351 }

describe('pagePoint', () => {
  it("adds the frame's content box to a point in the view's own coordinates (WebKit)", () => {
    // Measured in WebKit: a drop at (80, 660) on a page whose frame's content box starts at (17, 17) said (63, 643)
    expect(pagePoint({ x: 63, y: 643, width: 1246, height: 351 }, box, false)).toEqual({ x: 80, y: 660 })
  })

  it('scales a point by the content box over the view\'s own size, so a zoomed page still lines up', () => {
    // The page drawn at 1.25: the frame's box is 1.25 times the view's own pixels
    const zoomed = { left: 20, top: 20, width: 1250, height: 500 }
    expect(pagePoint({ x: 100, y: -40, width: 1000, height: 400 }, zoomed, false)).toEqual({ x: 145, y: -30 })
  })

  it("takes a point already in the page's coordinates as it is (Chromium)", () => {
    expect(pagePoint({ x: 80, y: 660, width: 1246, height: 351 }, box, true)).toEqual({ x: 80, y: 660 })
  })
})
