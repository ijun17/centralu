import { forwardRef, useRef, useState, type CSSProperties } from 'react'
import { useStore } from '../../store/store.js'
import { useMachineName } from '../../store/selectors.js'
import { MachineMenu } from './MachineMenu.jsx'

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
 * header offered, and more: pressing it opens a menu with the link's state, its last error and Connect (MachineMenu),
 * and its tooltip carries the last error too.
 *
 * Capped at 96px and cut with an ellipsis past it, so a long machine name cannot take the line from the project's own
 * name; the whole name is in Settings → Machines. `placeholder` is the same chip, invisible and inert, holding the
 * badge's place inside a row that is itself a button (an app row), where the badge stands over it as a button of its
 * own beside the row's.
 */
// In the project name's own ink, text and border (owner, 2026-10-20): beside a project's changes badge, the faint chip read as one more
// count. Written whole rather than layered on CHIP: two text or border colours on one element are settled by the order
// of the generated CSS, not of the class attribute
const BADGE = 'shrink-0 truncate rounded-md border border-ink px-1 pb-0.5 pt-px text-2xs leading-none text-ink max-w-24'

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
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const name = info?.name ?? machine
  const status = info?.status ?? 'unknown'
  const connected = status === 'connected'
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`${BADGE} ${connected ? '' : 'border-dashed'} ${className}`}
        style={style}
        title={connected ? `${name} — ${info?.sshTarget ?? ''}` : `${name} is not connected${info?.error ? ` — ${info.error}` : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        data-machine={machine}
        data-status={status}
        onClick={() => setOpen((v) => !v)}
      >
        {/*
          Not connected is said on the badge itself (owner, 2026-10-20): the dashed border alone read as a style, not a
          state. A slash through the name's ink would cost its legibility; a dot before it costs one character's width
        */}
        {!connected && <span className="mr-1 inline-block size-1 -translate-y-px rounded-full bg-current align-middle" aria-hidden />}
        {name}
      </button>
      {open && <MachineMenu machine={machine} anchorEl={ref.current} onClose={() => setOpen(false)} />}
    </>
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
