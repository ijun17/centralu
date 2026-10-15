import { forwardRef, type CSSProperties } from 'react'
import type { MachineStatus } from '@cc/protocol'
import { MACHINE_STATUS_LABEL } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useMachineName } from '../../store/selectors.js'

/**
 * Which machine a session runs on, where the sidebar's machine badge (MachineBadge, #734) is not in view: the inbox, a notice
 * card, the session header (which is also every grid panel's header and the place an approval or question is answered).
 * Nothing for this computer: a tag on every local row would be noise, and the person reads its absence as "here".
 *
 * Kind is shape, urgency is brightness (styles/index.css): a hairline chip in the faint ink, like the merged and PR
 * badges, so it never competes with what is waiting.
 */
const CHIP = 'shrink-0 truncate rounded-md border border-line px-1 text-2xs leading-body text-ink-faint'

export function MachineTag({ machine, testId, className = '' }: { machine: string | null | undefined; testId?: string; className?: string }) {
  const name = useMachineName(machine)
  if (!name) return null
  return (
    <span
      className={`${CHIP} ${className}`}
      data-testid={testId}
      data-machine={machine ?? undefined}
      title={`Runs on ${name}`}
    >
      {name}
    </span>
  )
}

/**
 * A linked machine's project or user-folder app in the sidebar's one list (#734), where a machine header used to say
 * which machine its rows were on. MachineTag's chip, so it reads as the same mark wherever a machine is named; the
 * border is the link: solid while connected, dashed while not (connecting, away, unreachable, …). It keeps what the
 * header offered: pressing it opens Settings → Machines, and its tooltip carries the link's last error.
 *
 * Capped at 96px and cut with an ellipsis past it, so a long machine name cannot take the line from the project's own
 * name; the whole name is in Settings → Machines. `placeholder` is the same chip, invisible and inert, holding the
 * badge's place inside a row that is itself a button (an app row), where the badge stands over it as a button of its
 * own beside the row's.
 */
const BADGE = `${CHIP} max-w-24`

export function MachineBadge({
  machine,
  testId,
  className = '',
  style,
}: {
  machine: string
  testId?: string
  className?: string
  style?: CSSProperties
}) {
  const info = useStore((s) => s.machines[machine])
  const openSettingsAt = useStore((s) => s.openSettingsAt)
  const name = info?.name ?? machine
  const connected = info?.status === 'connected'
  return (
    <button
      type="button"
      className={`${BADGE} ${connected ? '' : 'border-dashed'} hover:text-ink ${className}`}
      style={style}
      title={info?.error ?? `${name} — ${info?.sshTarget ?? ''}`}
      data-testid={testId}
      data-machine={machine}
      data-status={info?.status ?? 'unknown'}
      onClick={() => openSettingsAt('machines')}
    >
      {name}
    </button>
  )
}

/** The badge's place in a row that is itself a button: the same box, invisible, read by nothing */
export const MachineBadgePlaceholder = forwardRef<HTMLSpanElement, { machine: string }>(function MachineBadgePlaceholder({ machine }, ref) {
  const name = useMachineName(machine) ?? machine
  return (
    <span ref={ref} aria-hidden className={`${BADGE} invisible`}>
      {name}
    </span>
  )
})

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
