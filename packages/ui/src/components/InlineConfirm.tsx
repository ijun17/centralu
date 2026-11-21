import { Button } from './Button.jsx'

/**
 * An action that asks first, where it was pressed (#428; docs/design-system.md §11): a sentence, Cancel, then the
 * action, disabled while `busy`. `tone="danger"` for what cannot be taken back. `inline`: no box, the question and
 * buttons run on in a row, `text` a word or two ("Remove?"). `testId` names the box (the question, when inline); the
 * buttons are `${testId}-yes` and `${testId}-no` unless named.
 */
export function InlineConfirm({
  text,
  yesLabel,
  noLabel = 'Cancel',
  tone = 'neutral',
  busy = false,
  inline = false,
  onYes,
  onNo,
  testId,
  yesTestId = testId && `${testId}-yes`,
  noTestId = testId && `${testId}-no`,
  textTestId,
}: {
  text: string
  yesLabel: string
  noLabel?: string
  tone?: 'neutral' | 'danger'
  /** The action is running: a second press would start the same change twice */
  busy?: boolean
  inline?: boolean
  onYes: () => void
  onNo: () => void
  testId?: string
  yesTestId?: string
  noTestId?: string
  /** The sentence itself, when a test reads it apart from the buttons */
  textTestId?: string
}) {
  // Inline, the two run on as words in a line of text: no frame, no padding
  const noButton = inline ? (
    <button type="button" className="text-xs text-ink-faint hover:text-ink" onClick={onNo} data-testid={noTestId}>
      {noLabel}
    </button>
  ) : (
    <Button variant="ghost" size="sm" onClick={onNo} data-testid={noTestId}>
      {noLabel}
    </Button>
  )
  const yesButton = inline ? (
    <button type="button" className="text-xs text-danger hover:text-ink disabled:opacity-50" disabled={busy} onClick={onYes} data-testid={yesTestId}>
      {yesLabel}
    </button>
  ) : (
    <Button variant={tone === 'danger' ? 'danger' : 'primary'} size="sm" disabled={busy} onClick={onYes} data-testid={yesTestId}>
      {yesLabel}
    </Button>
  )
  if (inline) {
    return (
      <>
        <span className="text-xs text-ink-muted" data-testid={textTestId ?? testId}>
          {text}
        </span>
        {noButton}
        {yesButton}
      </>
    )
  }
  return (
    <div
      className={`mt-2 rounded-md border px-2.5 py-2 ${tone === 'danger' ? 'border-danger bg-danger-bg' : 'border-line bg-surface-floor'}`}
      data-testid={testId}
    >
      <p className="text-xs leading-body text-ink" data-testid={textTestId}>
        {text}
      </p>
      <div className="mt-2 flex justify-end gap-2">
        {noButton}
        {yesButton}
      </div>
    </div>
  )
}
