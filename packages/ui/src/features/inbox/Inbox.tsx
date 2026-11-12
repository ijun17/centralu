import { usePresence } from '../../components/presence.js'
import { isInTurn, type InboxItem } from '@cc/core'
import { useLabelNow } from '../../app/useLabelNow.js'
import { nextWaitingTick } from '../../app/labelClock.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useKeepInView } from '../../app/useKeepInView.js'
import { isTextEntry, pressesItself } from '../../app/keys.js'
import { useStore } from '../../store/store.js'
import { projectLabelOf } from '../../store/names.js'
import { useInbox } from '../../store/selectors.js'
import { inboxCovered, inboxKeyAction } from './inboxKeys.js'
import { inboxStateLabel } from './inboxLabel.js'
import { useFocusReturn } from '../../components/focusReturn.js'
import {
  CONTINUE_TEXT,
  Kbd,
  StateDot,
  canContinue,
  formatWaiting,
  waitingTone,
} from '../../components/primitives.jsx'
import { SessionMachineTag } from '../machines/MachineTag.jsx'
import { RowApproval, useRowsSettled } from '../approval/RowApproval.jsx'
import { MailPinned, MailThreadItem } from './MailRows.jsx'
import { arrangeInbox, CURSOR_START, rowKeyOf, settleCursor, type InboxCursor } from './inboxList.js'
import { Fold } from '../../components/Fold.jsx'
import { ChevronIcon } from '../../components/icons.jsx'
import { mailAttention } from '../../store/mail.js'
import { useLeavingCards } from './useLeavingCards.js'
import { MailThread } from './MailThread.jsx'

