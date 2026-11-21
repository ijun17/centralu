import { useCallback, useEffect, useState, type RefObject } from 'react'
import { formatDuration } from '../../app/format.js'
import { useLabelNow } from '../../app/useLabelNow.js'

/**
 * The activity row's elapsed time and its clock (#23, #364): a repaint every second held WebKit's GPU process at ~190 MB
 * against ~100 (docs/spikes/2026-10-memory-heavy-store.md §3, §9; its own layer did not help), so it moves in steps.
 */

/**
 * Below each bound (seconds) the count moves by that step and shows only what the step can say ("35s", "4m 20s"). The
 * clock stops while the window is hidden and moves by the minute while the row is out of view; the dot shows life.
 */
const STEPS: readonly { below: number; step: number }[] = [
  { below: 10, step: 1 },
  { below: 60, step: 5 },
  { below: 600, step: 10 },
  { below: 86400, step: 60 },
  { below: Infinity, step: 3600 },
]

export function elapsedStep(seconds: number): number {
  return STEPS.find((s) => seconds < s.below)!.step
}

export function formatElapsed(seconds: number): string {
  // The start of its step, never more than it knows
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
