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
