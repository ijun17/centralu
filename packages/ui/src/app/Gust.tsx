import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/store.js'

/** Must match cc-gust in the CSS */
const GUST_MS = 1100

/** Leaves the DOM once it passes: a transparent full-screen layer left behind ends up covering something */
export function Gust() {
  // Only the timestamp: the store judged visibility when the session finished. Reading screen state here would blow a
  // gust when a session that finished earlier comes into view
  const at = useStore((s) => s.completion?.at ?? null)
  const [blowing, setBlowing] = useState<number | null>(null)
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
      {/* key: when the same session finishes back to back, the animation
          restarts */}
      <div key={blowing} className="cc-gust" />
    </div>
  )
}
