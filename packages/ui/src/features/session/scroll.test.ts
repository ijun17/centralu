import { describe, expect, it } from 'vitest'
import {
  decideFollow,
  distanceFromBottom,
  INPUT_GRACE_MS,
  rowKeys,
  isAtBottom,
  isScrollUpKey,
  personIsScrolling,
  shouldFollowAgain,
  stickAfterScroll,
  writeScroll,
} from './scroll.js'

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
    expect(decideFollow({ sticking: true, scrollTop: 900, lastTop: 900, touched: false })).toBe('follow')
  })

  it('does nothing once already released', () => {
    expect(decideFollow({ sticking: false, scrollTop: 0, lastTop: 900, touched: true })).toBe('ignore')
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
   * too. Pulling the judgment out reduces it to a few plain values.
   */
  it('releases when the flag is still true but the person has already moved the view up', () => {
    expect(decideFollow({ sticking: true, scrollTop: 0, lastTop: 12084, touched: true })).toBe('release')
  })

  it('tells apart content growing and the person scrolling up', () => {
    // scrollTop stays put even as content grows → follow
    expect(decideFollow({ sticking: true, scrollTop: 900, lastTop: 900, touched: true })).toBe('follow')
    // scrollTop drops when the person scrolls up → release
    expect(decideFollow({ sticking: true, scrollTop: 700, lastTop: 900, touched: true })).toBe('release')
  })

  it('a 1-2px jitter is not treated as the person scrolling up — that is browser rounding', () => {
    expect(decideFollow({ sticking: true, scrollTop: 898, lastTop: 900, touched: true })).toBe('follow')
  })

  /*
   * The WebKit burst: a large answer landed in one go, scrollTop dropped 54px on that frame with
   * no wheel, pointer, touch or key on the list, and reading that as the person let go of the
   * bottom — the list stopped 914px short of the answer's end. Layout moves scrollTop too (a
   * clamp when content shrinks, the virtual scroller compensating a row), and none of it is the
   * person.
   */
  it('a drop nobody made does not let go — without the person’s input it is layout', () => {
    expect(decideFollow({ sticking: true, scrollTop: 2296, lastTop: 2350, touched: false })).toBe('follow')
  })
})

describe('whether the person is moving the list', () => {
  it('a wheel, key or touch a moment ago counts', () => {
    expect(personIsScrolling({ now: 1000, lastInputAt: 1000 - INPUT_GRACE_MS + 1, held: false })).toBe(true)
  })

  it('an input long gone does not', () => {
    expect(personIsScrolling({ now: 1000, lastInputAt: 1000 - INPUT_GRACE_MS, held: false })).toBe(false)
    expect(personIsScrolling({ now: 1000, lastInputAt: -Infinity, held: false })).toBe(false)
  })

  it('a pointer on the scrollbar counts for as long as it is held', () => {
    expect(personIsScrolling({ now: 60_000, lastInputAt: -Infinity, held: true })).toBe(true)
  })

  it('only keys that scroll up count', () => {
    for (const key of ['PageUp', 'ArrowUp', 'Home']) expect(isScrollUpKey({ key, shiftKey: false })).toBe(true)
    expect(isScrollUpKey({ key: ' ', shiftKey: true })).toBe(true)
    for (const key of ['PageDown', 'ArrowDown', 'End', ' ', 'a'])
      expect(isScrollUpKey({ key, shiftKey: false })).toBe(false)
  })
})

describe('what a scroll event says', () => {
  const pos = (scrollTop: number, scrollHeight: number) => ({ scrollTop, scrollHeight, clientHeight: 550 })

  /*
   * Seen in WebKit, the same burst: following put the view at the end of a 1986px list (1436),
   * the answer grew it to 2900px, and only then did the scroll event for that write arrive. The
   * view never moved, but it read 914px from the bottom.
   */
  it('content that landed before the event does not let go of a view that never moved', () => {
    expect(stickAfterScroll({ sticking: true, lastTop: 1436, pos: pos(1436, 2900) })).toEqual({
      sticking: true,
      lastTop: 1436,
    })
  })

  it('a view moved up and away from the bottom lets go — a wheel, a key, the scrollbar or a script', () => {
    expect(stickAfterScroll({ sticking: true, lastTop: 1436, pos: pos(0, 1986) }).sticking).toBe(false)
  })

  it('reaching the bottom sticks again', () => {
    expect(stickAfterScroll({ sticking: false, lastTop: 0, pos: pos(1436, 1986) })).toEqual({
      sticking: true,
      lastTop: 1436,
    })
  })

  it('a slow scroll up, a pixel or two per event, still adds up to letting go', () => {
    let state = { sticking: true, lastTop: 1436 }
    for (let top = 1434; top >= 1336; top -= 2) state = stickAfterScroll({ ...state, pos: pos(top, 1986) })
    expect(state.sticking).toBe(false)
  })

  it('a clamp after the content shrank leaves it following, from the new end', () => {
    expect(stickAfterScroll({ sticking: true, lastTop: 1436, pos: pos(1382, 1932) })).toEqual({
      sticking: true,
      lastTop: 1382,
    })
  })
})

describe('the virtual scroller’s compensation write', () => {
  const writer = (scrollTop: number) => {
    const writes: number[] = []
    return { el: { scrollTop, scrollTo: (o: ScrollToOptions) => void writes.push(o.top!) }, writes }
  }

  /*
   * The numbers from the WebKit trace: the view was at the end (2350), the scroller's cached
   * offset was a frame stale (1436), and the answer row measured 860px taller. Writing
   * 1436 + 860 = 2296 put the view 54px up from where it was — a scroll nobody made.
   */
  it('shifts the view from where it is, not from the offset the scroller last saw', () => {
    const { el, writes } = writer(2350)
    writeScroll(el, 1436, { adjustments: 860 })
    expect(writes).toEqual([3210])
  })

  it('any other write is an absolute target and goes through as is', () => {
    const { el, writes } = writer(2350)
    writeScroll(el, 400, {})
    writeScroll(el, 500, { adjustments: undefined })
    expect(writes).toEqual([400, 500])
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

describe('rowKeys (#64)', () => {
  it('keeps each row its own key when the keys are already unique', () => {
    expect(rowKeys([{ seq: 3 }, { seq: 1 }, { seq: 2 }])).toEqual([3, 1, 2])
  })

  it('gives a later row that shares a key one of its own, and leaves the first as it was', () => {
    const keys = rowKeys([{ seq: 1 }, { seq: 7 }, { seq: 2 }, { seq: 7 }, { seq: 7 }])
    expect(keys.slice(0, 3)).toEqual([1, 7, 2])
    expect(new Set(keys).size).toBe(keys.length)
  })
})
