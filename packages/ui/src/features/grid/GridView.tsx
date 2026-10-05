import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { GridPanel, GridSpan } from '@cc/protocol'
import {
  ONE_CELL,
  appKeyOf,
  arrangeGrid,
  explainGridSpan,
  gridPanelKey,
  gridSpanRoom,
  packGrid,
  parseAppKey,
  spanClamped,
  visibleGridPanels,
  windowSpanRoom,
  type GridSpanSource,
} from '@cc/core'
import { gridAppViewKey, useStore } from '../../store/store.js'
import { buildCatalog } from '../../store/app-catalog.js'
import { SessionPane } from '../session/SessionView.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { useOrbitSync } from '../../components/orbit.js'
import { APP_MIME, SESSION_MIME, dropsBefore, moveTo as reorderIds } from '../sidebar/reorder.js'
import { AppPanel } from '../pinned-app/AppPanel.jsx'
import { placeSlots } from '../pinned-app/slots.js'
import { GRID_GAP, wholePixelTracks } from './tracks.js'
import { useRealSize } from './real-size.js'
import { droppedGridList, droppedGridPanel, gridTakes } from './drop.js'

/**
 * Grid — several sessions, and apps, on one screen.
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
 *
 * An app can stand here too (#288), dropped from its sidebar row like a session, and moved and
 * removed the same way. Its panel shows the app's view the way the project screen does — opened by
 * the app's `home`, laid over the panel from PinnedApps (an iframe that moves loses its document),
 * hidden rather than unloaded while another screen is looked at, torn down first when it is removed
 * — but it is the grid's own view, not the one the app view and the project screen share
 * (`gridAppViewKey`): the same app can stand in both places, each its own document, one process.
 * Nothing puts an app here but a hand; the grid stays "only what was put there".
 *
 * Each app panel costs a view instance on the host and a frame (the sandbox proxy and the app's
 * document inside it) in the page, kept while the grid is left for another screen. Nothing caps
 * their number beyond what the screen fits: the grid holds only what a person put on it, and
 * every panel already needs the minimum width.
 */
