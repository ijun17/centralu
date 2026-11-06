import { ChevronIcon } from '../../../components/icons.jsx'
import { foldSummary, type Fold } from './foldRuns.js'

/**
 * The one line a run of thinking and tool calls folds into (#2007): what it holds, how long it took, a mark when a
 * tool call in it failed, and, while the turn is live, the step it is on, so a folded run still visibly moves.
 * Pressing it opens the run in place and pressing it again folds it.
 *
 * Quiet like the tool card's own title row (`ink-faint`, a failure one step up in `ink-muted`): it is the path to what
 * was done, never what waits on the person. No frame, so it reads as a line of the page between two bubbles.
 */
export function FoldLine({
  fold,
  open,
  step,
  onToggle,
}: {
  fold: Fold
  open: boolean
  /** The step a live run is on; null for a run that is not live */
  step: string | null
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-2 py-1 text-left text-xs text-ink-faint hover:text-ink-muted"
      aria-expanded={open}
      onClick={onToggle}
      data-testid="fold-line"
      data-fold-open={open}
      data-fold-at={fold.first}
    >
      <span className="shrink-0">
        <ChevronIcon open={open} />
      </span>
      <span className="shrink-0 whitespace-nowrap" data-testid="fold-summary">
        {foldSummary(fold)}
      </span>
      {fold.failed > 0 && (
        <span className="shrink-0 whitespace-nowrap text-ink-muted" data-testid="fold-failed">
          {fold.failed} failed
        </span>
      )}
      {step !== null && (
        <>
          <span className="size-1.5 shrink-0 rounded-full bg-ink-muted" aria-hidden />
          <span className="readout min-w-0 truncate" title={step} data-testid="fold-step">
            {step}
          </span>
        </>
      )}
    </button>
  )
}
