import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WaitingCounts } from '@cc/core'
import { useStore } from '../../store/store.js'
import type { Notice } from '../../store/state/notifications.js'
import { MailIcon } from '../../components/icons.jsx'
import { mailAsksYou, mailAttention } from '../../store/mail.js'

/**
 * How long a new notice stays written out before it folds into the count: 4 s sometimes folds before it is read. A
 * finished turn on screen is judged seen at the same moment (Notices.tsx)
 */
export const PEEK_MS = 5000

/**
 * The inbox's door in the top bar (docs/design-system.md §6): an envelope and the waiting count on one capsule, which
 * writes a new notice out for a few seconds ("api finished") and folds it back; no cards cover the page.
 */
export function InboxPill({ counts, onOpen, title }: { counts: WaitingCounts; onOpen: () => void; title: string }) {
  const peek = useNoticePeek()
  // What waits on the person: the sessions, and the threads of the mailbox that have something for them (#1347)
  const mailWaiting = useStore((s) => mailAttention(s.mail))
  const mailAsks = useStore((s) => mailAsksYou(s.mail))
  const total = counts.approval + counts.input + counts.error + mailWaiting
  // Brightness says what kind of wait: an approval or an error is the signal, plain waiting stays quiet
  const tone = counts.approval + counts.error > 0 ? 'signal' : total > 0 ? 'text-ink-muted' : 'text-ink-faint'
  // The edge follows docs/design-system.md §6 (the inbox capsule's row, #2227), fading with `transition-colors` (§9)
  const answers = counts.approval > 0 || mailAsks > 0
  const edge = counts.error > 0 ? 'border-dashed border-ink-signal' : answers ? 'border-solid border-ink-signal' : 'border-solid border-line'
  return (
    <button
      type="button"
      className={`group flex h-7 items-center justify-center rounded-full border ${edge} bg-surface-hover/30 px-2.5 transition-colors hover:bg-surface-hover/60 ${tone}`}
      onClick={onOpen}
      data-testid="counter"
      title={title}
      data-edge={counts.error > 0 ? 'error' : counts.approval > 0 ? 'approval' : mailAsks > 0 ? 'question' : undefined}
      aria-label={`${total} waiting`}
    >
      {/* 20px, the size of the settings gear and the usage donuts in the same bar */}
      <MailIcon size={20} />
      {/* One pixel down: the digits sit high in the readout font's line box (measured: their middle 1.25px above the icon's) */}
      <span className="readout ml-1.5 translate-y-px text-sm leading-none" data-testid="count-waiting">
        {total}
      </span>
      <PeekLine text={peek ? peekText(peek.notice) + (peek.more > 0 ? ` · ${peek.more} more` : '') : null} />
    </button>
  )
}

/** How long the line takes to grow out of the capsule, and to fold back */
const GROW_MS = 320

/**
 * The line that grows out of the capsule and folds back: its real width animates, not a max-width, so the motion
 * is even from first pixel to last, and the text stays while it folds (it would vanish first otherwise and the
 * capsule would shrink empty). One pixel down like the count, so its lowercase sits on the icon's middle (measured).
 * No flex gap: a gap would stand beside the folded line and push the count off centre; its margin comes with the text.
 */
function PeekLine({ text }: { text: string | null }) {
  // What is written: the new text at once, the old one kept until the fold has finished
  const [shown, setShown] = useState<string | null>(text)
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState(0)
  const inner = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (text) {
      setShown(text)
      return
    }
    setOpen(false)
    const t = setTimeout(() => setShown(null), GROW_MS)
    return () => clearTimeout(t)
  }, [text])
  // Measured after the text is in the page, then opened on the next frame so the width has a start to move from
  useLayoutEffect(() => {
    if (!text || shown !== text || !inner.current) return
    setWidth(inner.current.scrollWidth)
    const f = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(f)
  }, [text, shown])
  return (
    <span
      className="translate-y-px overflow-hidden whitespace-nowrap text-xs text-ink [text-shadow:none]"
      style={{
        width: open ? width : 0,
        marginLeft: open ? 8 : 0,
        opacity: open ? 1 : 0,
        transition: `width ${GROW_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), margin-left ${GROW_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity ${GROW_MS}ms ease`,
      }}
      data-testid="inbox-peek"
      data-open={open || undefined}
      aria-live="polite"
    >
      <span ref={inner} className="inline-block">
        {shown ?? ''}
      </span>
    </span>
  )
}

function peekText(n: Notice): string {
  switch (n.kind) {
    case 'done':
      return `${n.name} finished`
    case 'approval':
      return `${n.name} asks for approval`
    case 'agent_start':
      return `${n.name} wants to start an agent`
    case 'error':
      return `${n.name} hit an error`
    case 'question':
      return `${n.name} asks you a question`
  }
}

/**
 * The newest notice that arrived, for PEEK_MS, or null; one there when the screen opens is not news. Only while the
 * window is in front, as a line behind another window is never seen: what arrives meanwhile waits and comes back as the
 * newest with how many more ("api finished · 2 more").
 */
function useNoticePeek(): Peek | null {
  const notices = useStore((s) => s.notices)
  const appFocused = useStore((s) => s.appFocused)
  const seen = useRef<Set<string> | null>(null)
  const held = useRef<Notice[]>([])
  const [peek, setPeek] = useState<Peek | null>(null)
  useEffect(() => {
    const next = arrivedNotices(seen.current, notices)
    seen.current = next.seen
    if (next.fresh.length === 0) return
    held.current.push(...next.fresh)
  }, [notices])
  useEffect(() => {
    if (!appFocused || held.current.length === 0) return
    // All that arrived while away, the on-screen session's too: coming back clears its notice, so this line tells of it
    const waiting = held.current
    held.current = []
    if (waiting.length === 0) return
    const newest = waiting.reduce((a, b) => (b.at >= a.at ? b : a))
    setPeek({ notice: newest, more: waiting.length - 1, at: Date.now() })
  }, [notices, appFocused])
  useEffect(() => {
    if (!peek) return
    const t = setTimeout(() => setPeek(null), PEEK_MS)
    return () => clearTimeout(t)
  }, [peek])
  return peek
}

type Peek = { notice: Notice; more: number; at: number }

/**
 * Which of `notices` arrived since `seen` (null: the screen just opened, nothing is news), and the new `seen`: only the
 * notices there now, as a key holds its `at`, so one that left never comes back under it.
 */
export function arrivedNotices(seen: Set<string> | null, notices: Notice[]): { fresh: Notice[]; seen: Set<string> } {
  const key = (n: Notice) => `${n.sessionId}:${n.kind}:${n.at}`
  return { fresh: seen ? notices.filter((n) => !seen.has(key(n))) : [], seen: new Set(notices.map(key)) }
}
