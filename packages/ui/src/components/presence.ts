import { useEffect, useState } from 'react'

/** How long a layer takes to leave: the exit animations in styles/index.css (cc-drop-out, cc-fade-out) last this long */
export const LEAVE_MS = 150

/**
 * Keeps a layer on screen for its exit animation after it is closed (owner, 2026-10-18: the palette, settings and the
 * top bar's dropdowns come and go smoothly, not cut off).
 *
 * `shown` is whether to render at all: true while open, and for `ms` after it closes. `leaving` is true in that tail,
 * for the exit class and to stop the layer taking presses while it fades. One rule for every layer, so none of them
 * keeps its own timer (the run window's did, CommandRunner).
 *
 * A timer, not animationend: with reduced motion there is no animation to end, and the layer must still go.
 */
export function usePresence(open: boolean, ms = LEAVE_MS): { shown: boolean; leaving: boolean } {
  /*
   * Decided while rendering, not in an effect: an effect runs after the frame that closed the layer, so that frame drew
   * nothing and the next one drew the layer again for its exit, a blink (owner, 2026-10-18, the palette). React's
   * "state from the previous props" pattern: the render that sees `open` turn false already says `leaving`.
   */
  const [prev, setPrev] = useState(open)
  const [leaving, setLeaving] = useState(false)
  if (prev !== open) {
    setPrev(open)
    setLeaving(!open)
  }
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => setLeaving(false), ms)
    return () => clearTimeout(t)
  }, [leaving, ms])
  return { shown: open || leaving, leaving: !open && leaving }
}