export function GridView() {
  const panels = useStore((s) => s.gridPanels)
  const sessions = useStore((s) => s.sessions)
  const externalApps = useStore((s) => s.externalApps)
  // The app list, keyed the way a dragged app row names its app (`externalAppKey`)
  const appsByKey = useMemo(
    () => new Map(buildCatalog([], {}, externalApps).external.map((a) => [a.key, a] as const)),
    [externalApps],
  )
  const ensureGridAppView = useStore((s) => s.ensureGridAppView)
  const openApp = useStore((s) => s.openApp)
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
  const setGridPanelSpan = useStore((s) => s.setGridPanelSpan)
  const appSpans = useStore((s) => s.appSpans)
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

  /*
   * Do not draw a deleted session, or an app the list does not have, even if it is still in the layout (leave the
   * stored value as is). The screen works in panel keys (core's `gridPanelKey`): a session's is its id, an app's
   * `app:<project | _user>/<appId>`.
   */
  const known = new Set(Object.keys(sessions))
  const shown = visibleGridPanels(panels, known, new Set(appsByKey.keys()))
  const byKey = new Map(shown.map((p) => [gridPanelKey(p), p] as const))
  const visible = shown.map(gridPanelKey)
  /*
   * How many cells each panel asks for (#306): a session one, an app what its placement, the person's setting for the
   * app or the app's recommendation says (core's `explainGridSpan`). The columns are chosen with the spans counted in
   * (`arrangeGrid`); with every span 1 × 1 that is the grid `columnsFor` gave before spans existed.
   */
  const askedOf = (id: string): { span: GridSpan; from: GridSpanSource } => {
    const p = byKey.get(id)
    if (!p || p.kind === 'session') return { span: ONE_CELL, from: 'default' }
    const key = appKeyOf(p.projectId, p.appId)
    return explainGridSpan(p.span, appSpans[key], appsByKey.get(key)?.info.span)
  }
  const arranged = arrangeGrid(
    visible.map((id) => askedOf(id).span),
    width,
    height,
  )
  const cols = arranged.cols
  /** The largest span the window has room for — what the span picker calls "fits", and past which a panel says it was cut */
  const room = windowSpanRoom(width, height)

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
   * Every panel's cell. A drag's preview is the same panels in another order, packed into the same columns, so the cell
   * the hand is aiming at keeps its width (#53). With spans the preview can need a row more or less than the committed
   * order — the one case where cells change height mid-drag; the destination it shows is still the real one.
   */
  const laid = preview ? packGrid(order.map((id) => askedOf(id).span), cols, gridSpanRoom(cols, height)) : arranged
  const rows = laid.rows

  /*
    The border of a spinning panel has to be at the **same angle** as the sidebar's indicator
    (components/orbit.ts). Bringing a session that is already spinning into the grid later would
    otherwise make the panel's orbit start over from zero on its own.
  */
  useOrbitSync(
    visible.filter((id) => byKey.get(id)?.kind === 'session' && sessions[id]?.state === 'working').join(' '),
  )

  /*
   * Every app panel shows its view, so every app on the grid has one. Opening it is the view's own business (it calls
   * `home` when the app can run), so an untrusted, invalid or stopped app stands here with its reason and its button.
   */
  const appKeys = shown.flatMap((p) => (p.kind === 'app' ? [appKeyOf(p.projectId, p.appId)] : [])).join('\n')
  useEffect(() => {
    for (const key of appKeys ? appKeys.split('\n') : []) {
      const app = parseAppKey(key)
      if (app) ensureGridAppView(app.projectId, app.appId)
    }
  }, [appKeys, ensureGridAppView])

  /*
   * Any drag's end clears the panel it was last over: a sidebar row let go somewhere else never reaches this screen's
   * own dragend, and a target left behind would be the next panel drag's preview before the hand has moved. The app
   * views laid over the panels need nothing here: their panels cover them for the length of any drag (dragShield.tsx).
   */
  useEffect(() => {
    const end = () => setOver(null)
    document.addEventListener('dragend', end)
    return () => document.removeEventListener('dragend', end)
  }, [])

  // After every render: a panel can move without changing size (a drag's preview), and the view laid over it has to move with it
  useLayoutEffect(() => placeSlots())

  /** What a drop on the grid stands for — a session or an app that exists, or null (drop.ts) */
  const dropped = (e: DragEvent<HTMLElement>): GridPanel | null =>
    droppedGridPanel((type) => e.dataTransfer.getData(type), known, appsByKey)

  /** Accept a session or app dragged in from the sidebar — if it is already there, move it to that spot */
  const dropPanel = (panel: GridPanel, targetId: string | null, before: boolean) => {
    void setGridPanels(droppedGridList(panels, panel, targetId, before))
  }

  /** Commits the order the screen shows while a panel is dragged — the drop must not change the screen (#53) */
  const commitPreview = (order: string[]) => void setGridPanels(order.map((k) => byKey.get(k)!))

  /** A panel's header picked up — the panel carries what its sidebar row carries (drop.ts) */
  const startDrag = (id: string, e: DragEvent<HTMLElement>) => {
    const p = byKey.get(id)
    if (!p) return
    if (p.kind === 'session') e.dataTransfer.setData(SESSION_MIME, p.sessionId)
    else e.dataTransfer.setData(APP_MIME, appKeyOf(p.projectId, p.appId))
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
  }

  /** Removing only takes it off the screen — see the session panel's × below */
  const removePanel = (id: string) => void setGridPanels(panels.filter((p) => gridPanelKey(p) !== id))

  return (
    <section
      ref={ref}
      /*
        Does not scroll. If there might be more below, that makes it a list, not a control
        room — "seeing it all at a glance" only holds if what is on screen is everything there is.
      */
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-deck p-2"
      data-testid="grid"
      onDragOver={(e) => {
        if (gridTakes(e.dataTransfer.types)) e.preventDefault()
      }}
      onDrop={(e) => {
        const panel = dropped(e)
        if (!panel) return
        e.preventDefault()
        snapshotScroll()
        /*
          Dropping a grid panel on the padding or a gap: the screen is showing the preview,
          so that is what must survive the drop. Falling through to dropPanel here would
          append-or-ignore — the arrangement the user is looking at would silently revert.
        */
        if (gridPanelKey(panel) === dragging && preview) {
          commitPreview(preview)
        } else {
          dropPanel(panel, null, false)
        }
        setOver(null)
        setDragging(null)
      }}
    >
      {visible.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-center" data-testid="grid-empty">
          <p className="text-md leading-body text-ink-muted">
            Drag sessions and apps here from the sidebar
            <span className="mt-1 block text-xs text-ink-faint">
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
          {order.map((id, i) => {
            const panel = byKey.get(id)!
            const isWorking = panel.kind === 'session' && sessions[id]?.state === 'working'
            const cell = laid.cells[i]!
            const asked = askedOf(id)
            return (
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
                observation, 2026-09-11). Before, the panel was `line` and the folded input card
                was `line-strong`, so **what was inside was brighter than the vessel holding it**,
                and the eye went to the card's curve before the panel's boundary. The two are
                swapped — the panel goes up to `line-strong` and the card goes down to `line`.
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
                className={`relative isolate flex min-h-0 flex-col overflow-hidden rounded-lg border border-line-strong bg-surface-floor transition-opacity ${
                  isWorking ? 'cc-orbit-ring' : ''
                } ${dragging === id ? 'opacity-40' : ''}`}
                /*
                  Placed by hand rather than by the browser's auto-flow, because a spanning panel's place has to be
                  known to count the rows (core's `packGrid`). With every span 1 × 1 it is the same row-by-row order.
                */
                style={{
                  gridColumn: `${cell.col + 1} / span ${cell.cols}`,
                  gridRow: `${cell.row + 1} / span ${cell.rows}`,
                }}
                data-span={`${cell.cols}x${cell.rows}`}
                data-focused={(panel.kind === 'session' && focusedSessionId === id) || undefined}
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
                  // An app's panel holds no session to select
                  if (panel.kind === 'session' && focusedSessionId !== id)
                    focusSession(id, { preferGrid: true, reveal: false })
                }}
                /*
                Where the dragged thing lands relative to this panel. The edge line that used
                to draw this is gone — the reflow shows it — but tests and assistive tech
                still need the relation as a value, not as a pixel position to reverse-engineer.
              */
                data-drop={over?.id === id ? (over.before ? 'before' : 'after') : undefined}
                onDragOver={(e) => {
                  if (!gridTakes(e.dataTransfer.types)) return
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
                  const dragged = dropped(e)
                  snapshotScroll()
                  setOver(null)
                  setDragging(null)
                  if (!dragged) return
                  e.preventDefault()
                  e.stopPropagation()
                  // A grid panel commits exactly what the preview shows — anything else could
                  // make the drop change the screen, which is what #53 removes
                  if (gridPanelKey(dragged) === dragging && preview) return commitPreview(preview)
                  const r = e.currentTarget.getBoundingClientRect()
                  dropPanel(dragged, id, dropsBefore({ top: r.left, height: r.width }, e.clientX))
                }}
              >
                {/*
                The spinning border is actually drawn by a child layer (cc-orbit-ring-layer in
                styles/index.css). The panel's cc-orbit-ring class remains as a marker that "this
                panel is spinning" — so tests and assistive technology can read the state as a
                value, not as pixels.
              */}
                {isWorking && <div className="cc-orbit-ring-layer" aria-hidden />}
                {panel.kind === 'app' ? (
                  <AppPanel
                    app={appsByKey.get(appKeyOf(panel.projectId, panel.appId))}
                    appId={panel.appId}
                    viewKey={gridAppViewKey(panel.projectId, panel.appId)}
                    dragged={dragging === id}
                    onDragStart={(e) => startDrag(id, e)}
                    onOpen={() => openApp(panel.projectId, panel.appId)}
                    // Removing takes the panel off the screen and closes its view, teardown first (the store's setGridPanels)
                    remove={{
                      label: 'Remove from the grid (closes this view)',
                      testId: `grid-remove-${id}`,
                      onClick: () => removePanel(id),
                    }}
                    slotTestId={`grid-slot-${id}`}
                    openTestId={`grid-open-app-${id}`}
                    span={{
                      asked: asked.span,
                      from: asked.from,
                      shown: { cols: cell.cols, rows: cell.rows },
                      clamped: spanClamped(asked.span, cell, { cols, rows }, room),
                      room,
                      fallback: explainGridSpan(
                        undefined,
                        appSpans[appKeyOf(panel.projectId, panel.appId)],
                        appsByKey.get(appKeyOf(panel.projectId, panel.appId))?.info.span,
                      ),
                      onPick: (next) => void setGridPanelSpan(id, next),
                      testId: `grid-span-${id}`,
                    }}
                  />
                ) : (
                  /*
                Removing only takes it off the screen — the session stays in the sidebar and
                keeps running. That is why it is called "remove", not "delete".

                Passed as a header slot. It used to sit absolutely positioned on top of the
                panel, which left its size and height out of sync with the header's restart
                button (12px vs 14px, different flow). Placed on the same line, there is nothing
                left to line up.
              */
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
                    headerDrag={(e) => startDrag(id, e)}
                    headerExtra={
                      <IconButton
                        label="Remove from the grid (the session keeps running)"
                        onClick={() => removePanel(id)}
                        testId={`grid-remove-${id}`}
                        align="right"
                      >
                        <CloseIcon size={14} />
                      </IconButton>
                    }
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
