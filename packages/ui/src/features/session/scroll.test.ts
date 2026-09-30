import { describe, expect, it } from 'vitest'
import { decideFollow, distanceFromBottom, isAtBottom, shouldFollowAgain } from './scroll.js'

describe('is it at the bottom', () => {
  it('exactly at the bottom', () => {
    expect(isAtBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
  })

  it('a little above still counts as the bottom — it will never line up exactly to the pixel', () => {
    expect(isAtBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
  })

  it('not the bottom once scrolled far up', () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })).toBe(false)
  })

  it('the distance is 0 or less when the content is smaller than the viewport', () => {
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe(0)
  })
})

describe('whether to follow', () => {
  it('follows when stuck to the bottom and the position has not changed', () => {
    expect(decideFollow({ sticking: true, scrollTop: 900, lastTop: 900 })).toBe('follow')
  })

  it('does nothing once already released', () => {
    expect(decideFollow({ sticking: false, scrollTop: 0, lastTop: 900 })).toBe('ignore')
  })

  /*
   * This is a race that actually happened in this project.
   *
   * The person scrolled up, but before the scroll event was processed and while the flag was
   * still true, the virtual scroller re-measured a row and changed the total height, so
   * "follow" ran first. Looking at the flag alone would have dragged the person back down to
   * the bottom right here.
   *
   * e2e could not catch this moment — adding a wait made it break against the pre-fix code
   * too. Pulling the judgment out reduces it to three plain values.
   */
  it('releases when the flag is still true but the position has already moved up', () => {
    expect(decideFollow({ sticking: true, scrollTop: 0, lastTop: 12084 })).toBe('release')
  })

  it('tells apart content growing and the person scrolling up', () => {
    // scrollTop stays put even as content grows → follow
    expect(decideFollow({ sticking: true, scrollTop: 900, lastTop: 900 })).toBe('follow')
    // scrollTop drops when the person scrolls up → release
    expect(decideFollow({ sticking: true, scrollTop: 700, lastTop: 900 })).toBe('release')
  })

  it('a 1-2px jitter is not treated as the person scrolling up — that is browser rounding', () => {
    expect(decideFollow({ sticking: true, scrollTop: 898, lastTop: 900 })).toBe('follow')
  })
})

describe('one more time on the deferred frame', () => {
  it('scrolls down once more if still near the bottom (a new row is measured on the next frame)', () => {
    expect(shouldFollowAgain({ scrollTop: 900, scrollHeight: 1040, clientHeight: 100 })).toBe(true)
  })

  it('does not scroll down if the person scrolled up in the meantime — using the judgment made when scheduled would override the person', () => {
    expect(shouldFollowAgain({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })).toBe(false)
  })
})
