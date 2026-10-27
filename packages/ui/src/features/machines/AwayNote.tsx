import { awayNote } from '@cc/core'
import type { MachineInfo } from '@cc/protocol/client'
import { useLabelNow } from '../../app/useLabelNow.js'

/** Moves on twice a minute: "39m ago" and "in 3 min" are read in minutes, and the next attempt's time changes at each attempt */
const next = () => 30_000

/**
 * What the row of a machine that is `away` says under its headline (#1398): when it was last connected, when the host tries
 * again, and ssh's own line as the details. The headline is core's `machineProblem`; none of this is an error, so it is in the
 * ink of a state. Null for any other status.
 */
export function AwayNote({ m, testId }: { m: Pick<MachineInfo, 'status' | 'error' | 'lastConnectedAt' | 'nextAttemptAt'>; testId: string }) {
  const now = useLabelNow(m.status === 'away' ? next : null)
  if (m.status !== 'away') return null
  const { lastConnected, next: again } = awayNote(m, now)
  const parts = [lastConnected ? `Last connected ${lastConnected}` : 'Not connected yet', again ? `trying again ${again}` : null].filter(Boolean)
  return (
    <div data-testid={testId}>
      <p className="mt-0.5 text-ink-muted">{parts.join(' · ')}</p>
      {m.error && <p className="mt-0.5 font-mono text-2xs text-ink-faint">{m.error}</p>}
    </div>
  )
}
