import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { WatchView } from '@cc/protocol/client'
import { formatClock, formatDay } from '../../app/format.js'
import { useAnchoredPlacement } from '../../components/anchored.js'
import { Button } from '../../components/Button.jsx'
import { ClockIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { LEAVE_MS, usePresence } from '../../components/presence.js'
import { useDismiss } from '../../components/useDismiss.js'
import { watchCount } from '../../store/mail.js'
import { useStore } from '../../store/store.js'

/**
 * The watches a session keeps (#1324, docs/plans/mailbox.md §18.8): it asked Centralu to wake it at a time, or when another
 * session ends its turn. Counted in the header beside the background work, built like it, with a list to cancel one. Drawn
 * only while there is one; an older host lists none, so it shows nothing.
 */

const NONE: readonly WatchView[] = []

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** The day of `at` as a row says it: nothing for today, "tomorrow", or "Nov 20" */
function dayOf(at: number, now: number): string {
  const day = new Date(at)
  const next = new Date(now)
  if (sameDay(day, next)) return ''
  next.setDate(next.getDate() + 1)
  return sameDay(day, next) ? 'tomorrow' : formatDay(at, now)
}

/** "16:30" today, "tomorrow 14:05", "Nov 20 14:05" */
function moment(at: number, now: number): string {
  const day = dayOf(at, now)
  return day ? `${day} ${formatClock(at)}` : formatClock(at)
}

/** What a watch waits for, in the person's words: the session's name, never its address or the watch's id */
export function watchLine(w: WatchView, now: number): string {
  switch (w.source) {
    case 'session':
      return `Until ${w.what} ends its turn, asks or stops · until ${moment(w.until, now)}`
    case 'time': {
      if (w.everyMinutes) return `Every ${w.everyMinutes === 1 ? 'minute' : `${w.everyMinutes} minutes`} · until ${moment(w.until, now)}`
      const at = w.at ?? w.until
      const day = dayOf(at, now)
      return `At ${formatClock(at)}${day === '' ? '' : day === 'tomorrow' ? ' tomorrow' : ` on ${day}`}`
    }
    case 'pr':
      return `Until the checks on ${w.what} finish`
    default:
      return w.what || `Until ${moment(w.until, now)}`
  }
}

export const watchesLabel = (n: number): string => `${n} watch${n === 1 ? '' : 'es'} set to wake this session`

export function WatchesBadge({ sessionId }: { sessionId: string }) {
  const rows = useStore((s) => s.watches[sessionId])
  const load = useStore((s) => s.loadWatches)
  useEffect(() => {
    void load(sessionId)
  }, [load, sessionId])
  return <WatchesCapsule sessionId={sessionId} rows={rows} />
}

/** The badge over the rows the host listed (none read yet, or an older host: undefined) */
export function WatchesCapsule({ sessionId, rows }: { sessionId: string; rows: readonly WatchView[] | undefined }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const any = watchCount(rows) > 0
  // What it listed, for its exit when the last one goes
  const [last, setLast] = useState(rows ?? NONE)
  if (any && rows && last !== rows) setLast(rows)
  const shown = any && rows ? rows : last
  const count = watchCount(shown)

  useDismiss({ open, onClose: () => setOpen(false), refs: [buttonRef, listRef], returnFocusTo: buttonRef })
  useEffect(() => {
    if (!any) setOpen(false)
  }, [any])

  const badge = usePresence(any)
  const list = usePresence(open)
  if (!badge.shown) return null
  return (
    <span
      className={`${badge.leaving ? 'cc-fade-out pointer-events-none' : 'cc-fade'} flex shrink-0 items-center`}
      data-testid="watches-badge"
      data-count={count}
    >
      <IconButton
        ref={buttonRef}
        label={watchesLabel(count)}
        onClick={() => setOpen((o) => !o)}
        haspopup="dialog"
        expanded={open}
        lit
        align="right"
        testId="watches-button"
      >
        <ClockIcon />
        <span className="readout ml-1 translate-y-px text-xs leading-none">{count}</span>
      </IconButton>
      {list.shown &&
        createPortal(
          <WatchList sessionId={sessionId} rows={shown} anchorRef={buttonRef} listRef={listRef} leaving={list.leaving} />,
          document.body,
        )}
    </span>
  )
}

/** The rows, with the ones that just left kept for their exit (`LEAVE_MS`), as the Inbox keeps an answered card (`useLeavingCards`) */
function useLeavingRows(rows: readonly WatchView[]): { watch: WatchView; gone: boolean }[] {
  const [before, setBefore] = useState(rows)
  const [ghosts, setGhosts] = useState<{ watch: WatchView; at: number }[]>([])
  if (before !== rows) {
    setBefore(rows)
    const now = new Set(rows.map((w) => w.id))
    const gone = before.flatMap((watch, at) => (now.has(watch.id) ? [] : [{ watch, at }]))
    setGhosts([...ghosts.filter((g) => !now.has(g.watch.id)), ...gone])
  }
  useEffect(() => {
    if (ghosts.length === 0) return
    const t = setTimeout(() => setGhosts([]), LEAVE_MS)
    return () => clearTimeout(t)
  }, [ghosts])
  const shown = rows.map((watch) => ({ watch, gone: false }))
  for (const g of [...ghosts].sort((a, b) => a.at - b.at)) shown.splice(Math.min(g.at, shown.length), 0, { watch: g.watch, gone: true })
  return shown
}

function WatchList({
  sessionId,
  rows,
  anchorRef,
  listRef,
  leaving,
}: {
  sessionId: string
  rows: readonly WatchView[]
  anchorRef: RefObject<HTMLElement | null>
  listRef: RefObject<HTMLDivElement | null>
  leaving: boolean
}) {
  const at = useAnchoredPlacement(anchorRef, listRef, true)
  const shown = useLeavingRows(rows)
  const now = Date.now()
  return (
    <div
      ref={listRef}
      role="dialog"
      aria-label="Watches"
      data-testid="watches-list"
      className={`fixed z-40 w-[420px] max-w-[calc(100vw/var(--text-zoom)_-_1rem)] overflow-y-auto rounded-lg border border-line bg-surface-side shadow-(--shadow-modal) ${leaving ? 'cc-drop-out pointer-events-none' : 'cc-drop'}`}
      style={{
        top: at?.top ?? 0,
        left: at?.left ?? 0,
        maxHeight: at ? `min(24rem, ${at.maxHeight}px)` : '24rem',
        visibility: at ? 'visible' : 'hidden',
      }}
    >
      <header className="border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-medium text-ink">Watches</h2>
      </header>
      <ul className="flex flex-col py-1">
        {shown.map(({ watch, gone }) => (
          <WatchRow key={watch.id} sessionId={sessionId} watch={watch} now={now} gone={gone} />
        ))}
      </ul>
    </div>
  )
}

export function WatchRow({ sessionId, watch, now, gone = false }: { sessionId: string; watch: WatchView; now: number; gone?: boolean }) {
  const cancel = useStore((s) => s.cancelWatch)
  const [busy, setBusy] = useState(false)
  const line = watchLine(watch, now)
  return (
    <li
      className={`flex items-center gap-2.5 px-4 py-2 ${gone ? 'cc-fade-out pointer-events-none' : 'cc-fade'}`}
      inert={gone}
      data-testid={`watch-${watch.id}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-snug text-ink" title={line}>
          {line}
        </span>
        {watch.note && (
          <span className="mt-0.5 block truncate text-xs text-ink-muted" title={watch.note}>
            {watch.note}
          </span>
        )}
      </span>
      <Button
        variant="quiet"
        size="sm"
        busy={busy}
        onClick={() => {
          setBusy(true)
          void cancel(sessionId, watch.id).then((done) => !done && setBusy(false))
        }}
        data-testid={`watch-cancel-${watch.id}`}
      >
        Cancel
      </Button>
    </li>
  )
}
