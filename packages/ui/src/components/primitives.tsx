import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Interruption, SessionState } from '@cc/protocol'
import { useCapability } from '../app/PlatformProvider.jsx'
import { formatDuration } from '../app/format.js'
import { useAnchoredPlacement } from './anchored.js'

/**
 * The state indicator (FR-12).
 * With no color, urgency is spoken by brightness and kind by shape.
 * Only waiting-for-approval is pure white, everything else is dim — the brightest thing on
 * screen is exactly what is waiting for me.
 */
const SIGNAL: Record<SessionState, { glyph: string; tone: string; label: string }> = {
  waiting_approval: { glyph: '●', tone: 'signal', label: 'Awaiting approval' },
  error: { glyph: '✕', tone: 'text-ink-signal', label: 'Error' },
  waiting_input: { glyph: '○', tone: 'text-ink-muted', label: 'Waiting for input' },
  working: { glyph: '◆', tone: 'text-ink-muted breathe', label: 'Working' },
  limited: { glyph: '▬', tone: 'text-ink-faint', label: 'Limit reached' },
  idle: { glyph: '·', tone: 'text-ink-faint', label: 'Idle' },
}

/** The state's spoken name. The same wording must be used wherever a dot is not drawn (e.g. a tool marker) */
export const stateLabel = (state: SessionState): string => SIGNAL[state].label

/**
 * Why the last turn did not finish (#698), in the words the inbox, the sidebar's tooltip and the conversation share.
 * `reconnecting` is the one that has not stopped: the session still works, and the tool is still trying.
 */
export function interruptionLabel(i: Interruption): string {
  switch (i.reason) {
    case 'network':
      return 'Stopped: network'
    case 'quit':
      return 'Stopped: Centralu quit or restarted'
    case 'interrupted':
      return 'Stopped: interrupted'
    case 'reconnecting':
      return 'Reconnecting for 5+ min'
  }
}

/** A stopped turn the person can continue with one message (#698); reconnecting goes on by itself */
export const canContinue = (i: Interruption | null | undefined): i is Interruption => !!i && i.reason !== 'reconnecting'

/**
 * What Continue sends: short, since the agent still has its whole conversation. The second sentence is there because a
 * turn cut short may have done part of a step already (a push, a comment) that its record does not show as finished.
 */
export const CONTINUE_TEXT = 'Continue where you stopped. Check what already happened before repeating a step.'

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
 * The signature element — the identity of a keyboard-first tool.
 *
 * `mod` and `alt` take a meaning, not a glyph (issue #32). The key that is `⌘` on this Mac is
 * `Ctrl` on another keyboard, and the handler had already been accepting both for a long time —
 * only the screen was telling the person to press a key that did not exist. Writing the symbol
 * at the call site, as in `<Kbd>⌘</Kbd>`, is what spread that lie across ten files at once, so
 * the keyboard's name is now taken in from this one place only.
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

/**
 * The longer the wait, the brighter the text.
 * Speaks the premise that a person's attention is the most expensive resource, using brightness
 * alone rather than adding a new shape.
 */
export function waitingTone(ms: number): string {
  if (ms > 10 * 60_000) return 'text-ink-signal'
  if (ms > 3 * 60_000) return 'text-ink'
  return 'text-ink-faint'
}

/**
 * The tooltip.
 *
 * The browser's native title takes 1-2 seconds to appear and its look cannot be matched to the
 * app. For information like the sidebar — normally taking up no space, but expected to answer
 * immediately when asked — that delay is effectively no information at all.
 *
 * It appears on focus as well as on hover — someone navigating by keyboard alone needs the same
 * information.
 */
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
  /** Layout of the anchor wrapper, which is the flex item when the tooltip stands in a row. */
  className?: string
  /** An element near the bottom of the screen floats the tooltip upward — floating it downward would push it off the window */
  placement?: 'bottom' | 'top'
  /** An element at the right edge aligns the tooltip to the right — left alignment would push the tooltip off the window */
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  /*
   * fixed, not absolute (dogfooding: the usage donut's tooltip was clipped at the bottom by the
   * modal's scroll box). An absolute inside the trigger is guaranteed to be clipped by an
   * overflow somewhere among its ancestors — a sidebar button's tooltip (overflow-y-auto) was
   * standing on the exact same mine. Floating it relative to the viewport leaves no box to be
   * clipped by. Placed by the same rule as every popover (anchored.ts): `placement` is the side tried first and it
   * flips when the window has no room there — a default direction, not a guarantee.
   */
  const pos = useAnchoredPlacement(anchorRef, tipRef, open, {
    align,
    side: placement === 'top' ? 'above' : 'below',
  })
  /*
   * Only scrolling an ancestor can move the anchor and make the measured position stale.
   * Conversation auto-follow also emits scroll events during an answer; closing on those
   * unrelated events dismissed every tooltip even while its anchor stayed still (#611).
   */
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
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          ref={tipRef}
          role="tooltip"
          data-testid={testId}
          className="pointer-events-none fixed z-50 w-max max-w-64 rounded-md border border-line bg-surface-raised px-2 py-1.5 text-xs leading-body text-ink-muted shadow-(--shadow-popover)"
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
        >
          {content}
        </span>
      )}
    </span>
  )
}
