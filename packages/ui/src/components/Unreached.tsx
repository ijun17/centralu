import { useRef } from 'react'
import { Fold } from './Fold.jsx'

/**
 * The linked machines a merged list could not include just now (#841 item 4, #2268), so the list is not read as the
 * whole and what a machine holds does not look gone. Keeps the last names for its exit. `className` places it.
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
