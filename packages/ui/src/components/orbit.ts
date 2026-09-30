import { useEffect } from 'react'

/** The rotating orbit from styles/index.css. This is the one place its name is known as a string */
const ORBIT = 'cc-orbit-spin'

/**
 * Everything that spins watches one clock.
 *
 * The sidebar marker and the grid panel border rotate the same orbit at the same 1.4 seconds.
 * And yet they showed up on screen at different speeds — not the period, the phase, that
 * differed. A CSS animation counts from the moment the element is created, so if a session is
 * spinning and then moves into the grid, the panel's orbit starts counting from 0 all over
 * again. Measured, that was 758ms apart — nearly opposite (195° of a 1.4s period). The eye reads
 * two things being out of sync, but it does not read "different phase" — it just sees them as
 * unrelated.
 *
 * So each one's own starting point is discarded, and it is pinned instead to the origin of the
 * document's clock. Regardless of when it was created, the angle becomes `(now % 1.4s)`, and it
 * stays in step from then on.
 *
 * A CSS-only approach was measured first, and dropped. Making `--cc-orbit` inheritable and
 * rotating it once at the root would finish the code in three lines, but an inheritable custom
 * property changing every frame forces the whole tree to recalculate. At around 120,000 nodes
 * (roughly what one long conversation reaches), the frame time doubled from 16.7ms to 34.1ms.
 * The conversation cannot be run at half speed just to keep one spinning marker in sync. This
 * approach only does work at the moment state changes, and does nothing at all per frame.
 */
export function syncOrbits(): void {
  // jsdom does not have this API — a unit test sometimes renders without a screen
  if (typeof document === 'undefined' || typeof document.getAnimations !== 'function') return
  for (const anim of document.getAnimations()) {
    if ((anim as CSSAnimation).animationName !== ORBIT) continue
    // Leaves one already in sync untouched — resetting it again would cause a single jump on that frame
    if (anim.startTime !== 0) anim.startTime = 0
  }
}

/**
 * Syncs everything spinning to the same angle whenever a new one appears.
 *
 * `key` only needs to be a value that represents "what is currently spinning" — the moment it
 * changes is the moment a new orbit is created. Mounting counts as that moment too (when
 * something is already spinning on the first render).
 */
export function useOrbitSync(key: string | boolean): void {
  useEffect(() => {
    if (!key) return
    syncOrbits()
  }, [key])
}
