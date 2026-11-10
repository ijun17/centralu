import { Tooltip, stateLabel } from '../../../components/primitives.jsx'
import type { SessionLook } from '../../session/look.js'
import type { FoldSummaryState } from '../fold.js'
import { BackgroundDot } from './ToolMark.jsx'

/**
 * The status summary on a project's name line (#205) — what its session rows are waiting for, as counts: all of them
 * when the project is folded and hides the rows, and still the same when it is open (owner, 2026-11-05).
 *
 * **Uses the same marks as a session row.** Inventing a new symbol would mean the person has to
 * learn it too, and it would read as the row's mark and the summary saying different things. So the
 * chip shape and look (`lookOf`, the four looks of #736) match ToolMark exactly, and only the count sits
 * where the tool letter would. Approval is a white ring on a grey fill, so it stays the strongest look
 * even in a folded row.
 *
 * It stands at the far right of the name line (right before the ⋯). With several projects folded,
 * the summaries line up in one vertical column, readable top to bottom in a single glance to see
 * who is calling. The meaning is given by the app's own tooltip — the fewer units a bare-number
 * mark has, the faster the answer needs to come.
 */
export function FoldSummary({ name, counts }: { name: string; counts: { state: FoldSummaryState; count: number }[] }) {
  const label = counts.map((c) => `${c.count} ${foldStateLabel(c.state)}`).join(' · ')
  return (
    <span className="-my-1 ml-auto flex shrink-0 self-center">
      <Tooltip content={label} testId={`fold-summary-tip-${name}`} align="right">
        <span className="flex items-center gap-1" aria-label={label} data-testid={`fold-summary-${name}`}>
          {counts.map((c) => (
            <StateCount key={c.state} state={c.state} count={c.count} />
          ))}
        </span>
      </Tooltip>
    </span>
  )
}

/** What a chip's tooltip and label say of its count */
const foldStateLabel = (state: FoldSummaryState): string => (state === 'background' ? 'waiting on background work' : stateLabel(state).toLowerCase())

/** What each state a folded project counts looks like: the same four looks as a session's mark (#736); background work is the waiting look with the mark's dot (#2146) */
const FOLD_LOOK: Record<FoldSummaryState, SessionLook> = {
  waiting_approval: 'waiting',
  error: 'stopped',
  waiting_input: 'idle',
  working: 'answering',
  background: 'idle',
}

/** A chip like ToolMark — a count instead of a letter */
function StateCount({ state, count }: { state: FoldSummaryState; count: number }) {
  return (
    <span className="cc-mark relative shrink-0 rounded-md" data-look={FOLD_LOOK[state]} data-state={state}>
      <span className="readout cc-chip flex h-[14px] min-w-[14px] items-center justify-center rounded-sm border border-line-strong px-[3px] text-2xs font-semibold leading-none text-ink">
        {count}
      </span>
      {state === 'background' && <BackgroundDot testId="fold-summary-background-dot" />}
    </span>
  )
}
