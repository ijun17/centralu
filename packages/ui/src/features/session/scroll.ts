/**
 * Whether the conversation view keeps following the bottom.
 *
 * There is a reason this is pulled out of the DOM. While this judgment was tangled up with
 * rAF and ResizeObserver inside `ChatStream`, **a race was fixed but no regression test could
 * be written for it** — reproducing it depended on timing, so adding a wait made it break
 * against the pre-fix code too. Once the judgment alone is pulled out, that race reduces to
 * three plain values.
 */

/** Being this close counts as "at the bottom". It will never line up exactly to the pixel */
export const BOTTOM_SLACK = 80

/**
 * Scrolling up more than this is treated as the person having done it.
 * Not zero, because the browser's rounding jitters scrollTop by one or two pixels.
 */
export const MOVED_UP_SLACK = 4

export type ScrollPos = { scrollTop: number; scrollHeight: number; clientHeight: number }

export const distanceFromBottom = (p: ScrollPos): number => p.scrollHeight - p.scrollTop - p.clientHeight

export const isAtBottom = (p: ScrollPos): boolean => distanceFromBottom(p) < BOTTOM_SLACK

/**
 * What to do now that the content has changed.
 *
 * - `follow`  scroll down to the bottom
 * - `release` the person scrolled up — stop following
 * - `ignore`  already released
 */
export type FollowDecision = 'follow' | 'release' | 'ignore'

/**
 * **The flag alone cannot be trusted.**
 *
 * Scroll events are asynchronous. If the virtual scroller re-measures a row right after the
 * person scrolls up and the total height changes, "follow" can run before the scroll event is
 * processed. At that moment the flag is still true, so it dragged the person back down to the
 * bottom.
 *
 * Looking at position too removes that race: scrollTop stays put when content grows, but drops
 * when the person scrolls up.
 *
 * **But a drop is only the person's when the person did something** (`touched`, see
 * `personIsScrolling`). Layout drops scrollTop on its own: the browser clamps it when the
 * content shrinks under a view at the end, and a row measuring smaller than its guess does
 * exactly that. In WebKit a large answer landing in one burst dropped it 54px with no input on
 * the list at all; reading that as the person let go of the bottom, and the list stopped 914px
 * short of the answer's end. This branch only exists to catch the person's own scroll before
 * its event arrives — without their input there is nothing for it to catch, so it follows.
 * The scroll event itself is still judged by `stickAfterScroll`, input or not.
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

/**
 * How long after the person's last input a drop in scrollTop can still be theirs.
 *
 * Keyboard scrolling animates for a couple of hundred milliseconds after the key, and the
 * follow effect can run between any of those frames and the scroll event each one fires.
 * A held pointer or finger counts for as long as it is held, on top of this.
 */
export const INPUT_GRACE_MS = 500

/** Whether the person is, or was a moment ago, moving the list themselves */
export const personIsScrolling = (p: { now: number; lastInputAt: number; held: boolean }): boolean =>
  p.held || p.now - p.lastInputAt < INPUT_GRACE_MS

/**
 * Keys that scroll a list up: PageUp, ArrowUp (also ⌘↑ and ⌥↑ on a Mac), Home, Shift+Space.
 *
 * Only these count — a key that scrolls down is never a reason to let go of the bottom.
 */
export const isScrollUpKey = (e: { key: string; shiftKey: boolean }): boolean =>
  e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home' || (e.key === ' ' && e.shiftKey)

/**
 * Whether the list still follows the bottom, judged from a scroll event.
 *
 * **A scroll event reports a move that already happened, against the content as it is now.**
 * The event fires a frame after the move, and content can land in between: following wrote
 * scrollTop to the end, a burst of answer grew the list by 900px, and only then did the event
 * arrive — reading "not at the bottom" there let go of a view that had never moved (seen in
 * WebKit, the same burst as in `decideFollow`). So while following, the question is not "is it
 * at the bottom now" but "did the view move up from where it was at the bottom".
 *
 * `lastTop` while following is the highest scrollTop seen at the bottom, not the last one seen.
 * Inside `BOTTOM_SLACK` the view still counts as at the bottom, so a slow trackpad moving up a
 * pixel or two per event would otherwise reset the reference on every event and never add up to
 * a release. At the very end the current scrollTop is taken as is: a browser clamp after the
 * content shrank lowers the end itself.
 *
 * Anything else that moves the view up — a wheel, a key, the scrollbar, a script — still lets go,
 * input or not: unlike `decideFollow`, this has the move itself in hand, not a guess at it.
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

/** The part of a scroll element the virtual scroller's writes go through */
export type ScrollWriter = { scrollTop: number; scrollTo(options: ScrollToOptions): void }

