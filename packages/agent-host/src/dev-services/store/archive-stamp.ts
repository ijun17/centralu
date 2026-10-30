/**
 * How far ahead of the clock the latest archive stamp may be and still be stepped above. Stamps run a few
 * milliseconds ahead of the clock only through this very rule (a burst of archivings, a project's sessions), so a
 * stamp further ahead than this comes from a clock that was wrong once: stepping above it would pin every later
 * archiving to that wrong time until the real time caught up.
 */
export const STAMP_AHEAD_WINDOW_MS = 60_000

/**
 * The time to stamp an archiving at: `now`, or one millisecond above `last` (the latest stamp so far) when that is not
 * earlier than `now`, so that archivings in one millisecond do not tie. A `last` more than the window ahead of `now`
 * is ignored: the stamp is `now`, and the list falls back to its row-order tiebreak for the rest.
 */
export function stampAfter(last: number | null, now: number): number {
  return last !== null && last >= now && last - now < STAMP_AHEAD_WINDOW_MS ? last + 1 : now
}
