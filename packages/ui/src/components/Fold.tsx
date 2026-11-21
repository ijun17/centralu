import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { LEAVE_MS, usePresence } from './presence.js'

/** How long an entrance takes: `.cc-fold`'s transition in styles/index.css lasts 180ms; the clip stays on a little past it */
const FOLD_IN_MS = 200

/**
 * A list that opens downward and closes back up, the one fold of the sidebar (docs/design-system.md §9): a transition of
 * the grid track (`.cc-fold`), so a fold reversed half way goes on from where it is; the rows are uncovered, not moved.
 *
 * `instant` is for a fold being set up, not changed (before the saved folds are read): no slide and no `closing` state,
 * so the window does not open with every folded project closing. A closing list is `inert`: a menu or drag begun on a
 * row would be taken away with it. The content is clipped only while it moves, so a focus ring at the edge shows at
 * rest. `data-fold` (`opening`, `open`, `closing`) is for tests that wait on the end state.
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
  // A layout effect, as usePresence's: `data-fold` never says `opening` without its end scheduled
  useLayoutEffect(() => {
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
