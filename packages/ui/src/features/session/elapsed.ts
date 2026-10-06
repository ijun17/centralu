import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * The elapsed time on the activity row, and the clock that makes it move (#23, #364).
 *
 * **Each repaint of the counter costs memory while a session works.** Measured on 2026-10-06 against the owner-sized
 * store in WebKit (docs/spikes/2026-10-memory-heavy-store.md §3): with the count re-rendered once a second, WebKit's
 * GPU process held ~190 MB for the whole of a working turn; with it re-rendered every ten minutes, ~100 MB, the
 * pulsing dot and the orbit still running. Animations run on the compositor and do not repaint; a changed number
 * does, and WebKit keeps the window's backing stores while it repaints, letting them go within a few seconds of the
 * last repaint. Giving the number its own compositing layer did not help (189 MB against 191); re-rendering it every
 * 5, 10 or 30 seconds did (84–110, 109–193 and 79–106 MB at the 60 s and 120 s samples, the high one caught just
 * after a repaint). So the repaints themselves have to be fewer, and a few seconds apart is enough.
 *
 * So the number moves in steps that grow with it: by the second for the first ten seconds, when a turn has just
 * begun; by five seconds up to a minute; by ten seconds up to ten minutes; by the minute after that. "3s", "30s" and
 * "3m" stay different kinds of waiting. The text shows only what the step can say ("35s", "4m 20s", "12m"), so it is
 * never a number that has stopped while looking precise. That the turn is alive is said by the pulsing dot, which
 * costs no repaint.
 *
 * And the clock does not run where nobody can see it: not while the window is hidden, and only by the minute while
 * the row is scrolled out of view. Coming back shows the current value at once.
 */

/** Below each bound (seconds), the count moves by that many seconds */
const STEPS: readonly { below: number; step: number }[] = [
  { below: 10, step: 1 },
  { below: 60, step: 5 },
  { below: 600, step: 10 },
  { below: Infinity, step: 60 },
]

/** How many seconds one step of the count is at `seconds` elapsed */
export function elapsedStep(seconds: number): number {
  return STEPS.find((s) => seconds < s.below)!.step
}

export function formatElapsed(seconds: number): string {
  if (seconds < 10) return `${seconds}s`
  if (seconds < 60) return `${Math.floor(seconds / 5) * 5}s`
  const min = Math.floor(seconds / 60)
  if (seconds < 600) return `${min}m ${Math.floor((seconds % 60) / 10) * 10}s`
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

/**
 * Milliseconds from `now` until the shown count next changes, for a turn that began at `startedAt`. With `coarse`,
 * until the next whole minute: the pace while the row is out of view.
 */
export function msUntilNextStep(startedAt: number, now: number, coarse = false): number {
  const ms = Math.max(0, now - startedAt)
  const step = (coarse ? 60 : elapsedStep(Math.floor(ms / 1000))) * 1000
  return (Math.floor(ms / step) + 1) * step - ms
}

/**
 * Re-reads the clock when the shown count would change, and only when it can be seen.
 *
 * Framework-free so the cadence can be tested with fake timers; `useElapsed` (ActivityRow) drives it from React. The
 * instant a turn began lives on the store (`workingSince`); this only says when to look at the time again.
 */
export class ElapsedClock {
  private timer: ReturnType<typeof setTimeout> | null = null
  private startedAt: number | null = null
  private hidden = false
  private offscreen = false

  constructor(private readonly onTick: () => void) {}

  /** Starts, moves or stops the clock. A view that comes back (shown, or scrolled into view) ticks at once */
  update(next: { startedAt: number | null; hidden: boolean; offscreen: boolean }): void {
    const cameBack = (this.hidden && !next.hidden) || (this.offscreen && !next.offscreen)
    const changed =
      next.startedAt !== this.startedAt || next.hidden !== this.hidden || next.offscreen !== this.offscreen
    this.startedAt = next.startedAt
    this.hidden = next.hidden
    this.offscreen = next.offscreen
    if (!changed) return
    if (cameBack && !next.hidden && next.startedAt !== null) this.onTick()
    this.schedule()
  }

  dispose(): void {
    this.clear()
    this.startedAt = null
  }

  private schedule(): void {
    this.clear()
    const startedAt = this.startedAt
    if (startedAt === null || this.hidden) return
    /*
     * Out of view it still moves, by the minute: WKWebView has missed IntersectionObserver callbacks before (the
     * history loader, 2026-09-04), and a row that never heard it came back would show a stale count. Off screen the
     * change paints nothing; at worst a minute is lost.
     */
    // A few ms past the boundary, so the floor of the new reading lands on the new step and not just short of it
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.onTick()
        this.schedule()
      },
      msUntilNextStep(startedAt, Date.now(), this.offscreen) + 5,
    )
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}

/**
 * The current time for `startedAt`'s count, re-read by an `ElapsedClock`: paused while the window is hidden, and by
 * the minute while `target` is scrolled out of view.
 */
export function useElapsedNow(startedAt: number | null, target: RefObject<Element | null>): number {
  const [now, setNow] = useState(() => Date.now())
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden')
  const [offscreen, setOffscreen] = useState(false)
  const clock = useRef<ElapsedClock | null>(null)

  useEffect(() => {
    const c = new ElapsedClock(() => setNow(Date.now()))
    clock.current = c
    return () => {
      c.dispose()
      clock.current = null
    }
  }, [])

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

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

  useEffect(() => {
    clock.current?.update({ startedAt, hidden, offscreen })
  }, [startedAt, hidden, offscreen])

  return now
}
