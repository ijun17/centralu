import { useRef } from 'react'
import { Fold } from './Fold.jsx'

/**
 * The line a list shows when reading it failed (#850 item 8): what could not be read, why, and a way to ask again.
 *
 * It stands where the list's "empty" line would. A failed read used to be drawn as an empty list ("No changes", "No
 * commits yet", "No saved rules"), which says something false: that there is nothing, when nobody answered.
 * `className` places it (the list's own padding); the colour and size are this component's.
 */
export function LoadFailed({
  what,
  error,
  onRetry,
  className = '',
  testId,
}: {
  /** What was being read, as it ends "Could not read …" */
  what: string
  error: string
  onRetry?: () => void
  className?: string
  testId?: string
}) {
  return (
    <p className={`text-xs leading-body text-danger ${className}`} role="alert" data-testid={testId}>
      Could not read {what}: {error}
      {onRetry && (
        <>
          {' '}
          <button
            type="button"
            className="text-ink-faint underline-offset-2 hover:text-ink hover:underline"
            onClick={onRetry}
            data-testid={testId && `${testId}-retry`}
          >
            Retry
          </button>
        </>
      )}
    </p>
  )
}

/**
 * `LoadFailed` for a list that can fail and recover while it is on screen (a search, a history): the line folds in when
 * a read fails and folds out when the next one works, as a change on screen does (design-system §9). It keeps the last
 * reason for its exit, so the words do not blank while it leaves.
 */
export function LoadFailedFold({ error, ...rest }: { what: string; error: string | null; onRetry?: () => void; className?: string; testId?: string }) {
  const last = useRef('')
  if (error !== null) last.current = error
  return (
    <Fold open={error !== null}>
      <LoadFailed {...rest} error={last.current} />
    </Fold>
  )
}
