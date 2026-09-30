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
 */
export function decideFollow(p: { sticking: boolean; scrollTop: number; lastTop: number }): FollowDecision {
  if (!p.sticking) return 'ignore'
  if (p.scrollTop < p.lastTop - MOVED_UP_SLACK) return 'release'
  return 'follow'
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