/**
 * The inbox (FR-15) — the entry point for coming back to the desk.
 * Ignores project structure and shows only "what is waiting on me right now": the sessions and the mail in one list,
 * newest first, with the mail that was not delivered pinned on top and what is read or finished folded under
 * "Earlier" (owner, 2026-11-12, #2213).
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
  const toggle = useStore((s) => s.toggleInbox)
  const openWaiting = useStore((s) => s.openWaiting)
  const openMailThread = useStore((s) => s.openMailThread)
  const closeMail = useStore((s) => s.closeMail)
  const markDone = useStore((s) => s.markDone)
  const projects = useStore((s) => s.projects)
  const items = useInbox(Date.now())
  // The person's mailbox (#1347): its threads are rows of the same list, and a thread takes the panel while it is open
  const mailThread = useStore((s) => s.mailThread)
  const closeMailThread = useStore((s) => s.closeMailThread)
  const mail = useStore((s) => s.mail)
  const list = useMemo(() => arrangeInbox(items, mail), [items, mail])
  const shownRows = useLeavingCards(list.waiting)
  // Nothing to act on: what is read is folded under Earlier, which is no reason for the list to look as if something waited
  const nothingWaiting = list.held.length === 0 && list.waiting.length === 0 && !mail?.waiting
  const [earlierOpen, setEarlierOpen] = useState(false)
  /*
    The cursor is on a row, not on a row number: a wait that arrives goes in at the top, and the row the cursor is on
    must not slide away from under the key they press. It takes the top row when the list opens and follows that row
    from then on; ↑ and ↓ walk the one list, mail rows included. `settleCursor` keeps it so on every render (state set
    while rendering, which React redraws at once, not after a commit): a row that has left (Done) hands it to the row now
    at its place.
  */
  const [at, setAt] = useState<InboxCursor>(CURSOR_START)
  const placed = settleCursor(list.waiting, at, open)
  if (placed !== at) setAt(placed)
  const cursor = placed.row
  // The choices of the card the keyboard is on, for the hint: the number keys pick on that card only, never on the one under the pointer
  const onRow = list.waiting[cursor]
  const choices = onRow?.kind === 'mail' ? (onRow.thread.ask?.choices?.length ?? 0) : 0
  const panelRef = useRef<HTMLDivElement>(null)
  useKeepInView(panelRef, cursor)
  // Leaves with its exit (usePresence below), so focus inside it is given back as it closes (#115)
  useFocusReturn(open, panelRef)
  // No row answers an approval while the list is still moving (#543): the order is part of what moves it
  const settled = useRowsSettled(items.map((it) => it.id).join('|'))

  // The list is what it opens on: a thread left open when it closed is not waiting there the next time
  useEffect(() => {
    if (!open) {
      closeMailThread()
      setEarlierOpen(false)
    }
  }, [open, closeMailThread])

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
      // The list's keys only when nothing covers it and no field has the keyboard (#683 review, inboxKeys.ts)
      const action = inboxKeyAction(e, {
        typing: isTextEntry(e.target),
        covered: inboxCovered(useStore.getState()),
        onButton: pressesItself(e.target),
      })
      if (!action) return
      // A thread is open: Esc goes back to the list, and the sessions' keys wait for it
      if (mailThread) {
        if (action === 'close') {
          closeMailThread()
          e.preventDefault()
        }
        return
      }
      const row = list.waiting[cursor]
      const item = row?.kind === 'session' ? row.item : undefined
      const moveTo = (to: number) => setAt({ key: list.waiting[to] ? rowKeyOf(list.waiting[to]) : null, row: to })
      if (action === 'down') moveTo(Math.min(cursor + 1, list.waiting.length - 1))
      else if (action === 'up') moveTo(Math.max(cursor - 1, 0))
      else if (action === 'open') {
        if (item) {
          openWaiting(item.id, { preferGrid: true })
          toggle(false)
        } else if (row?.kind === 'mail') void openMailThread(row.thread.id)
      } else if (action === 'done') {
        // Done (#669): marks a finished turn read without opening it; on an error (#1549) it clears the mark. Approvals have no Done.
        if (item && doneable(item)) void markDone(item.id)
        // A mail thread's Done is its Mark done, on the host (#2226). One a session is working on opens instead: closing it may ask first (`closeStopsWork`). So does a card: a question is answered, never closed by a key
        else if (row?.kind === 'mail') void (row.thread.working === true || row.thread.ask !== null ? openMailThread(row.thread.id) : closeMail('finished', row.thread.id))
      } else if (action === 'choose') {
        // The number is the choice's own, on the card under the cursor: the key presses its button, so it answers exactly what a click would, and never a card that has taken a press already
        const button = row?.kind === 'mail' ? panelRef.current?.querySelector<HTMLButtonElement>(`[data-testid="mail-ask-choices-${CSS.escape(row.thread.id)}-${e.key}"]`) : null
        if (button && !button.disabled) button.click()
      } else if (action === 'allow' || action === 'deny') {
        /*
         * Allow and Deny on the row under the cursor (#543), the approval card's own letters. The key presses the row's
         * own button, and only while it is there and enabled: so a key answers exactly what a click would, never a row
         * that shows Open, has not settled, is already answering, or whose line does not fit (RowApproval).
         */
        const button = item
          ? panelRef.current?.querySelector<HTMLButtonElement>(
              `[data-row-answer="${action}"][data-session="${CSS.escape(item.id)}"]`,
            )
          : null
        if (button && !button.disabled) button.click()
      } else toggle(false)
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, list.waiting, cursor, openWaiting, openMailThread, toggle, markDone, closeMail, mailThread, closeMailThread])

  // Goes back up the way it came down (usePresence keeps it for its exit)
  const { shown, leaving } = usePresence(open)
  if (!shown) return null

  return (
    <>
      {/*
        Pressing outside closes it. Covers the screen without dimming it — a dropdown does not take the screen away.
        On the press, not the click, and marked data-no-drag: this sits inside the top bar's window drag region, and on
        Windows a window drag swallows the mouseup, so a click never came and the inbox stayed open (#365, DragRegion.tsx).
      */}
      {!leaving && (
        <div
          className="fixed inset-0 z-30"
          onMouseDown={() => toggle(false)}
          data-no-drag
          data-testid="inbox-backdrop"
        />
      )}
      <div
        ref={panelRef}
        data-no-drag
        tabIndex={-1}
        role="dialog"
        aria-label="Waiting"
        // Leaving, it takes no keys and no focus (focusReturn.ts)
        inert={leaving}
        className={`${leaving ? 'cc-drop-out pointer-events-none' : 'cc-drop'} absolute left-0 top-full z-40 mt-1 flex max-h-[calc(100vh/var(--text-zoom)-3.5rem)] w-[560px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-bubble border border-line bg-surface-side shadow-(--shadow-modal) focus:outline-none`}
        data-testid="inbox"
      >
        {/*
          The conversation's shapes (owner, 2026-10-18): a 14px card, its rows rounded inside a 4px inset, the row the
          keys are on filled (no edge bar), the row's actions as capsules.
        */}
        {!mailThread && (
          <header className="flex items-baseline gap-2 border-b border-line px-4 py-2.5">
            <h2 className="text-sm font-medium text-ink">Waiting</h2>
            <span className="readout text-xs text-ink-faint" data-testid="inbox-count">
              {items.length + mailAttention(mail)}
            </span>
            <span className="ml-auto flex items-center gap-1 text-2xs text-ink-faint">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> Move
              <Kbd>↵</Kbd> Open
              {choices > 0 && (
                <>
                  <Kbd>1-{choices}</Kbd> Choose
                </>
              )}
              <Kbd>D</Kbd> Done
              <Kbd>esc</Kbd> Close
            </span>
          </header>
        )}

        {mailThread ? (
          <MailThread
            onOpenSession={(id) => {
              openWaiting(id, { preferGrid: true })
              toggle(false)
            }}
          />
        ) : nothingWaiting && list.earlier.length === 0 ? (
          <Nothing />
        ) : (
          // However much there is, the list keeps to the panel and scrolls inside it (#1772); the header stays put
          <div className="flex min-h-0 flex-col overflow-y-auto" data-testid="inbox-list">
            <MailPinned held={list.held} waiting={mail?.waiting ?? 0} />
            {nothingWaiting && <Nothing />}
            {list.waiting.length > 0 && (
              <ul className="flex flex-col gap-0.5 p-1">
                {shownRows.map(({ row, place }) =>
                  row.kind === 'mail' ? (
                    <MailThreadItem key={`m:${row.thread.id}`} thread={row.thread} active={place === cursor} leaving={place === null} />
                  ) : (
                    <SessionRow
                      key={row.item.id}
                      it={row.item}
                      project={projectLabelOf(projects, row.item.projectId)}
                      active={place === cursor}
                      settled={settled}
                      onOpen={() => {
                        openWaiting(row.item.id, { preferGrid: true })
                        toggle(false)
                      }}
                    />
                  ),
                )}
              </ul>
            )}
            {list.earlier.length > 0 && (
              <>
                <button
                  type="button"
                  className="flex items-center gap-1.5 px-4 py-2 text-left text-xs text-ink-faint transition-colors hover:text-ink-muted"
                  aria-expanded={earlierOpen}
                  onClick={() => setEarlierOpen((o) => !o)}
                  data-testid="inbox-earlier-toggle"
                >
                  <ChevronIcon open={earlierOpen} />
                  Earlier
                  <span className="readout">{list.earlier.length}</span>
                </button>
                <Fold open={earlierOpen} testId="inbox-earlier">
                  <ul className="flex flex-col gap-0.5 p-1">
                    {list.earlier.map((t) => (
                      <MailThreadItem key={t.id} thread={t} dim />
                    ))}
                  </ul>
                </Fold>
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}

/** What the list says when nothing waits */
function Nothing() {
  return (
    <p className="px-4 py-10 text-center text-md text-ink-muted" data-testid="inbox-empty">
      Nothing waiting
      <span className="mt-1 block text-xs text-ink-faint">Finished agents collect here</span>
    </p>
  )
}

/** A session of the list: what it waits for, its time, Continue and Done, and the approval it asks, when it is a plain one */
function SessionRow({ it, project, active, settled, onOpen }: { it: InboxItem; project: string; active: boolean; settled: boolean; onOpen: () => void }) {
  const markDone = useStore((s) => s.markDone)
  const send = useStore((s) => s.send)
  return (
    <li
      data-cursor={active || undefined}
      className={`rounded-field transition-colors ${
        active ? 'bg-surface-hover/50' : 'hover:bg-surface-hover/25'
      }`}
    >
      <div className="flex items-center">
        <button
          className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 pr-3 text-left"
          onClick={onOpen}
          data-testid={`inbox-item-${it.id}`}
        >
          <StateDot state={it.state} />
          <span className={`truncate text-md ${it.unread ? 'text-ink' : 'text-ink-muted'}`}>
            {it.name}
          </span>
          <span className="truncate text-xs text-ink-faint">
            {project}
          </span>
          {/* Which machine it waits on (#82): an approval answered here acts there. A proposal is this host's */}
          {!it.proposal && !it.arrival && (
            <SessionMachineTag sessionId={it.id} testId={`inbox-machine-${it.id}`} />
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2.5">
            <span
              className="max-w-64 truncate text-xs text-ink-faint"
              title={it.arrival ? arrivalAsks(it.arrival.asks) : undefined}
              data-testid={it.arrival ? `inbox-arrival-asks-${it.id}` : undefined}
            >
              {it.arrival ? arrivalAsks(it.arrival.asks) : inboxStateLabel(it)}
            </span>
            {/* The longer the wait, the brighter it gets — time pressure is stated without any new shape */}
            <WaitingTime since={it.waitingSince} />
          </span>
        </button>
        {/*
          Continue (#698): a turn the network, a quit or its tool cut short goes on with one message; the agent
          still has its conversation. Never sent by itself: a resent turn can repeat a push or a release.
        */}
        {canContinue(it.interruption) && !isInTurn(it.state) && (
          <button
            className="mr-1.5 shrink-0 rounded-full border border-line px-2.5 py-0.5 text-xs text-ink transition-colors hover:bg-surface-hover"
            onClick={() => void send(it.id, CONTINUE_TEXT)}
            aria-label={`Continue: ${it.name}`}
            title={`Sends "${CONTINUE_TEXT}"`}
            data-testid={`inbox-continue-${it.id}`}
          >
            Continue
          </button>
        )}
        {/* Done (#669): the answer was read elsewhere or needs nothing more; marks it read without opening it */}
        {doneable(it) && (
          <button
            className="mr-2 shrink-0 rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            onClick={() => void markDone(it.id)}
            aria-label={`Done: ${it.name}`}
            data-testid={`inbox-done-${it.id}`}
          >
            Done
          </button>
        )}
      </div>
      {/* What the approval asks, and Allow / Deny where the card's question is a plain yes or no (#543) */}
      {it.state === 'waiting_approval' && !it.proposal && (
        <RowApproval
          sessionId={it.id}
          keys={active}
          settled={settled}
          onOpen={onOpen}
        />
      )}
    </li>
  )
}

function WaitingTime({ since }: { since: number | null }) {
  const next = useCallback((now: number) => (since === null ? null : nextWaitingTick(since, now)), [since])
  const now = useLabelNow(since === null ? null : next)
  const elapsed = since === null ? 0 : Math.max(0, now - since)
  return (
    <span className={`readout w-16 text-right text-xs ${waitingTone(elapsed)}`}>
      {formatWaiting(elapsed)}
    </span>
  )
}

/** Rows Done applies to (#669): a finished turn, and a turn a quit stopped (#698), both listed only while unread; and an error (#1549) */
function doneable(it: { state: string; interruption?: { reason: string } | null }): boolean {
  return it.state === 'waiting_input' || it.state === 'error' || (it.state === 'idle' && !!it.interruption)
}

/**
 * What an app a trusted project gained declares it may ask for (#1141), for its inbox notice: it is trusted with the
 * project, so this is what that trust now lets it ask
 */
function arrivalAsks(asks: readonly string[]): string {
  return asks.length > 0 ? `Trusted with its project. May ask to: ${asks.map((a) => a.charAt(0).toLowerCase() + a.slice(1)).join('; ')}` : 'Trusted with its project. Asks for nothing beyond its own tools'
}
