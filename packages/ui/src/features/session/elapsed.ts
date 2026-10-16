import { useCallback, useEffect, useState, type RefObject } from 'react'
import { formatDuration } from '../../app/format.js'
import { useLabelNow } from '../../app/useLabelNow.js'

/**
 * The elapsed time on the activity row, and the clock that makes it move (#23, #364).
 *
 * **Each repaint of the counter costs memory while a session works.** Measured on 2026-10-06 against the owner-sized
 * store in WebKit (docs/spikes/2026-10-memory-heavy-store.md §3): with the count re-rendered once a second, WebKit's
 * GPU process held ~190 MB for the whole of a working turn; with it re-rendered every ten minutes, ~100 MB, the
 * pulsing dot still running. Animations run on the compositor and do not repaint; a changed number
 * does, and WebKit keeps the window's backing stores while it repaints, letting them go within a few seconds of the
 * last repaint. Giving the number its own compositing layer did not help (189 MB against 191); re-rendering it every
 * 5, 10 or 30 seconds did (84–110, 109–193 and 79–106 MB at the 60 s and 120 s samples, the high one caught just
 * after a repaint). So the repaints themselves have to be fewer, and a few seconds apart is enough.
 *
 * So the number moves in steps that grow with it: by the second for the first ten seconds, when a turn has just
 * begun; by five seconds up to a minute; by ten seconds up to ten minutes; by the minute after that, and by the hour beyond a day. "3s", "30s" and
 * "3m" stay different kinds of waiting. The text shows only what the step can say ("35s", "4m 20s", "12m"), so it is
 * never a number that has stopped while looking precise. That the turn is alive is said by the pulsing dot, which
 * costs no repaint.
 *
 * And the shared clock does not run while the window is hidden, and moves at most by the minute while
 * the row is scrolled out of view. Coming back shows the current value at once.
 */

/** Below each bound (seconds), the count moves by that many seconds */
const STEPS: readonly { below: number; step: number }[] = [
  { below: 10, step: 1 },
  { below: 60, step: 5 },
  { below: 600, step: 10 },
  { below: 86400, step: 60 },
  { below: Infinity, step: 3600 },
]

/** How many seconds one step of the count is at `seconds` elapsed */
export function elapsedStep(seconds: number): number {
  return STEPS.find((s) => seconds < s.below)!.step
}

export function formatElapsed(seconds: number): string {
  // What is shown is the start of the step the count is in (`STEPS`), so it never claims more than it knows
  const step = elapsedStep(seconds)
  const shown = Math.floor(seconds / step) * step
  return shown === 0 ? '0s' : formatDuration(shown * 1000)
}

/** Re-read at the next displayed step from the turn's own start instant. */
export function nextElapsedTick(startedAt: number, now: number, coarse = false): number {
  const elapsed = Math.max(0, now - startedAt)
  const seconds = Math.floor(elapsed / 1000)
  const step = Math.max(coarse ? 60 : 0, elapsedStep(seconds)) * 1000
  return step - elapsed % step
}

/** The activity row shares the label clock, retaining its measured short-turn cadence. */
export function useElapsedNow(startedAt: number | null, target: RefObject<Element | null>): number {
  const [offscreen, setOffscreen] = useState(false)
  useEffect(() => {
    const el = target.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1]
      if (last) setOffscreen(!last.isIntersecting)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [target])
  const next = useCallback(
    (now: number) => startedAt === null ? null : nextElapsedTick(startedAt, now, offscreen),
    [startedAt, offscreen],
  )
  return useLabelNow(startedAt === null ? null : next)
}