/**
 * Every scroll write the conversation's virtual scroller makes (its `scrollToFn`).
 *
 * When a row above the top of the view is measured, tanstack-virtual compensates by the size
 * change so the view holds still — but it writes **its cached offset plus the change**, and
 * that offset is the one from the last scroll event it saw. Right after this view's own write
 * (landing, following) the event has not been dispatched yet, so the cache is a frame stale and
 * the "compensation" puts the view somewhere it never was. Measured in WebKit: following had put
 * the view at the end (2350), the cache still said 1436, the answer row measured 860px taller,
 * and the write landed on 2296 — 54px up from the end, a scroll nobody made, which the follow
 * logic then read as the person scrolling up.
 *
 * So a compensation (`adjustments` set) is applied to where the view **is**, not to where the
 * scroller last saw it. Every other write (scrollToIndex, scrollToOffset, the initial sync)
 * carries an absolute target and goes through unchanged.
 *
 * And while the view sticks to the end (`sticking`), no compensation is written at all: a row
 * above changing size leaves the view at the end. A shorter list clamps it to the new end, and
 * the follow effect follows a longer one. Written, the compensation moved the view up and the
 * next scroll event read that as the person scrolling up, so it stopped following. WebKit
 * measures rows a few frames after a jump to the end, and the view came to rest 300px above it
 * (#424).
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

/**
 * Whether to scroll down once more on the deferred frame.
 *
 * A new row is only measured on the next frame, so scrolling down using the previous height
 * falls a few pixels short. But the person may have scrolled up in the meantime, so this
 * **re-measures the position at that moment** to decide — using the judgment made when the
 * frame was scheduled would override the person.
 */
export const shouldFollowAgain = (p: ScrollPos): boolean => distanceFromBottom(p) <= BOTTOM_SLACK

/** One row measured by the virtual scroller (the part of tanstack's measurementsCache entry used here) */
export type Measured = { index: number; start: number; end: number }

/**
 * The row currently touching the top of the screen, and how far into it the view sits (#61).
 *
 * **This conversion exists to remember a row, not a pixel offset.** A raw scrollTop points
 * somewhere else the next time around, on a virtual scroller that has not finished measuring
 * — once the rows above it switch from the 64px estimate to their real height, the same number
 * lands in a different spot. `seq` is independent of measurement, so it still points to the
 * same row after re-measuring, and only the remaining few pixels need to be reconciled once
 * they arrive.
 *
 * Why binary search: this is called on every scroll event. As the conversation grows longer, a
 * linear scan makes scrolling heavy, and that has already burned battery life once before.
 *
 * When no row touches the top (an empty conversation, nothing measured yet), this returns null
 * — meaning there is no place to remember.
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
    // The criterion is `end`: the first row whose end goes past scrollTop is the one touching
    // the top of the screen
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
 * The virtual list's row keys: each row's render key (`seq`), made unique (#64).
 *
 * React builds a row's DOM node once per key. When two rows of one list share a key, the older
 * node is neither reused nor removed when the rows change: it stays in the list, unowned, at the
 * spot it was last placed. In a virtual list rows mount and unmount on every scroll, so one
 * shared key leaves a copy behind each time — measured in WebKit: one collision, scrolled through
 * once, left the same passage five times in the DOM, and selecting and copying the region gave it
 * back five times, as the person reported. The store is meant never to produce a shared key
 * (`rekeyAgainst`), but a slip there must not turn into copies on screen, so the list does not
 * trust it: the first row keeps its key and a later row with the same one gets a string key of its
 * own, which no number equals.
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
 * Forgets the measured heights of rows the list no longer holds (#392).
 *
 * The virtual list keeps a height per row key it has ever measured, and nothing in it removes
 * one: a key that leaves the list (an off-screen session cut back to its window, the rows of the
 * session the focus view showed before) stays in its cache for as long as the pane is mounted. The
 * focus view's pane is one instance for every session it shows, so over days it held a height for
 * every row it had ever shown. Only keys still in the list are kept, so the cache is never larger
 * than the list itself. A row that comes back is measured again, as on its first showing.
 *
 * Runs on every change of the list, so it does nothing until the cache holds more keys than the
 * list has rows: up to that count it is already no larger than the list, and the check costs one
 * comparison per streamed event rather than a pass over the cache.
 */
export function forgetUnlistedSizes(sizes: Map<unknown, number>, keys: readonly unknown[]): void {
  if (sizes.size <= keys.length) return
  const listed = new Set(keys)
  for (const key of sizes.keys()) if (!listed.has(key)) sizes.delete(key)
}
