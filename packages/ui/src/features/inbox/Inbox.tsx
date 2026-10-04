import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store/store.js'
import { useInbox } from '../../store/selectors.js'
import { letterOf } from '../../app/keys.js'
import { Kbd, StateDot, formatWaiting, waitingTone } from '../../components/primitives.jsx'

/**
 * The inbox (FR-15) — the entry point for coming back to the desk.
 * Ignores project structure and shows only "what is waiting on me right now," in order of
 * urgency.
 *
 * **It is a dropdown hanging below the top-bar number** (user request, 2026-09-09). While it was
 * a modal in the middle of the screen, the place clicked and the place it opened were far apart,
 * so the one action of checking the number and opening the list moved the eye twice. The
 * location moved, but **keyboard ownership stays the same** — clearing the list with ↑↓, ↵ and
 * esc is the heart of this screen, and that has nothing to do with where it sits.
 */
export function Inbox() {
  const open = useStore((s) => s.inboxOpen)
  const toggle = useStore((s) => s.toggleInbox)
  const focusSession = useStore((s) => s.focusSession)
  const projects = useStore((s) => s.projects)
  const [now, setNow] = useState(() => Date.now())
  const items = useInbox(now)
  const [cursor, setCursor] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)

  // Refreshes elapsed time (the 1-second poll is display-only — state itself is event-driven)
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    // The inbox is a modal — it takes over keyboard ownership.
    // Right after sending a message, focus stays on the composer; left alone, d, j and k would type straight into the body.
    ;(document.activeElement as HTMLElement | null)?.blur()
    panelRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // A letter is read by meaning — on a Korean keyboard layout, j, k and d arrive as ㅓ, ㅏ and ㅇ (app/keys.ts)
      const letter = letterOf(e)
      if (e.key === 'ArrowDown' || letter === 'j') setCursor((c) => Math.min(c + 1, items.length - 1))
      else if (e.key === 'ArrowUp' || letter === 'k') setCursor((c) => Math.max(c - 1, 0))
      else if (e.key === 'Enter') {
        const item = items[cursor]
        if (item) {
          focusSession(item.id, { preferGrid: true })
          toggle(false)
        }
      } else if (e.key === 'Escape') toggle(false)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, items, cursor, focusSession, toggle])

  if (!open) return null

  return (
    <>
      {/* Clicking outside closes it. Covers the screen without dimming it — a dropdown does not take the screen away */}
      <div className="fixed inset-0 z-30" onClick={() => toggle(false)} data-testid="inbox-backdrop" />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Waiting"
        className="cc-drop absolute left-0 top-full z-40 mt-1 w-[560px] max-w-[calc(92vw/var(--text-zoom))] overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal) focus:outline-none"
        data-testid="inbox"
      >
        <header className="flex items-baseline gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-medium text-ink">Waiting</h2>
          <span className="readout text-xs text-ink-faint">{items.length}</span>
          <span className="ml-auto flex items-center gap-1 text-2xs text-ink-faint">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> Move
            <Kbd>↵</Kbd> Open
            <Kbd>esc</Kbd> Close
          </span>
        </header>

        {items.length === 0 ? (
          <p className="px-4 py-10 text-center text-md text-ink-muted" data-testid="inbox-empty">
            Nothing waiting
            <span className="mt-1 block text-xs text-ink-faint">Finished agents collect here</span>
          </p>
        ) : (
          <ul className="max-h-[calc(56vh/var(--text-zoom))] overflow-y-auto">
            {items.map((it, i) => (
              <li key={it.id}>
                <button
                  className={`flex w-full items-center gap-2.5 border-l-2 py-2 pl-3 pr-4 text-left transition-colors ${
                    i === cursor ? 'border-l-ink-muted bg-surface-hover/40' : 'border-l-transparent hover:bg-surface-hover/20'
                  }`}
                  onClick={() => {
                    focusSession(it.id, { preferGrid: true })
                    toggle(false)
                  }}
                  data-testid={`inbox-item-${it.id}`}
                >
                  <StateDot state={it.state} />
                  <span className={`truncate text-md ${it.unread ? 'text-ink' : 'text-ink-muted'}`}>
                    {it.name}
                  </span>
                  <span className="truncate text-xs text-ink-faint">
                    {(it.projectId ? projects[it.projectId]?.name : 'Orchestrator') ?? ''}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-2.5">
                    <span className="text-xs text-ink-faint">
                      {it.state === 'waiting_approval'
                        ? 'Needs approval'
                        : it.state === 'error'
                          ? 'Error'
                          : 'Waiting for input'}
                    </span>
                    {/* The longer the wait, the brighter it gets — time pressure is stated without any new shape */}
                    <span className={`readout w-16 text-right text-xs ${waitingTone(it.waitingMs)}`}>
                      {formatWaiting(it.waitingMs)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
