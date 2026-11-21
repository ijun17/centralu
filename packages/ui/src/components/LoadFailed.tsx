import { useRef } from 'react'
import { Fold } from './Fold.jsx'

/**
 * What a list shows when reading it failed (#850 item 8): what, why, and Retry, where its "empty" line would be. A
 * failed read drawn as empty ("No changes") says there is nothing when nobody answered. `className` places it.
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
 * `LoadFailed` for a list that can fail and recover on screen (a search): it folds in and out
 * (docs/design-system.md §9), keeping the last reason for its exit so the words do not blank while it leaves.
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
