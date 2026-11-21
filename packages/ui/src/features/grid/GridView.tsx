import { useEffect, useLayoutEffect, useMemo, useRef, type DragEvent } from 'react'
import type { GridPanel, GridSpan } from '@cc/protocol/client'
import {
  ONE_CELL,
  appKeyOf,
  arrangeGrid,
  explainGridSpan,
  gridPanelKey,
  gridSpanRoom,
  isUnread,
  packGrid,
  parseAppKey,
  spanClamped,
  visibleGridPanels,
  windowSpanRoom,
  type GridSpanSource,
} from '@cc/core'
import { gridAppViewKey, useStore } from '../../store/store.js'
import { catalogByKey } from '../../store/app-catalog.js'
import { SessionPane } from '../session/SessionView.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { lookOf } from '../session/look.js'
import { APP_MIME, SESSION_MIME, dropsLeft } from '../sidebar/reorder.js'
import { AppPanel } from '../pinned-app/AppPanel.jsx'
import { placeSlots } from '../pinned-app/slots.js'
import { GRID_GAP, wholePixelTracks } from './tracks.js'
import { panelClass, usePanelDrag } from './panelCards.js'
import { useRealSize } from './real-size.js'
import { droppedGridList, droppedGridPanel, gridTakes } from './drop.js'

/**
 * Grid: sessions and apps on one screen (docs/product-spec.md §5.4). Columns come from the width so no panel drops below
 * the minimum width; the height only guards (core's MAX_PANEL_H). A panel is the focus view's SessionPane, one truth for
 * both; an app panel has the grid's own view (`gridAppViewKey`), laid over it from PinnedApps (apps/views.md).
 */
