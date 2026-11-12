import { useState } from 'react'
import { Tooltip, stateLabel } from '../../../components/primitives.jsx'
import { usePresence } from '../../../components/presence.js'
import type { SessionLook } from '../../session/look.js'
import { FOLD_SUMMARY_STATES, type FoldSummaryState } from '../fold.js'
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
          {/* Every state has its slot, in the fixed order of `counts`: a chip that comes fades in and one that goes fades out (design-system §9) */}
          {FOLD_SUMMARY_STATES.map((state) => (
            <StateCount key={state} state={state} count={counts.find((c) => c.state === state)?.count ?? 0} />
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

/**
 * A chip like ToolMark — a count instead of a letter. A count of 0 is no chip; the one that just dropped to 0 stays for its exit with its last count (usePresence, as the mark's dot does).
 *
 * **A chip that leaves gives back its width as it fades** (`cc-chip-out`, #2202) and **one that arrives grows its width in as it fades in** (`cc-chip-in`, #2209): the chips that stay
 * slide over, where they jumped by its width (and its gap) in one frame (design-system §9). Its wrapper has no box at rest (`contents`), so the line's layout is the chips' own.
 */
function StateCount({ state, count }: { state: FoldSummaryState; count: number }) {
  const presence = usePresence(count > 0)
  const [held, setHeld] = useState(count)
  if (count > 0 && held !== count) setHeld(count)
  // The entrance is over when its animation ends (the wrapper's own, not a descendant's, whose events bubble up to it)
  // A chip already there when the line is drawn does not enter; one that comes after it was drawn empty does
  const [entering, setEntering] = useState(false)
  // Nothing is drawn: the next arrival is a new entrance (this component stays mounted for every state, so its state is not reset by itself)
  if (!presence.shown) {
    if (!entering) setEntering(true)
    return null
  }
  return (
    <span
      className={presence.leaving ? 'cc-chip-out pointer-events-none' : entering ? 'cc-chip-in' : 'contents'}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setEntering(false)
      }}
    >
      <span className="cc-mark relative shrink-0 rounded-md" data-look={FOLD_LOOK[state]} data-state={state} data-leaving={presence.leaving || undefined}>
        <span className="readout cc-chip flex h-[14px] min-w-[14px] items-center justify-center rounded-sm border border-line-strong px-[3px] text-2xs font-semibold leading-none text-ink">
          {held}
        </span>
        {state === 'background' && <BackgroundDot testId="fold-summary-background-dot" />}
      </span>
    </span>
  )
}
