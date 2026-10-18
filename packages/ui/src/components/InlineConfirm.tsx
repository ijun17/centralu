import { Button } from './Button.jsx'

/**
 * An action that asks first, in the place where it was pressed (#428): a sentence, then Cancel and the action.
 *
 * Four screens had their own: the trash's "Delete for good", an app's "Remove", a machine's "Remove?" and the stop
 * confirmation before an update. They put the buttons in two orders (the action first on two of them), and two let the
 * action be pressed again while it ran. One component: Cancel first, then the action, which is disabled while `busy`
 * (a second press would start the same change twice).
 *
 * - `tone="danger"`: for what cannot be taken back; the box and the action wear the danger colour.
 * - `inline`: no box, the question and its two buttons run on in a row (a machine's line in Settings → Machines),
 *   where `text` is a word or two ("Remove?").
 *
 * `testId` names the box (the question, when inline); the buttons are `${testId}-yes` and `${testId}-no` unless named.
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
  /** The action is running: it cannot be pressed again */
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
      className={`mt-2 rounded-md border px-2.5 py-2 ${tone === 'danger' ? 'border-danger/40 bg-danger-bg' : 'border-line bg-surface-floor'}`}
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
