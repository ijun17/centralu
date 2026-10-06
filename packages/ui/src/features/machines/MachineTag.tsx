import type { MachineStatus } from '@cc/protocol'
import { MACHINE_STATUS_LABEL } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useMachineName } from '../../store/selectors.js'

/**
 * Which machine a session runs on, where it is named outside the sidebar's machine groups (#82): the inbox, a notice
 * card, the session header (which is also every grid panel's header and the place an approval or question is answered).
 * Nothing for this computer: a tag on every local row would be noise, and the person reads its absence as "here".
 *
 * Kind is shape, urgency is brightness (styles/index.css): a hairline chip in the faint ink, like the merged and PR
 * badges, so it never competes with what is waiting.
 */
export function MachineTag({ machine, testId, className = '' }: { machine: string | null | undefined; testId?: string; className?: string }) {
  const name = useMachineName(machine)
  if (!name) return null
  return (
    <span
      className={`shrink-0 truncate rounded-md border border-line px-1 text-2xs leading-body text-ink-faint ${className}`}
      data-testid={testId}
      data-machine={machine ?? undefined}
      title={`Runs on ${name}`}
    >
      {name}
    </span>
  )
}

/** The machine a session runs on, by session id */
export function SessionMachineTag({ sessionId, testId, className }: { sessionId: string; testId?: string; className?: string }) {
  const machine = useStore((s) => s.sessions[sessionId]?.machine ?? null)
  return <MachineTag machine={machine} testId={testId} className={className} />
}

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
        : status === 'connecting'
          ? 'bg-ink-muted animate-pulse'
          : 'bg-ink-faint'
  return (
    <span className="flex shrink-0 items-center gap-1 text-2xs text-ink-faint" data-testid={testId} data-status={status}>
      <span className={`size-1.5 rounded-full ${tone}`} aria-hidden />
      <span className={status === 'versions_differ' || status === 'refused' ? 'text-ink' : ''}>{MACHINE_STATUS_LABEL[status]}</span>
    </span>
  )
}
