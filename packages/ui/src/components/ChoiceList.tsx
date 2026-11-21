import { Button } from './Button.js'

/**
 * The answers a question offers (docs/design-system.md §11, #1630); pressing one gives its words as the answer. Two
 * presses in a row are one: the caller locks the list from the first.
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
      {/* Changes in place with a short fade (docs/design-system.md §9) */}
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
              {/* One digit wide whichever digit: the font draws a 1 narrower even with tabular figures */}
              <span className="min-w-[0.85em] text-xs tabular-nums text-ink-faint">{i + 1}.</span>
              <span className="min-w-0 break-words">{c}</span>
            </Button>
          </li>
        ))}
      </ol>
    </div>
  )
}
