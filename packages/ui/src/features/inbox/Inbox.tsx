import { useLabelNow } from '../../app/useLabelNow.js'
import { nextWaitingTick } from '../../app/labelClock.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../../store/store.js'
import { useInbox } from '../../store/selectors.js'
import { letterOf } from '../../app/keys.js'
import { useFocusReturn } from '../../components/focusReturn.js'
import { Kbd, StateDot, formatWaiting, waitingTone } from '../../components/primitives.jsx'
import { SessionMachineTag } from '../machines/MachineTag.jsx'
import { RowApproval, rowAnswerFor, useRowsSettled } from '../approval/RowApproval.jsx'

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
  // Before any effect below that moves focus, so the composer, not this layer, is what gets it back (#115)
  useFocusReturn(open)
  const toggle = useStore((s) => s.toggleInbox)
  const focusSession = useStore((s) => s.focusSession)
  const markRead = useStore((s) => s.markRead)
  const respondApproval = useStore((s) => s.respondApproval)
  const projects = useStore((s) => s.projects)
  const items = useInbox(Date.now())
  const [rawCursor, setCursor] = useState(0)
  // Done removes a row, so the cursor can end up past the end: keep it on the last row
  const cursor = Math.min(rawCursor, Math.max(items.length - 1, 0))
  const panelRef = useRef<HTMLDivElement>(null)
  // No row answers an approval while the list is still moving (#543): the order is part of what moves it
  const settled = useRowsSettled(items.map((it) => it.id).join('|'))

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
      } else if (letter === 'd' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Done (#669): marks a finished turn read without opening it. Approvals and errors have no Done.
        const item = items[cursor]
        if (item?.state === 'waiting_input') void markRead(item.id)
      } else if ((letter === 'y' || letter === 'n') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        /*
         * Allow and Deny on the row under the cursor (#543), the approval card's own letters. Only a row that offers
         * them (`rowAnswerFor`), with the request id it shows, and not while the rows are moving or on a held key: the
         * row that slid under the cursor is not the one the person read.
         */
        const item = items[cursor]
        const answer = item && settled && !e.repeat ? rowAnswerFor(useStore.getState().sessions[item.id]) : null
        if (item && answer) void respondApproval(item.id, answer.requestId, letter === 'y' ? 'allow' : 'deny')
      } else if (e.key === 'Escape') toggle(false)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, items, cursor, focusSession, toggle, markRead, respondApproval, settled])

  if (!open) return null

  return (
    <>
      {/*
        Pressing outside closes it. Covers the screen without dimming it — a dropdown does not take the screen away.
        On the press, not the click, and marked data-no-drag: this sits inside the top bar's window drag region, and on
        Windows a window drag swallows the mouseup, so a click never came and the inbox stayed open (#365, DragRegion.tsx).
      */}
      <div className="fixed inset-0 z-30" onMouseDown={() => toggle(false)} data-no-drag data-testid="inbox-backdrop" />
      <div
        ref={panelRef}
        data-no-drag
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
            <Kbd>D</Kbd> Done
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
              <li
                key={it.id}
                className={`border-l-2 transition-colors ${
                  i === cursor ? 'border-l-ink-muted bg-surface-hover/40' : 'border-l-transparent hover:bg-surface-hover/20'
                }`}
              >
                <div className="flex items-center">
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 pr-4 text-left"
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
                    {/* Which machine it waits on (#82): an approval answered here acts there */}
                    <SessionMachineTag sessionId={it.id} testId={`inbox-machine-${it.id}`} />
                    <span className="ml-auto flex shrink-0 items-center gap-2.5">
                      <span className="text-xs text-ink-faint">
                        {it.state === 'waiting_approval'
                          ? 'Needs approval'
                          : it.state === 'error'
                            ? 'Error'
                            : 'Waiting for input'}
                      </span>
                      {/* The longer the wait, the brighter it gets — time pressure is stated without any new shape */}
                      <WaitingTime since={it.waitingSince} />
                    </span>
                  </button>
                  {/* Done (#669): the answer was read elsewhere or needs nothing more; marks it read without opening it */}
                  {it.state === 'waiting_input' && (
                    <button
                      className="mr-3 shrink-0 rounded border border-line px-2 py-0.5 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
                      onClick={() => void markRead(it.id)}
                      aria-label={`Done: ${it.name}`}
                      data-testid={`inbox-done-${it.id}`}
                    >
                      Done
                    </button>
                  )}
                </div>
                {/* What the approval asks, and Allow / Deny where the card's question is a plain yes or no (#543) */}
                {it.state === 'waiting_approval' && (
                  <RowApproval
                    sessionId={it.id}
                    place="inbox"
                    keys={i === cursor}
                    settled={settled}
                    onOpen={() => {
                      focusSession(it.id, { preferGrid: true })
                      toggle(false)
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

function WaitingTime({ since }: { since: number | null }) {
  const next = useCallback((now: number) => since === null ? null : nextWaitingTick(since, now), [since])
  const now = useLabelNow(since === null ? null : next)
  const elapsed = since === null ? 0 : Math.max(0, now - since)
  return <span className={`readout w-16 text-right text-xs ${waitingTone(elapsed)}`}>
    {formatWaiting(elapsed)}
  </span>
}
