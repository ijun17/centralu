import { useRef } from 'react'
import { Fold } from './Fold.jsx'

/**
 * The linked machines whose part of a merged list the hub could not read just now (the session archive, #841 item 4; Tasks, #2268): without this
 * line the list read as the whole of it, and what a machine still holds looked gone. It folds in and out as a change on screen does (design-system
 * §9), keeping the last names for its exit. `className` places it; the look is this one
 */
export function Unreached({ what, unreached, className, testId }: { what: string; unreached?: readonly { name: string }[]; className?: string; testId: string }) {
  const last = useRef('')
  const open = (unreached?.length ?? 0) > 0
  if (open && unreached) last.current = unreached.map((m) => m.name).join(', ')
  return (
    <Fold open={open} className={className}>
      <p className="text-sm text-ink" data-testid={testId}>
        Not listed: {what} on {last.current}, which could not be reached just now.
      </p>
    </Fold>
  )
}