export function GridView() {
  const panels = useStore((s) => s.gridPanels)
  const sessions = useStore((s) => s.sessions)
  const externalApps = useStore((s) => s.externalApps)
  // The app list, keyed the way a dragged app row names its app (`appKeyOf`)
  const appsByKey = useMemo(() => catalogByKey(externalApps), [externalApps])
  const ensureGridAppView = useStore((s) => s.ensureGridAppView)
  const openApp = useStore((s) => s.openApp)
  // The selected panel: one arriving from notices (store's preferGrid) sees which panel brought them, its composer focused
  const focusedSessionId = useStore((s) => s.focusedSessionId)
  const focusSession = useStore((s) => s.focusSession)
  const setGridPanels = useStore((s) => s.setGridPanels)
  const setGridPanelSpan = useStore((s) => s.setGridPanelSpan)
  const appSpans = useStore((s) => s.appSpans)
  const ref = useRef<HTMLDivElement>(null)
  // In real pixels (real-size.ts)
  const { width, height } = useRealSize(ref)
  const { cardOf, place, snapshotScroll, liftPanel, dragging, setDragging, previewOf, dropMark, aim, clearDrag, endDrag } =
    usePanelDrag()

  /*
   * Focus the selected panel's composer: one arriving from notices came to reply. A hand on the panel (onFocusCapture)
   * already put focus there, so then this does nothing.
   */
  useEffect(() => {
    if (!focusedSessionId) return
    const input = cardOf(focusedSessionId)?.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')
    input?.focus()
  }, [focusedSessionId, cardOf])

  // A deleted session or an app the list lacks is not drawn but stays stored. The screen works in core's `gridPanelKey`.
  const known = new Set(Object.keys(sessions))
  const shown = visibleGridPanels(panels, known, new Set(appsByKey.keys()))
  const byKey = new Map(shown.map((p) => [gridPanelKey(p), p] as const))
  const visible = shown.map(gridPanelKey)
  // The cells each panel asks for (#306, core's `explainGridSpan`); a session asks for one
  const askedOf = (id: string): { span: GridSpan; from: GridSpanSource } => {
    const p = byKey.get(id)
    if (!p || p.kind === 'session') return { span: ONE_CELL, from: 'default' }
    const key = appKeyOf(p.projectId, p.appId, p.machine)
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
    While a panel is dragged the grid shows the drop's result live (#53): an edge line would point at a layout the drop
    reflows away. The preview is derived, not stored, so a cancel (dragend without drop) only clears `over`. A sidebar
    drag gets none: dataTransfer data is unreadable during dragover, and a new cell would resize every cell anyway.
  */
  const preview = previewOf(visible)
  const order = preview ?? visible
  // A preview packs into the same columns, so the aimed-at cell keeps its width; with spans its height can change (#53)
  const laid = preview ? packGrid(order.map((id) => askedOf(id).span), cols, gridSpanRoom(cols, height)) : arranged
  const rows = laid.rows

  // Every app on the grid gets a view; the view opens itself (`home`), so an app that cannot run shows why, with a button
  const appKeys = shown.flatMap((p) => (p.kind === 'app' ? [appKeyOf(p.projectId, p.appId, p.machine)] : [])).join('\n')
  useEffect(() => {
    for (const key of appKeys ? appKeys.split('\n') : []) {
      const app = parseAppKey(key)
      if (app) ensureGridAppView(app.projectId, app.appId, app.machine)
    }
  }, [appKeys, ensureGridAppView])

  // After every render: a panel can move without changing size (a drag's preview), and the view laid over it has to move with it
  useLayoutEffect(() => placeSlots())

  const dropped = (e: DragEvent<HTMLElement>): GridPanel | null =>
    droppedGridPanel((type) => e.dataTransfer.getData(type), known, appsByKey)

  /** Accept a session or app dragged in from the sidebar — if it is already there, move it to that spot */
  const dropPanel = (panel: GridPanel, targetId: string | null, before: boolean) => {
    void setGridPanels(droppedGridList(panels, panel, targetId, before))
  }

  /** Commits the order the screen shows while a panel is dragged — the drop must not change the screen (#53) */
  const commitPreview = (order: string[]) => void setGridPanels(order.map((k) => byKey.get(k)!))

  const startDrag = (id: string, e: DragEvent<HTMLElement>) => {
    const p = byKey.get(id)
    if (!p) return
    if (p.kind === 'session') e.dataTransfer.setData(SESSION_MIME, p.sessionId)
    else e.dataTransfer.setData(APP_MIME, appKeyOf(p.projectId, p.appId, p.machine))
    e.dataTransfer.effectAllowed = 'move'
    liftPanel(id, e)
    setDragging(id)
  }

  const removePanel = (id: string) => void setGridPanels(panels.filter((p) => gridPanelKey(p) !== id))

  return (
    <section
      ref={ref}
      // Does not scroll: a glance shows everything there is
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
        // A grid panel dropped on the padding or a gap commits the preview; dropPanel would revert what the screen shows
        if (gridPanelKey(panel) === dragging && preview) {
          commitPreview(preview)
        } else {
          dropPanel(panel, null, false)
        }
        clearDrag()
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
            Rows share the height as columns share the width, so any count fits the screen exactly (wholePixelTracks).
            The 0 in its minmax(0, 1fr): at the default min-content, a panel with more content would widen its row.
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
            const session = panel.kind === 'session' ? sessions[id] : undefined
            const look = session ? lookOf({ ...session, openQuestions: session.pendingQuestions.length, unread: isUnread(session) }) : 'idle'
            const cell = laid.cells[i]!
            const asked = askedOf(id)
            return (
              <div
                key={id}
                ref={place(id)}
                /*
                The whole panel wears the sidebar mark's four looks (`lookOf`, `.cc-panel`): the grid is for looking, and
                a small indicator is lost among panels. The selected panel gets no border: the cursor and focus show it.
              */
                className={panelClass(dragging === id)}
                data-look={look}
                // Placed by hand, not auto-flow: counting the rows needs a spanning panel's place (core's `packGrid`)
                style={{
                  gridColumn: `${cell.col + 1} / span ${cell.cols}`,
                  gridRow: `${cell.row + 1} / span ${cell.rows}`,
                }}
                data-span={`${cell.cols}x${cell.rows}`}
                data-focused={(panel.kind === 'session' && focusedSessionId === id) || undefined}
                data-testid={`grid-panel-${id}`}
                /*
                The touched panel is selected: markRead clears its unread mark, and it is the session warmed up on the
                next launch. preferGrid keeps the view; WKWebView gives no focus on a button click, so × selects nothing.
                A collapsed project stays collapsed (#205): the session already shows here.
              */
                onFocusCapture={() => {
                  // An app's panel holds no session to select
                  if (panel.kind === 'session' && focusedSessionId !== id)
                    focusSession(id, { preferGrid: true, reveal: false })
                }}
                // Where the drag lands relative to this panel, as a value for tests and assistive tech (the reflow draws it)
                data-drop={dropMark(id)}
                onDragOver={(e) => {
                  if (!gridTakes(e.dataTransfer.types)) return
                  e.preventDefault()
                  e.stopPropagation()
                  /*
                  Over the dragged panel itself, `aim` keeps the last target: the reflow often puts it under the pointer,
                  and clearing would snap the preview back and flicker between the two orders.
                */
                  aim(id, e)
                }}
                onDragEnd={endDrag}
                onDrop={(e) => {
                  const dragged = dropped(e)
                  snapshotScroll()
                  clearDrag()
                  if (!dragged) return
                  e.preventDefault()
                  e.stopPropagation()
                  // A grid panel commits exactly the preview, so the drop changes nothing on screen (#53)
                  if (gridPanelKey(dragged) === dragging && preview) return commitPreview(preview)
                  const r = e.currentTarget.getBoundingClientRect()
                  dropPanel(dragged, id, dropsLeft(r, e.clientX))
                }}
              >
                {panel.kind === 'app' ? (
                  <AppPanel
                    app={appsByKey.get(appKeyOf(panel.projectId, panel.appId, panel.machine))}
                    appId={panel.appId}
                    viewKey={gridAppViewKey(panel.projectId, panel.appId, panel.machine)}
                    dragged={dragging === id}
                    onDragStart={(e) => startDrag(id, e)}
                    onOpen={() => openApp(panel.projectId, panel.appId, { machine: panel.machine })}
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
                        appSpans[appKeyOf(panel.projectId, panel.appId, panel.machine)],
                        appsByKey.get(appKeyOf(panel.projectId, panel.appId, panel.machine))?.info.span,
                      ),
                      onPick: (next) => void setGridPanelSpan(id, next),
                      testId: `grid-span-${id}`,
                    }}
                  />
                ) : (
                  /*
                × removes, not deletes: the session keeps running in the sidebar. A header slot, not an absolute
                overlay, so it lines up with the header's restart button.
              */
                  <SessionPane
                    sessionId={id}
                    // Only the grid and project screens fold a short panel's composer; the focus view has room (docs/design-system.md §7)
                    foldWhenShort
                    /*
                  Only the header moves a panel: under a draggable ancestor text cannot be selected. Unlike the focus
                  view's, this header does not move the window.
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
