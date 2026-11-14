import type { ReactNode } from 'react'
import { Fold } from '../../components/Fold.jsx'
import { ChevronIcon } from '../../components/icons.jsx'

/** A part of the Inbox's list folded under its name and count, opened in place by a press (Waiting's Earlier, Tasks' Done) */
export function FoldedGroup({ label, count, open, onToggle, testId, children }: { label: string; count: number; open: boolean; onToggle: () => void; testId: string; children: ReactNode }) {
  return (
    <>
      <button
        type="button"
        className="flex items-center gap-1.5 px-4 py-2 text-left text-xs text-ink-faint transition-colors hover:text-ink-muted"
        aria-expanded={open}
        onClick={onToggle}
        data-testid={`${testId}-toggle`}
      >
        <ChevronIcon open={open} />
        {label}
        <span className="readout">{count}</span>
      </button>
      <Fold open={open} testId={testId}>
        <ul className="flex flex-col gap-0.5 p-1">{children}</ul>
      </Fold>
    </>
  )
}
