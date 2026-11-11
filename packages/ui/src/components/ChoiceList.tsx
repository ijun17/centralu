import { Button } from './Button.js'

/**
 * The answers a question offers (#1630, owner 2026-11-11, mock-up A): a small muted label, then a numbered vertical list of outlined rows, as wide as
 * the box they are in, so they read as something to press and not as more of the message above. Pressing one gives its words as the answer.
 *
 * A row lights with `surface-selected` under the pointer (a change of colour, 150ms; reduced motion keeps it as a fade). Once the question is answered
 * (`locked`) no row takes a press: the picked one stays lit, the others fade as a disabled control does, and the label says what was done. Two presses in a
 * row are one, because a row is locked from the first (`busy`).
 */

export function ChoiceList({
  choices,
  label,
  picked = null,
  locked = false,
  onPick,
  testId,
}: {
  choices: readonly string[]
  /** What the list says it is: "Choose one", then what was done once it is locked */
  label: string
  /** The index of the choice that was picked, once it was */
  picked?: number | null
  /** Takes no press: answered, or nothing left to answer */
  locked?: boolean
  onPick: (choice: string) => void
  testId?: string
}) {
  return (
    <div className="flex flex-col gap-1.5 pt-2" data-testid={testId}>
      {/* The words change in place with a short fade, as a setup line's do (docs/design-system.md §9) */}
      <span key={label} className="cc-setup-swap text-xs text-ink-muted" data-testid={testId && `${testId}-label`}>
        {label}
      </span>
      <ol className="flex flex-col gap-1" aria-label={label}>
        {choices.map((c, i) => (
          <li key={c}>
            <Button
              variant="choice"
              size="lg"
              disabled={locked}
              aria-pressed={locked ? picked === i : undefined}
              className="flex w-full items-baseline gap-2 text-left"
              onClick={() => onPick(c)}
              data-testid={testId && `${testId}-${i + 1}`}
            >
              {/* One digit wide whichever digit it is, so the words line up (the font draws a 1 narrower even with tabular figures) */}
              <span className="min-w-[0.85em] text-xs tabular-nums text-ink-faint">{i + 1}.</span>
              <span className="min-w-0 break-words">{c}</span>
            </Button>
          </li>
        ))}
      </ol>
    </div>
  )
}
