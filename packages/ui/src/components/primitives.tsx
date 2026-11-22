import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { SHUTDOWN_WORDS, type Interruption, type SessionState, type TurnStop } from '@cc/protocol/client'
import { useCapability } from '../app/PlatformProvider.jsx'
import { formatDuration, formatWhen } from '../app/format.js'
import { useAnchoredPlacement } from './anchored.js'

/** The state indicator (FR-12): urgency by brightness, kind by shape, no colour; the brightest is what waits on me */
const SIGNAL: Record<SessionState, { glyph: string; tone: string; label: string }> = {
  waiting_approval: { glyph: '●', tone: 'signal', label: 'Awaiting approval' },
  error: { glyph: '✕', tone: 'text-ink-signal', label: 'Error' },
  waiting_input: { glyph: '○', tone: 'text-ink-muted', label: 'Idle' },
  working: { glyph: '◆', tone: 'text-ink-muted breathe', label: 'Working' },
  limited: { glyph: '▬', tone: 'text-ink-faint', label: 'Limit reached' },
  idle: { glyph: '·', tone: 'text-ink-faint', label: 'Idle' },
}

/** The state's name, the same wording wherever no dot is drawn (a tool marker) */
export const stateLabel = (state: SessionState): string => SIGNAL[state].label

/** Why the last turn did not finish (#698), one wording; `reconnecting` has not stopped: the tool is still trying */
export function interruptionLabel(i: Pick<Interruption, 'reason'>): string {
  switch (i.reason) {
    case 'network':
      return 'Stopped: network'
    case 'limit':
      return 'Stopped: usage limit'
    case 'quit':
      return 'Stopped: Centralu quit or restarted'
    case 'shutdown':
      return `Stopped: ${SHUTDOWN_WORDS}`
    case 'interrupted':
      return 'Stopped: interrupted'
    case 'reconnecting':
      return 'Reconnecting for 5+ min'
  }
}

/** "at 17:02", "at Nov 23, 17:02", or "soon" once the time has passed and nothing said otherwise yet */
const waitedFor = (at: number, now: number): string => (at <= now ? 'soon' : `at ${formatWhen(at, now)}`)

/**
 * Why the last turn stopped (`turnStop`), one wording for the note above the composer, the inbox row and the sidebar's
 * tooltip (docs/ux-writing.md 1.12); the tool's own words stay in the conversation's line
 */
export function turnStopLabel(stop: TurnStop, now: number): string {
  switch (stop.kind) {
    case 'wait': {
      // A standing wait with a time is a limit's (`waitStands`); a network wait has none
      const at = stop.interruption.autoContinue?.at
      return at === undefined ? 'Network lost · continues when the network is back' : `Usage limit · continues ${waitedFor(at, now)}`
    }
    case 'stopped': {
      const reset = stop.resetAt !== undefined ? ` · resets ${waitedFor(stop.resetAt, now)}` : ''
      // The conversation draws no line of its own for it (#2360): this is where the person reads that Centralu stopped trying
      const gaveUp = stop.gaveUpAfter !== undefined ? ` · Centralu gave up after ${stop.gaveUpAfter} ${stop.gaveUpAfter === 1 ? 'try' : 'tries'}` : ''
      return `${interruptionLabel(stop)}${reset}${gaveUp}`
    }
    case 'error':
      return 'Stopped: error'
  }
}

export function StateDot({ state }: { state: SessionState }) {
  const s = SIGNAL[state]
  return (
    <span
      className={`w-2.5 shrink-0 text-center text-2xs leading-none ${s.tone}`}
      title={s.label}
      data-testid={`dot-${state}`}
      aria-label={s.label}
    >
      {s.glyph}
    </span>
  )
}

/**
 * A key cap. `mod` and `alt` take a meaning, not a glyph (#32): `⌘` here is `Ctrl` on another keyboard, so a symbol
 * written at the call site would name a key the person may not have.
 */
export function Kbd({
  children,
  live = false,
  mod = false,
  alt = false,
}: {
  children?: ReactNode
  live?: boolean
  /** `⌘` here, `Ctrl` on a keyboard with no command key */
  mod?: boolean
  /** `⌥` here, `Alt` everywhere else */
  alt?: boolean
}) {
  const keys = useCapability('shortcutKeys')
  return (
    <kbd className={`keycap ${live ? 'keycap-live' : ''}`}>
      {mod ? keys.mod : alt ? keys.alt : children}
    </kbd>
  )
}

export const formatWaiting = (ms: number): string => formatDuration(ms, { coarse: true })

/** The longer the wait, the brighter the text: attention spent by brightness alone, no new shape */
export function waitingTone(ms: number): string {
  if (ms > 10 * 60_000) return 'text-ink-signal'
  if (ms > 3 * 60_000) return 'text-ink'
  return 'text-ink-faint'
}

/** The tooltip, on hover and on focus: the native title takes 1-2 seconds and cannot match the app */
export function Tooltip({
  children,
  content,
  testId,
  className = '',
  placement = 'bottom',
  align = 'left',
}: {
  children: ReactNode
  content: ReactNode
  testId?: string
  /** The anchor wrapper's layout: it is the flex item in a row */
  className?: string
  /** `top` for an element near the bottom of the window */
  placement?: 'bottom' | 'top'
  /** `right` for an element at the window's right edge */
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  /** Pressed since the pointer came in: the tip stays away until it leaves */
  const pressed = useRef(false)
  /*
   * Fixed, as every popover (anchored.ts): an absolute tip is clipped by an ancestor's overflow (the usage donut's by
   * the modal's scroll box). `placement` is the side tried first; it flips when the window has no room there.
   */
  const pos = useAnchoredPlacement(anchorRef, tipRef, open, {
    align,
    side: placement === 'top' ? 'above' : 'below',
  })
  // Only an ancestor's scroll moves the anchor: the conversation's auto-follow scrolls too, and closed every tip (#611)
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      const target = event.target
      const anchor = anchorRef.current
      if (
        target === window ||
        target === document ||
        (target instanceof Element && anchor && target.contains(anchor))
      ) {
        setOpen(false)
      }
    }
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [open])
  return (
    <span
      ref={anchorRef}
      className={`relative inline-flex min-w-0 ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        pressed.current = false
        setOpen(false)
      }}
      /*
       * A press puts the tip away until the pointer leaves, or it stands over the list the button opened. The focus a
       * press gives does not bring it back; keyboard focus does.
       */
      onMouseDownCapture={() => {
        pressed.current = true
        setOpen(false)
      }}
      onFocusCapture={() => {
        if (!pressed.current) setOpen(true)
      }}
      onBlurCapture={() => setOpen(false)}
    >
      {children}
      {/*
        In the body, not the anchor: opacity on an ancestor (an away machine's dimmed project) cannot be undone by a
        child, so the tip would be see-through.
      */}
      {open &&
        createPortal(
        <span
          ref={tipRef}
          role="tooltip"
          data-testid={testId}
          className="pointer-events-none fixed z-50 w-max max-w-64 rounded-md border border-line bg-surface-raised px-2 py-1.5 text-xs leading-body text-ink-muted shadow-(--shadow-popover)"
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
        >
          {content}
        </span>,
          document.body,
        )}
    </span>
  )
}
