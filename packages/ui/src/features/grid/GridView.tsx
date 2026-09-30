import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { columnsFor, rowsFor, visiblePanels } from '@cc/core'
import { useStore } from '../../store/store.js'
import { SessionPane } from '../session/SessionView.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { useOrbitSync } from '../../components/orbit.js'
import { SESSION_MIME, dropsBefore, moveTo as reorderIds } from '../sidebar/reorder.js'
import { GRID_GAP, wholePixelTracks } from './tracks.js'
import { useRealSize } from './real-size.js'

/**
 * Grid — several sessions on one screen.
 *
 * The spec (§5.4) originally left the grid out of v1. The first of three reasons given —
 * "at 600×400 per panel, neither the conversation nor the composer reads well" — still holds.
 * That is why the column count is **computed from the width**, so a panel never shrinks below
 * the minimum width (core's columnsFor). As the window narrows, columns drop, eventually down
 * to one.
 *
 * The height is measured too, but only as a guard — see MAX_PANEL_H. It changes nothing
 * on an ordinary screen, so a panel's shape here is still decided by the width.
 *
 * A panel uses the **same component (SessionPane)** as the focus view. A separate copy would
 * let a model change here leave the sidebar holding a stale value — two screens, but there has
 * to be one truth.
 */
export function GridView() {
  const panels = useStore((s) => s.gridPanels)
  const sessions = useStore((s) => s.sessions)
  /*
   * The selected panel. For a long time "selected" meant nothing in the grid — reasonably so,
   * since twelve panels stand there identically and it is a screen for looking, not reading. It
   * gained meaning once a path opened from notices into the grid (store's preferGrid): the
   * person arriving needs to know **which panel brought them here**, and to type a reply next,
   * the composer of that panel has to already have focus.
   */
  const focusedSessionId = useStore((s) => s.focusedSessionId)
  const foldComposer = useStore((s) => s.foldComposer)
  const focusSession = useStore((s) => s.focusSession)
  const setGridPanels = useStore((s) => s.setGridPanels)
  const ref = useRef<HTMLDivElement>(null)
  /*
   * In real pixels, measured again whenever the size changes, since the column count derives from it
   * (real-size.ts). The height is only a guard — it splits a row off a screen tall enough to make a
   * panel absurd (MAX_PANEL_H)
   */
  const { width, height } = useRealSize(ref)
  /** Which side of which panel the pointer is on — the preview order derives from this */
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null)
  /** The panel currently being dragged. The original is dimmed to show "this is what is moving" */
  const [dragging, setDragging] = useState<string | null>(null)
  /** Reference used to lift the **whole panel**, not just the header, while dragging */
  const cards = useRef(new Map<string, HTMLDivElement>())
  /** Conversation scroll positions, taken right before a reorder — see the layout effect below */
  const scrolls = useRef(new Map<string, number>())

  /*
    Reordering panels moves DOM nodes, and the browser resets a moved node's scrollable
    descendants to scrollTop 0 — scroll is layout state, not a DOM property (measured: a
    pane scrolled to 40 came back at 0 after one insertBefore; the node itself survived,
    so `key={id}` was not the culprit and React never learns anything happened — no effect
    in the pane re-runs). Every reflow step would kick each conversation back to the top.

    So the handlers below snapshot every pane's conversation scroll *before* changing the
    order, and this effect puts the values back before paint. It only acts when a snapshot
    was explicitly taken: restoring on every render would clobber a scroll the user made
    while a message streamed in.
  */
  useLayoutEffect(() => {
    if (scrolls.current.size === 0) return
    for (const [id, top] of scrolls.current) {
      const sc = cards.current.get(id)?.querySelector('[data-testid="chat-stream"]')
      if (sc && sc.scrollTop !== top) sc.scrollTop = top
    }
    scrolls.current.clear()
  })

  /*
   * Put focus on the selected panel's composer.
   *
   * A person coming from notices into the grid came **to reply** — the panel merely lighting up
   * does not tell their hand which composer to type into, leaving them to hunt for it among
   * twelve panels. This value changes in two cases: brought in from outside (the case this
   * effect exists for), and changed by putting a hand on the panel itself (onFocusCapture) — in
   * the latter case the composer already holds focus, so the focus() call below does nothing and
   * never takes focus away from the person.
   */
  useEffect(() => {
    if (!focusedSessionId) return
    const input = cards.current
      .get(focusedSessionId)
      ?.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')
    input?.focus()
  }, [focusedSessionId])

  /** Call before any state change that can reorder the panels */
  const snapshotScroll = () => {
    scrolls.current.clear()
    for (const [id, el] of cards.current) {
      const sc = el.querySelector('[data-testid="chat-stream"]')
      if (sc) scrolls.current.set(id, sc.scrollTop)
    }
  }

  // Do not draw a deleted session even if it is still in the layout (leave the stored value as is)
  const known = new Set(Object.keys(sessions))
  const visible = visiblePanels(panels, known)
  const cols = columnsFor(width, height, visible.length)
  const rows = rowsFor(visible.length, cols)

  /*
    While a panel is dragged the grid rearranges live (#53). The old inset edge line said
    "before/after this neighbour", but the grid reflows on drop — so the line pointed at a
    layout that stopped existing the moment you let go. The only display that cannot lie
    about the destination is the destination itself, so we show it: the drop then changes
    nothing visually.

    The preview is **derived**, not stored. The committed order stays in `panels` until the
    drop, so cancelling (Escape, dropping outside — both surface as dragend without drop)
    is nothing more than clearing `over`. Two states that must agree cannot disagree if one
    of them does not exist. A permutation of the same ids also keeps `cols`/`rows` fixed —
    cells must not change size mid-drag, or the cell the hand is aiming at moves.

    Sidebar drags get no preview: dataTransfer payloads are unreadable during dragover
    (browser security), so the grid cannot know *which* session is inbound until the drop —
    and a phantom new cell would change every cell's size anyway.
  */
  const preview = dragging && over ? reorderIds(visible, dragging, over.id, over.before) : null
  const order = preview ?? visible

  /*
    The border of a spinning panel has to be at the **same angle** as the sidebar's indicator
    (components/orbit.ts). Bringing a session that is already spinning into the grid later would
    otherwise make the panel's orbit start over from zero on its own.
  */
  useOrbitSync(visible.filter((id) => sessions[id]?.state === 'working').join(' '))

  /** Accept a session dragged in from the sidebar — if it is already there, move it to that spot */
  const dropSession = (id: string, targetId: string | null, before: boolean) => {
    if (!known.has(id)) return
    const next = panels.includes(id)
      ? targetId
        ? reorderIds(panels, id, targetId, before)
        : panels
      : targetId
        ? reorderIds([...panels, id], id, targetId, before)
        : [...panels, id]
    void setGridPanels(next)
  }

  return (
    <section
      ref={ref}
      /*
        Does not scroll. If there might be more below, that makes it a list, not a control
        room — "seeing it all at a glance" only holds if what is on screen is everything there is.
      */
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-deck p-2"
      data-testid="grid"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(SESSION_MIME)) e.preventDefault()
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(SESSION_MIME)
        if (!id) return
        e.preventDefault()
        snapshotScroll()
        /*
          Dropping a grid panel on the padding or a gap: the screen is showing the preview,
          so that is what must survive the drop. Falling through to dropSession here would
          append-or-ignore — the arrangement the user is looking at would silently revert.
        */
        if (id === dragging && preview) {
          void setGridPanels(preview)
        } else {
          dropSession(id, null, false)
        }
        setOver(null)
        setDragging(null)
      }}
    >
      {visible.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-center" data-testid="grid-empty">
          <p className="text-[13px] leading-relaxed text-ash">
            Drag sessions here from the sidebar
            <span className="mt-1 block text-[11px] text-slate">
              They keep running — this is another way to look at them
            </span>
          </p>
        </div>
      ) : (
        <div
          /*
            Height is divided up the same way width is. Counting the row count up front and
            giving each row an equal share makes the grid fit the screen exactly no matter how
            many panels there are — no leftover space and nothing overflowing. Shares are cut to
            whole pixels, and the remainder goes to the last row and column (wholePixelTracks).
            The 0 in minmax(0, 1fr) matters: at the default min-content, a panel with more
            content would push its row wider.
          */
          className="grid min-h-0 flex-1"
          style={{
            gap: GRID_GAP,
            gridTemplateColumns: wholePixelTracks(cols),
            gridTemplateRows: wholePixelTracks(rows),
          }}
        >
          {order.map((id) => (
            <div
              key={id}
              ref={(el) => {
                if (el) cards.current.set(id, el)
                else cards.current.delete(id)
              }}
              /*
                A panel that is answering gets a spinning border (the same orbit as the sidebar
                indicator). With several panels on screen, a single small indicator is not
                something the eye can track to find which one is spinning — the grid is a screen
                for **looking**, not reading, so it has to be caught out of the corner of the eye.
              */
              /*
                The selected panel is not highlighted with a border (the conclusion of two
                rounds of dogfooding). The first time, it failed to update, so a single panel
                stayed lit for days; once that was fixed to follow the hand, the judgment came
                back that the indicator was not needed at all — the cursor and the composer's
                focus outline already say where the person is typing. Only the "answering"
                indicator (cc-orbit-ring) remains.
              */
              /*
                The panel's border is brighter than any line inside the panel (user's
                observation, 2026-09-11). Before, the panel was `edge` and the folded input card
                was `graphite`, so **what was inside was brighter than the vessel holding it**,
                and the eye went to the card's curve before the panel's boundary. The two are
                swapped — the panel goes up to `graphite` and the card goes down to `edge`.
              */
              /*
                isolate: the panel contains its own stacking layer.
                The spinning border sits at z-30, because it has to be above the folded composer
                (z-20) inside the panel. But without the panel forming a stacking context, that
                30 leaked outside the panel, and the border was drawn over the file/git overlay
                (z-20) (user's observation). Raising the overlay's number to win would also work,
                but then whoever next picks a number starts the same race over again. For
                "highest within the panel" to actually be true, the panel has to be a fence —
                exactly the method .cc-orbit in the same file uses for the badge.
              */
              className={`relative isolate flex min-h-0 flex-col overflow-hidden rounded-lg border border-graphite bg-void transition-opacity ${
                sessions[id]?.state === 'working' ? 'cc-orbit-ring' : ''
              } ${dragging === id ? 'opacity-40' : ''}`}
              data-focused={focusedSessionId === id || undefined}
              data-testid={`grid-panel-${id}`}
              /*
                The panel the hand touches is the selected panel (dogfooding: on launch it
                stayed frozen on whichever session had been restored, and never moved). It is no
                longer used for drawing anything, but the value still does real work: markRead
                clears this panel's unread mark, and "the last session looked at" (the one
                warmed up on the next launch) becomes the session the hand actually went to.
                Because of preferGrid the view stays put, and since WKWebView does not give focus
                on a button click, the × button does not move it. A project the sidebar has
                collapsed is not expanded (#205) — the session is already visible in this panel,
                and expanding it every time someone types into the panel would make collapsing
                pointless.
              */
              onFocusCapture={() => {
                if (focusedSessionId !== id) focusSession(id, { preferGrid: true, reveal: false })
              }}
              /*
                Where the dragged thing lands relative to this panel. The edge line that used
                to draw this is gone — the reflow shows it — but tests and assistive tech
                still need the relation as a value, not as a pixel position to reverse-engineer.
              */
              data-drop={over?.id === id ? (over.before ? 'before' : 'after') : undefined}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(SESSION_MIME)) return
                e.preventDefault()
                e.stopPropagation()
                /*
                  Over the dragged panel itself: keep the last target instead of clearing it.
                  The reflow routinely puts the dragged panel under the pointer (hover B's far
                  half → the panels swap → the pointer is now on the dragged panel). Clearing
                  here would snap the preview back and the two orders would flicker in a loop.
                */
                if (dragging === id) return
                const r = e.currentTarget.getBoundingClientRect()
                const before = dropsBefore({ top: r.left, height: r.width }, e.clientX)
                // dragover fires continuously, even with the pointer still — only re-render on change
                if (over?.id === id && over.before === before) return
                snapshotScroll()
                setOver({ id, before })
              }}
              onDragEnd={() => {
                // Fires with or without a drop — Escape and dropping outside land here too,
                // and clearing `over` *is* the rollback (the preview is derived from it)
                snapshotScroll()
                setDragging(null)
                setOver(null)
              }}
              onDrop={(e) => {
                const dragged = e.dataTransfer.getData(SESSION_MIME)
                snapshotScroll()
                setOver(null)
                setDragging(null)
                if (!dragged) return
                e.preventDefault()
                e.stopPropagation()
                // A grid panel commits exactly what the preview shows — anything else could
                // make the drop change the screen, which is what #53 removes
                if (dragged === dragging && preview) return void setGridPanels(preview)
                const r = e.currentTarget.getBoundingClientRect()
                dropSession(dragged, id, dropsBefore({ top: r.left, height: r.width }, e.clientX))
              }}
            >
              {/*
                The spinning border is actually drawn by a child layer (cc-orbit-ring-layer in
                styles/index.css). The panel's cc-orbit-ring class remains as a marker that "this
                panel is spinning" — so tests and assistive technology can read the state as a
                value, not as pixels.
              */}
              {sessions[id]?.state === 'working' && <div className="cc-orbit-ring-layer" aria-hidden />}
              {/*
                Removing only takes it off the screen — the session stays in the sidebar and
                keeps running. That is why it is called "remove", not "delete".

                Passed as a header slot. It used to sit absolutely positioned on top of the
                panel, which left its size and height out of sync with the header's restart
                button (12px vs 14px, different flow). Placed on the same line, there is nothing
                left to line up.
              */}
              <SessionPane
                sessionId={id}
                /*
                  Folding the composer exists **only in the grid** (user request, 2026-09-10).
                  The setting came from the reading space being tight in a two-row grid, so
                  folding it in the focus view too, where there is plenty of room, would only
                  leave the person having to unfold it again every time.
                */
                fold={foldComposer}
                /*
                  The **only** handle for moving a panel is the header.
                  The whole panel used to be draggable, but with a draggable ancestor the
                  browser will not let text inside it be selected — selecting text in the
                  conversation dragged the panel instead.

                  At the same time, this header is not a handle for moving the window. In the
                  focus view the header doubles as the title bar, but not here — left as is,
                  trying to move a panel dragged the whole app window instead (dogfooding).
                */
                headerDrag={(e) => {
                  e.dataTransfer.setData(SESSION_MIME, id)
                  e.dataTransfer.effectAllowed = 'move'
                  /*
                     What is being dragged is **the panel**, not the header.
                     Because the draggable element is the header, the browser picked up only the
                     header and carried it around — the panel stayed put and only a thin strip
                     followed the pointer, so nobody could tell what was actually being moved
                     (dogfooding). This swaps the drag image over to the panel.
                   */
                  const card = cards.current.get(id)
                  if (card) {
                    const r = card.getBoundingClientRect()
                    e.dataTransfer.setDragImage(card, e.clientX - r.left, e.clientY - r.top)
                  }
                  setDragging(id)
                }}
                headerExtra={
                  <IconButton
                    label="Remove from the grid (the session keeps running)"
                    onClick={() => void setGridPanels(panels.filter((x) => x !== id))}
                    testId={`grid-remove-${id}`}
                    align="right"
                  >
                    <CloseIcon size={14} />
                  </IconButton>
                }
              />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
