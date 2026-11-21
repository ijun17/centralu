import { useState } from 'react'
import { Tooltip, stateLabel } from '../../../components/primitives.jsx'
import { usePresence } from '../../../components/presence.js'
import type { SessionLook } from '../../session/look.js'
import { FOLD_SUMMARY_STATES, type FoldSummaryState } from '../fold.js'
import { BackgroundDot } from './ToolMark.jsx'

/**
 * The status counts on a project's name line (#205), folded or open. ToolMark's chips and looks (#736) with a count for
 * the letter, so no new symbol to learn. At the line's right end, so folded projects' summaries form one column.
 */
export function FoldSummary({ name, counts }: { name: string; counts: { state: FoldSummaryState; count: number }[] }) {
  const label = counts.map((c) => `${c.count} ${foldStateLabel(c.state)}`).join(' · ')
  return (
    <span className="-my-1 ml-auto flex shrink-0 self-center">
      <Tooltip content={label} testId={`fold-summary-tip-${name}`} align="right">
        <span className="flex items-center gap-1" aria-label={label} data-testid={`fold-summary-${name}`}>
          {/* Every state has its slot, in a fixed order, so chips come and go in place (docs/design-system.md §9) */}
          {FOLD_SUMMARY_STATES.map((state) => (
            <StateCount key={state} state={state} count={counts.find((c) => c.state === state)?.count ?? 0} />
          ))}
        </span>
      </Tooltip>
    </span>
  )
}

const foldStateLabel = (state: FoldSummaryState): string => (state === 'background' ? 'waiting on background work' : stateLabel(state).toLowerCase())

/** A session mark's looks (#736); background work is the idle look with the mark's dot (#2146) */
const FOLD_LOOK: Record<FoldSummaryState, SessionLook> = {
  waiting_approval: 'waiting',
  error: 'stopped',
  waiting_input: 'idle',
  working: 'answering',
  background: 'idle',
}

/** One count's chip; at 0 it stays for its exit with its last count (usePresence), its width going (docs/design-system.md §9) */
function StateCount({ state, count }: { state: FoldSummaryState; count: number }) {
  const presence = usePresence(count > 0)
  const [held, setHeld] = useState(count)
  if (count > 0 && held !== count) setHeld(count)
  // A chip there when the line is drawn does not enter; one that comes later does, until the wrapper's own animation ends
  const [entering, setEntering] = useState(false)
  // Mounted for every state, so the next arrival is marked as an entrance here
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
