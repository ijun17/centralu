import type { MachineStatus } from '@cc/protocol'
import { MACHINE_STATUS_LABEL } from '@cc/core'

/**
 * A link's state as one dot and a word. The dot is the only mark: brightness says how much the state asks of the
 * person (a version decision or a refusal is bright, away is faint, connected is quiet), the word says which.
 */
export function MachineStatusMark({ status, testId }: { status: MachineStatus; testId?: string }) {
  const tone =
    status === 'versions_differ' || status === 'refused'
      ? 'bg-ink-signal'
      : status === 'connected'
        ? 'bg-ink-muted'
        : status === 'connecting' || status === 'starting' || status === 'updating'
          ? 'bg-ink-muted animate-pulse'
          : 'bg-ink-faint'
  return (
    <span className="flex shrink-0 items-center gap-1 text-2xs text-ink-faint" data-testid={testId} data-status={status}>
      <span className={`size-1.5 rounded-full ${tone}`} aria-hidden />
      <span className={status === 'versions_differ' || status === 'refused' ? 'text-ink' : ''}>{MACHINE_STATUS_LABEL[status]}</span>
    </span>
  )
}
