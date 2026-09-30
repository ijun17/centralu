import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/store.js'

/** How long the gust takes to pass (must match cc-gust in the CSS — it is removed from the DOM
 * once it ends) */
const GUST_MS = 1100

/**
 * A single gust that tells the body, not the eye, that a response has finished.
 *
 * Instead of writing "finished" in text, the screen takes one breath. It can be noticed without
 * being read, and since it leaves nothing behind once it passes, it does not clutter the screen.
 *
 * It is removed from the DOM once it passes. Leaving it transparent would mean an element
 * covering the whole screen is always floating there — harmless right now since it has no
 * pointer-events, but something left lingering like that ends up covering something eventually.
 */
export function Gust() {
  /*
   * Only one thing is watched: the completion timestamp.
   *
   * Whether it is "visible" is not decided here — the store already made that call at the exact
   * moment completion happened. Multiplying that judgment here as well would make the answer true
   * again at the moment a session becomes visible after switching, blowing a gust when nothing
   * new actually finished. Not putting screen state in the dependency list is the whole point of
   * this component.
   */
  const at = useStore((s) => s.completion?.at ?? null)
  const [blowing, setBlowing] = useState<number | null>(null)
  /** A timestamp that already blew does not blow again — one gust per event */
  const blown = useRef<number | null>(null)

  useEffect(() => {
    if (at === null || blown.current === at) return
    blown.current = at
    setBlowing(at)
    const t = setTimeout(() => setBlowing(null), GUST_MS)
    return () => clearTimeout(t)
  }, [at])

  if (blowing === null) return null
  return (
    <div
      className="pointer-events-none fixed inset-0 z-50 overflow-hidden"
      data-testid="gust"
      aria-hidden
    >
      {/* key: even when the same session finishes back to back, the animation restarts from the
          beginning */}
      <div key={blowing} className="cc-gust" />
    </div>
  )
}
