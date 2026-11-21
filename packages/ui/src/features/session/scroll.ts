/**
 * The conversation view's scroll judgments, out of the DOM so their races reduce to plain values
 * a test can hold (docs/state-management.md "The conversation's scroll position").
 */

const BOTTOM_SLACK = 80

/** Not zero: rounding jitters scrollTop by a pixel or two */
export const MOVED_UP_SLACK = 4

export type ScrollPos = { scrollTop: number; scrollHeight: number; clientHeight: number }

export const distanceFromBottom = (p: ScrollPos): number => p.scrollHeight - p.scrollTop - p.clientHeight

export const isAtBottom = (p: ScrollPos): boolean => distanceFromBottom(p) < BOTTOM_SLACK

/** `release`: the person scrolled up; `ignore`: already released */
export type FollowDecision = 'follow' | 'release' | 'ignore'

/**
 * After a size change, which can run before the scroll event of the person's move up, while the
 * flag still says follow: a fall of scrollTop is that move, but only with `touched`. Layout lowers
 * it too (a clamp, a row measuring under its guess): in WebKit an answer landing in one burst
 * lowered it 54px with no input, and reading that as the person stopped the list 914px short.
 */
export function decideFollow(p: {
  sticking: boolean
  scrollTop: number
  lastTop: number
  touched: boolean
}): FollowDecision {
  if (!p.sticking) return 'ignore'
  if (p.touched && p.scrollTop < p.lastTop - MOVED_UP_SLACK) return 'release'
  return 'follow'
}

/** Keyboard scrolling animates for a couple of hundred milliseconds after the key */
export const INPUT_GRACE_MS = 500

export const personIsScrolling = (p: { now: number; lastInputAt: number; held: boolean }): boolean =>
  p.held || p.now - p.lastInputAt < INPUT_GRACE_MS

/** ArrowUp includes ⌘↑ and ⌥↑ on a Mac; a key that scrolls down never lets go of the bottom */
export const isScrollUpKey = (e: { key: string; shiftKey: boolean }): boolean =>
  e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home' || (e.key === ' ' && e.shiftKey)

/**
 * Judged from a scroll event, which arrives a frame after the move: content can land between (a
 * 900px burst in WebKit), so while following it asks "did the view move up", not "is it at the
 * bottom". `lastTop` is the highest seen at the bottom, so a slow trackpad's pixel-a-step adds up
 * to a release; at the very end it is taken as is, as a clamp lowers the end itself. Any move up
 * lets go, input or not: unlike `decideFollow`, this has the move in hand.
 */
export function stickAfterScroll(p: {
  sticking: boolean
  lastTop: number
  pos: ScrollPos
}): { sticking: boolean; lastTop: number } {
  const top = p.pos.scrollTop
  if (isAtBottom(p.pos)) {
    const atEnd = distanceFromBottom(p.pos) <= 1
    return { sticking: true, lastTop: p.sticking && !atEnd ? Math.max(p.lastTop, top) : top }
  }
  if (p.sticking && top >= p.lastTop - MOVED_UP_SLACK) return { sticking: true, lastTop: Math.max(p.lastTop, top) }
  return { sticking: false, lastTop: top }
}

export type ScrollWriter = { scrollTop: number; scrollTo(options: ScrollToOptions): void }

/**
 * The virtual scroller's `scrollToFn`. tanstack-virtual compensates a row measured above the view
 * by writing its cached offset plus the change, and that cache is a frame stale after this view's
 * own write (measured in WebKit: view at 2350, cache 1436, row 860px taller, write to 2296, 54px up
 * from the end). So a compensation goes onto where the view is, and none while sticking: a clamp or
 * the follow effect keeps it at the end, and a written one read as the person scrolling up left it
 * 300px above the end (#424).
 */
export function writeScroll(
  el: ScrollWriter,
  offset: number,
  options: { adjustments?: number; behavior?: ScrollBehavior },
  sticking = false,
): void {
  if (options.adjustments && sticking) return
  const top = options.adjustments ? el.scrollTop + options.adjustments : offset
  el.scrollTo({ top, behavior: options.behavior })
}

/** The deferred frame's second follow, judged from the position then: the person may have scrolled up since */
export const shouldFollowAgain = (p: ScrollPos): boolean => distanceFromBottom(p) <= BOTTOM_SLACK

export type Measured = { index: number; start: number; end: number }

/**
 * The row at the top of the view and the offset into it (#61), or null when none is. A binary
 * search, as it runs on every scroll event.
 */
export function anchorAt(
  scrollTop: number,
  measurements: readonly Measured[],
  items: readonly { seq: number }[],
): { seq: number; offset: number } | null {
  let lo = 0
  let hi = measurements.length - 1
  let hit: Measured | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const m = measurements[mid]!
    if (m.end > scrollTop) {
      hit = m
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  const seq = hit ? items[hit.index]?.seq : undefined
  return seq === undefined ? null : { seq, offset: scrollTop - hit!.start }
}

/**
 * Row keys (`seq`) made unique (#64): React leaves the older node of a shared key behind, unowned,
 * and a virtual list remounts on every scroll (in WebKit one collision left a passage five times in
 * the DOM, and in a copy). The store should never share one (`rekeyAgainst`); this does not trust it.
 */
export function rowKeys(items: readonly { seq: number }[]): (number | string)[] {
  const seen = new Set<number>()
  return items.map((it, i) => {
    if (!seen.has(it.seq)) {
      seen.add(it.seq)
      return it.seq
    }
    return `${it.seq}@${i}`
  })
}

/**
 * docs/state-management.md §4 (#392). Runs on every change of the list, so it costs one comparison
 * until the cache holds more keys than the list has rows.
 */
export function forgetUnlistedSizes(sizes: Map<unknown, number>, keys: readonly unknown[]): void {
  if (sizes.size <= keys.length) return
  const listed = new Set(keys)
  for (const key of sizes.keys()) if (!listed.has(key)) sizes.delete(key)
}

export type LaidOutRow = { index: number; top: number; height: number }

/**
 * Whether the rows down to `index` lie as measured, so the aim will not move again (#61). Two equal
 * aims are not enough: a new height reaches the scroller a frame or more after layout, and in WebKit
 * the view showed two rows past the spot, then jumped back. Rows held outside the range (a kept
 * inline frame) are skipped; 1px slack, as heights are fractional and offsets are not.
 */
export function laidOutAsMeasured(rows: readonly LaidOutRow[], index: number, start: number): boolean {
  const above = rows.filter((r) => r.index <= index).sort((a, b) => a.index - b.index)
  const target = above[above.length - 1]
  if (!target || target.index !== index || Math.abs(target.top - start) > 1) return false
  for (let k = 0; k + 1 < above.length; k++) {
    const row = above[k]!
    const next = above[k + 1]!
    if (next.index !== row.index + 1) continue
    if (Math.abs(row.top + row.height - next.top) > 1) return false
  }
  return true
}
