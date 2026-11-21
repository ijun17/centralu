import { useLayoutEffect, useState } from 'react'

/** How long a layer takes to leave: the exit animations in styles/index.css (cc-drop-out, cc-fade-out) last this long */
export const LEAVE_MS = 150

/**
 * Keeps a layer on screen for its exit (docs/design-system.md §9): `shown` is true while open and for `ms`
 * after, `leaving` in that tail (the exit class, no presses). A timer, not animationend: with reduced motion there is no
 * animation to end. With `ms` 0 `shown` follows `open` in the same render; a zero-length timer would still be a timer,
 * and whether it ran when something looks (a test on a paused clock, a slow frame) is not up to the layer.
 */
export function usePresence(open: boolean, ms = LEAVE_MS): { shown: boolean; leaving: boolean } {
  // React's "state from the previous props": the render that sees `open` turn false already says `leaving` (§9)
  const [prev, setPrev] = useState(open)
  const [leaving, setLeaving] = useState(false)
  if (prev !== open) {
    setPrev(open)
    setLeaving(!open && ms > 0)
  }
  // A layout effect, so the timer exists in the commit that shows the exit: nothing can see `leaving` without the timer already running
  useLayoutEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => setLeaving(false), ms)
    return () => clearTimeout(t)
  }, [leaving, ms])
  return { shown: open || leaving, leaving: !open && leaving }
}

/**
 * What a layer last said, for the frames it fades out in once it has nothing to say (`usePresence` keeps it on screen, this keeps its
 * content): `value` while it is there, else the last one that was. Decided while rendering, as usePresence, so the frame that loses the
 * value still draws it.
 */
export function useHeld<T>(value: T | null | undefined): T | null {
  const [held, setHeld] = useState<T | null>(value ?? null)
  if (value != null && value !== held) setHeld(value)
  return value ?? held
}
