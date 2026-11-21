import { useEffect, useLayoutEffect, useMemo, useRef, type DragEvent } from 'react'
import { appKeyOf, appPanelId, arrangePanels, columnsFor, isUnread, parsePanelId, rowsFor, sessionPanelId, withOrder, withPanel } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useSessionsOf } from '../../store/selectors.js'
import { useProjectApps } from '../../store/app-catalog.js'
import { SessionPane } from '../session/SessionView.jsx'
import { CloseIcon, PlusIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { Button } from '../../components/Button.jsx'
import { DragRegion } from '../../components/DragRegion.jsx'
import { lookOf } from '../session/look.js'
import { PANEL_MIME, SESSION_MIME, dropsLeft, moveTo as reorderIds } from '../sidebar/reorder.js'
import { GRID_GAP, wholePixelTracks } from '../grid/tracks.js'
import { panelClass, usePanelDrag } from '../grid/panelCards.js'
import { useRealSize } from '../grid/real-size.js'
import { placeSlots } from '../pinned-app/slots.js'
import { AppPanel } from '../pinned-app/AppPanel.jsx'
import { dragVerdict, droppedArrangement, droppedPanelId } from './drop.js'

/**
 * The project screen (#203), opened from a project's name. Like the grid (which keeps its own list), it starts empty
 * and keeps only the panels the person adds, in order; a new session adds none, an archived one leaves, and removing a
 * panel leaves the session or app alone. This project's sidebar rows drop here (drop.ts); others are refused.
 *
 * Unlike the grid, the evidence panel stays beside it: one project has one repository to show (product-spec §5.4,
 * objection 1), and panels are measured in the width left. An app's panel is a slot its pinned view is laid over, the
 * same instance as from the sidebar: an iframe that moves loses its document (`pinned-app/slots.ts`).
 */
export function ProjectView({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects[projectId])
  const sessions = useSessionsOf(projectId)
  const apps = useProjectApps(projectId)
  const saved = useStore((s) => s.projectPanels[projectId])
  const arrange = useStore((s) => s.arrangeProject)
  const ensurePinned = useStore((s) => s.ensurePinnedView)
  const dismissPinned = useStore((s) => s.dismissPinnedView)
  const openNewSession = useStore((s) => s.openNewSession)
  const openApp = useStore((s) => s.openApp)
  const ref = useRef<HTMLDivElement>(null)
  // Real pixels, as in GridView: the text scale enlarges letters, not the minimum panel (real-size.ts)
  const { width, height } = useRealSize(ref)
  const { place, snapshotScroll, liftPanel, dragging, setDragging, previewOf, dropMark, aim, clearOver, clearDrag, endDrag } =
    usePanelDrag()

  // The sidebar's order is the natural one: its sessions, then its apps
  const present = useMemo(
    () => [...sessions.map((s) => sessionPanelId(s.id)), ...apps.map((a) => appPanelId(a.appId))],
    [sessions, apps],
  )
  const visible = useMemo(() => arrangePanels(present, saved), [present, saved])
  const appsById = useMemo(() => new Map(apps.map((a) => [a.appId, a])), [apps])

  // After every render: a panel can move without changing size (a drag's preview), which no
  // resize observer reports, and the app view laid over it has to move with it
  useLayoutEffect(() => placeSlots())

  // Every app on the screen has its pinned view, which opens itself (`home` when the app can run), so an untrusted or
  // unconfirmed app shows its reason and button here as in the app view
  const appKeys = visible.flatMap((id) => {
    const p = parsePanelId(id)
    return p?.kind === 'app' ? [p.id] : []
  })
  const appKeysKey = appKeys.join('\n')
  useEffect(() => {
    for (const appId of appKeysKey ? appKeysKey.split('\n') : []) ensurePinned(projectId, appId)
  }, [appKeysKey, projectId, ensurePinned])

  const cols = columnsFor(width, height, visible.length)
  const rows = rowsFor(visible.length, cols)
  const preview = previewOf(visible)
  const order = preview ?? visible

  const remove = (id: string) => {
    snapshotScroll()
    const p = parsePanelId(id)
    // An app's panel is its pinned view: taking it off the screen closes the view, teardown first
    if (p?.kind === 'app') void dismissPinned(appKeyOf(projectId, p.id))
    arrange(projectId, withPanel(present, saved, id, false))
  }
  const startDrag = (id: string, e: DragEvent<HTMLElement>) => {
    e.dataTransfer.setData(PANEL_MIME, id)
    // A session's panel also carries the session, so it can be dropped on the Grid button like a sidebar row
    const p = parsePanelId(id)
    if (p?.kind === 'session') e.dataTransfer.setData(SESSION_MIME, p.id)
    e.dataTransfer.effectAllowed = 'move'
    // The panel is lifted, not its header (GridView)
    liftPanel(id, e)
    setDragging(id)
  }

  /**
   * Whether the screen takes this drag: its own panel being dragged, or this project's sidebar row, whose drop cursor
   * is set here since the window's floor (App.tsx) says yes to every drag.
   */
  const takes = (e: DragEvent<HTMLElement>): boolean => {
    const verdict = dragVerdict(e.dataTransfer.types, projectId)
    if (verdict === 'add') e.dataTransfer.dropEffect = 'move'
    return verdict === 'add' || (verdict === 'panel' && !!dragging)
  }
  /** A sidebar row dropped before or after the panel `target`, or at the end when it is null (drop.ts) */
  const dropRow = (e: DragEvent<HTMLElement>, target: string | null, before: boolean): boolean => {
    const id = droppedPanelId((type) => e.dataTransfer.getData(type), sessions, apps)
    if (!id) return false
    snapshotScroll()
    const next = droppedArrangement(present, saved, id, target, before)
    if (next) arrange(projectId, next)
    clearOver()
    return true
  }

  if (!project) return null

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-floor"
      data-testid="project-view"
      onDragOver={(e) => {
        // Another project's session or app, or the Assistant: no drop cursor anywhere here, as the floor (App.tsx) says
        // yes to every drag. A drag answered 'none' is not dropped at all.
        if (dragVerdict(e.dataTransfer.types, projectId) === 'refuse') e.dataTransfer.dropEffect = 'none'
      }}
    >
      <DragRegion className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line px-4 py-2">
        <h1 className="truncate text-md font-medium text-ink" data-testid="project-view-name">
          {project.name}
        </h1>
        <span className="readout truncate text-xs text-ink-faint">{project.path}</span>
      </DragRegion>
      <div
        ref={ref}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-deck p-2"
        data-testid="project-grid"
        onDragOver={(e) => {
          if (takes(e)) e.preventDefault()
        }}
        onDrop={(e) => {
          if (e.dataTransfer.types.includes(PANEL_MIME)) {
            // Dropped on the padding or a gap: what the screen shows is what survives (GridView)
            if (!dragging) return
            e.preventDefault()
            snapshotScroll()
            if (preview) arrange(projectId, withOrder(present, saved, preview))
            clearDrag()
            return
          }
          // A sidebar row dropped on the padding, a gap or the empty screen: at the end, as on the grid
          if (dropRow(e, null, false)) e.preventDefault()
        }}
      >
        {visible.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center" data-testid="project-empty">
            <p className="text-md leading-body text-ink-muted">
              Drag this project&apos;s sessions and apps here from the sidebar
              <span className="mt-1 block text-xs text-ink-faint">
                They keep running — this is another way to look at them
              </span>
            </p>
            {sessions.length === 0 && (
              <Button
                className="flex items-center gap-1.5"
                onClick={() => openNewSession(projectId)}
                data-testid="project-empty-new-session"
              >
                <PlusIcon size={12} /> New session
              </Button>
            )}
          </div>
        ) : (
          <div
            className="grid min-h-0 flex-1"
            style={{ gap: GRID_GAP, gridTemplateColumns: wholePixelTracks(cols), gridTemplateRows: wholePixelTracks(rows) }}
          >
            {order.map((id) => {
              const p = parsePanelId(id)
              const sessionId = p?.kind === 'session' ? p.id : null
              const session = sessionId ? sessions.find((s) => s.id === sessionId) : undefined
              const look = session ? lookOf({ ...session, openQuestions: session.pendingQuestions.length, unread: isUnread(session) }) : 'idle'
              return (
                <div
                  key={id}
                  ref={place(id)}
                  // The grid's panel, class for class (panelClass)
                  className={panelClass(dragging === id)}
                  data-look={look}
                  data-testid={`project-panel-${id}`}
                  data-drop={dropMark(id)}
                  onDragOver={(e) => {
                    // A sidebar row gets no preview, as on the grid: its data is unreadable until the drop
                    if (!takes(e)) return
                    e.preventDefault()
                    e.stopPropagation()
                    // Over the dragged panel itself: keep the last target, or the preview flickers (GridView)
                    aim(id, e)
                  }}
                  onDragEnd={endDrag}
                  onDrop={(e) => {
                    if (!e.dataTransfer.types.includes(PANEL_MIME)) {
                      // A sidebar row lands before or after this panel, by the half it is dropped on (GridView).
                      // Refused, it goes on to the screen, which refuses it too
                      const r = e.currentTarget.getBoundingClientRect()
                      if (!dropRow(e, id, dropsLeft(r, e.clientX))) return
                      e.preventDefault()
                      e.stopPropagation()
                      return
                    }
                    if (!dragging) return
                    e.preventDefault()
                    e.stopPropagation()
                    snapshotScroll()
                    // Commit what the preview shows: the drop must not change the screen (#53). With no preview yet it
                    // lands on the half let go over (GridView): React renders a dragover's update in a later task, so a
                    // quick release can beat its preview, and the drop would be lost (#509).
                    const r = e.currentTarget.getBoundingClientRect()
                    const before = dropsLeft(r, e.clientX)
                    const next = preview ?? (dragging === id ? null : reorderIds(visible, dragging, id, before))
                    if (next) arrange(projectId, withOrder(present, saved, next))
                    clearDrag()
                  }}
                >
                  {sessionId ? (
                    <SessionPane
                      sessionId={sessionId}
                      foldWhenShort
                      headerDrag={(e) => startDrag(id, e)}
                      headerExtra={
                        <IconButton
                          label="Remove from this screen (the session keeps running)"
                          onClick={() => remove(id)}
                          testId={`project-remove-${id}`}
                          align="right"
                        >
                          <CloseIcon size={14} />
                        </IconButton>
                      }
                    />
                  ) : p?.kind === 'app' ? (
                    <AppPanel
                      app={appsById.get(p.id)}
                      appId={p.id}
                      viewKey={appKeyOf(projectId, p.id)}
                      dragged={dragging === id}
                      onDragStart={(e) => startDrag(id, e)}
                      onOpen={() => openApp(projectId, p.id)}
                      remove={{ label: 'Remove from this screen (closes its view)', testId: `project-remove-${id}`, onClick: () => remove(id) }}
                      slotTestId={`project-slot-${p.id}`}
                      openTestId={`project-open-app-${p.id}`}
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
