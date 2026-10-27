import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { LEAVE_MS, usePresence } from './presence.js'

/** How long an entrance takes: `.cc-fold`'s transition in styles/index.css lasts 180ms; the clip stays on a little past it */
const FOLD_IN_MS = 200

/**
 * A list that opens downward and closes back up (#1605, owner 2026-10-26): a project's rows, the orchestrator's children.
 * One way for every fold of the sidebar, so none keeps its own timer or its own keyframes.
 *
 * It is a transition of the grid track (`0fr` to `1fr`, index.css `.cc-fold`), not a keyframe animation: a fold that is
 * reversed half way (the pointer comes back while it closes) goes from where it is instead of starting over, and what is
 * under it moves with it rather than jumping. The rows inside do not travel: they are uncovered, so a row under the pointer
 * stays where it is and can be pressed while the list moves.
 *
 * The rows stay in the DOM until the exit ends (`usePresence`), so a close does not blink. With reduced motion the track
 * does not move: the rows fade in and fade out in place.
 *
 * `instant` is for a fold that is being set up, not changed (the sidebar before the saved folds are read): it neither
 * slides nor waits, so the window does not open with every folded project closing.
 *
 * A list on its way out takes no presses and no focus (`inert`, as a layer's exit does): the rows are still there only so
 * that the close does not blink, and a menu or a drag begun on one would be taken away with it.
 *
 * The content is clipped only while it moves: a focus ring or a drop line at the edge of a row is not cut off at rest.
 * `data-fold` says where it is (`opening`, `open`, `closing`), for tests that wait on the end state instead of on time.
 */
export function Fold({ open, children, className, testId, instant }: { open: boolean; children: ReactNode; className?: string; testId?: string; instant?: boolean }) {
  const { shown } = usePresence(open, instant ? 0 : LEAVE_MS)
  const ref = useRef<HTMLDivElement>(null)
  // Drawn at full height: false in the first frame of an entrance (the start of the transition), true from then on
  const [expanded, setExpanded] = useState(open)
  // And the entrance is over: the clip comes off
  const [settled, setSettled] = useState(open)
  // Decided while rendering, like `usePresence`: a list that came back after its exit starts again from closed
  if (!shown && expanded) setExpanded(false)
  if (!open && settled) setSettled(false)

  useLayoutEffect(() => {
    if (!open || expanded) return
    // The closed style has to be computed once before the open one is set, or there is nothing to transition from
    void ref.current?.offsetHeight
    setExpanded(true)
  }, [open, expanded])
  useEffect(() => {
    if (!open || !expanded || settled) return
    const t = setTimeout(() => setSettled(true), FOLD_IN_MS)
    return () => clearTimeout(t)
  }, [open, expanded, settled])

  if (!shown) return null
  const drawn = open && expanded
  return (
    <div ref={ref} className={instant ? 'cc-fold cc-fold-instant' : 'cc-fold'} inert={!open} data-drawn={drawn || undefined} data-fold={!open ? 'closing' : settled ? 'open' : 'opening'} data-testid={testId}>
      {/* The padding is on the inner box: a clipped box keeps its own padding when the track is empty, and the list would stop 6px short of closed */}
      <div className={`min-h-0 min-w-0 ${open && settled ? '' : 'overflow-hidden'}`}>
        <div className={className}>{children}</div>
      </div>
    </div>
  )
}
