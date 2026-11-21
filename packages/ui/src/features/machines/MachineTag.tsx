import { forwardRef, useRef, useState, type CSSProperties } from 'react'
import { machineAway } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useMachineName } from '../../store/selectors.js'
import { MachineMenu } from './MachineMenu.jsx'

/**
 * Which machine a session runs on where the sidebar's badge (MachineBadge, #734) is not in view: the inbox, a notice
 * card, the session header (every grid panel's too). Nothing for this computer: its absence reads as "here". A chip one
 * step lighter than its ground, in the faint ink, so it never competes with what is waiting.
 */
const CHIP = 'shrink-0 truncate rounded-md border border-line bg-surface-raised px-1 text-2xs leading-body text-ink-faint'

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
 * A linked machine's project or user-folder app in the sidebar's one list (#734), which has no machine header. The
 * border is the link: solid while connected, dashed while not. Pressing opens MachineMenu; the tooltip has the last
 * error. Capped at 96px so a long machine name cannot take the project's line. `placeholder` holds the badge's place,
 * invisible and inert, inside a row that is itself a button (an app row), where the badge stands over it as its own.
 */
// In the project name's ink: beside a project's changes badge, a faint chip reads as one more count. Written whole, not
// layered on CHIP: of two text or border colours on one element, the generated CSS's order wins, not the class order
const BADGE = 'shrink-0 truncate rounded-md border border-line bg-surface-raised px-1 pb-0.5 pt-px text-2xs leading-none text-ink max-w-24'

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
  // The same word as the row's dimming and tooltip (`isAway`): the three never disagree (#1611)
  const connected = !machineAway(info)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`${BADGE} ${connected ? '' : 'border-dashed'} ${className}`}
        style={style}
        title={info === undefined ? name : connected ? `${name} — ${info.sshTarget}` : `${name} is not connected${info?.error ? ` — ${info.error}` : ''}`}
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
  const name = useMachineName(machine)
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
