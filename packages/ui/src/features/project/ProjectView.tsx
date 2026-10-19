import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { appPanelId, arrangePanels, columnsFor, parsePanelId, rowsFor, sessionPanelId, withPanel, withOrder } from '@cc/core'
import { externalAppKey, useStore } from '../../store/store.js'
import { useSessionsOf } from '../../store/selectors.js'
import { useProjectApps } from '../../store/app-catalog.js'
import { SessionPane } from '../session/SessionView.jsx'
import { CloseIcon, PlusIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { Button } from '../../components/Button.jsx'
import { DragRegion } from '../../components/DragRegion.jsx'
import { lookOf } from '../session/look.js'
import { PANEL_MIME, SESSION_MIME, dropsBefore, moveTo as reorderIds } from '../sidebar/reorder.js'
import { GRID_GAP, wholePixelTracks } from '../grid/tracks.js'
import { panelClass, usePanelCards } from '../grid/panelCards.js'
import { useRealSize } from '../grid/real-size.js'
import { placeSlots } from '../pinned-app/slots.js'
import { AppPanel } from '../pinned-app/AppPanel.jsx'
import { dragVerdict, droppedArrangement, droppedPanelId } from './drop.js'

/**
 * The project screen (#203) — what clicking a project's name opens.
 *
 * Like the global grid, it starts empty and remembers only panels the person adds, in order.
 * Creating a session does not add a panel; a session in the trash is unavailable and leaves
 * the screen. Removing a panel leaves the session or app itself untouched.
 *
 * This project's sidebar session and app rows can be dropped here: an absent panel is added
 * where it lands, a visible one moves there (drop.ts). Other projects and the orchestrator
 * are refused during the drag. The global grid keeps its own list across projects.
 *
 * Unlike the grid, the evidence panel stays beside it. The grid dropped it because its sessions
 * belong to different projects, so there is no one repository for it to show; here there is, and
 * "was that actually so" is one glance to the right (product-spec §5.4, objection 1). The panels
 * are measured in the width that is left, so none of them goes below the minimum width either way.
 *
 * An app's panel shows the app's pinned view — the same instance, in the same frame, as opening the
 * app from the sidebar. It cannot be drawn inside the panel (an iframe that moves loses its document),
 * so the panel holds a slot and the pinned view is laid over it (`pinned-app/slots.ts`).
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
  /** Which side of which panel the pointer is on — the preview order derives from this (GridView, #53) */
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const { place, snapshotScroll, liftPanel } = usePanelCards()

  // The sidebar's order is the natural one: its sessions, then its apps
  const present = useMemo(
    () => [...sessions.map((s) => sessionPanelId(s.id)), ...apps.map((a) => appPanelId(a.appId))],
    [sessions, apps],
  )
  const visible = useMemo(() => arrangePanels(present, saved), [present, saved])
  const appsById = useMemo(() => new Map(apps.map((a) => [a.appId, a])), [apps])

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

  // After every render: a panel can move without changing size (a drag's preview), which no
  // resize observer reports, and the app view laid over it has to move with it
  useLayoutEffect(() => placeSlots())

  /*
   * Every app panel shows the app's pinned view, so every app on the screen has one. Opening it is
   * the pinned view's own business (it calls `home` when the app can run), so an untrusted or
   * unconfirmed app stands here with its reason and its button, exactly as it does in the app view.
   */
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
  const preview = dragging && over ? reorderIds(visible, dragging, over.id, over.before) : null
  const order = preview ?? visible

  const remove = (id: string) => {
    snapshotScroll()
    const p = parsePanelId(id)
    // An app's panel is its pinned view: taking it off the screen closes the view, teardown first
    if (p?.kind === 'app') void dismissPinned(externalAppKey(projectId, p.id))
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
  const endDrag = () => {
    snapshotScroll()
    setOver(null)
    setDragging(null)
  }

  /**
   * Is this drag one the screen takes? Its own panel while it is being dragged, or one of the
   * project's sidebar rows — for which the drop cursor is said here, since the window's floor
   * (App.tsx) has already said yes to every drag.
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
    setOver(null)
    return true
  }

  if (!project) return null

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-floor"
      data-testid="project-view"
      onDragOver={(e) => {
        /*
          Another project's session or app, or the orchestrator: no drop cursor anywhere on this
          screen. The window's floor (App.tsx) has already said yes to every drag, so saying
          nothing here would still show one. A drag the page answers 'none' is not dropped at all.
        */
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
            setOver(null)
            setDragging(null)
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
              const look = session ? lookOf({ ...session, openQuestions: session.pendingQuestions.length }) : 'idle'
              return (
                <div
                  key={id}
                  ref={place(id)}
                  // The grid's panel, class for class (panelClass)
                  className={panelClass(dragging === id)}
                  data-look={look}
                  data-testid={`project-panel-${id}`}
                  data-drop={over?.id === id ? (over.before ? 'before' : 'after') : undefined}
                  onDragOver={(e) => {
                    // A sidebar row gets no preview, as on the grid: its data is unreadable until the drop
                    if (!takes(e)) return
                    e.preventDefault()
                    e.stopPropagation()
                    // Over the dragged panel itself: keep the last target, or the preview flickers (GridView)
                    if (dragging === id) return
                    const r = e.currentTarget.getBoundingClientRect()
                    const before = dropsBefore({ top: r.left, height: r.width }, e.clientX)
                    if (over?.id === id && over.before === before) return
                    snapshotScroll()
                    setOver({ id, before })
                  }}
                  onDragEnd={endDrag}
                  onDrop={(e) => {
                    if (!e.dataTransfer.types.includes(PANEL_MIME)) {
                      // A sidebar row lands before or after this panel, by the half it is dropped on (GridView).
                      // Refused, it goes on to the screen, which refuses it too
                      const r = e.currentTarget.getBoundingClientRect()
                      if (!dropRow(e, id, dropsBefore({ top: r.left, height: r.width }, e.clientX))) return
                      e.preventDefault()
                      e.stopPropagation()
                      return
                    }
                    if (!dragging) return
                    e.preventDefault()
                    e.stopPropagation()
                    snapshotScroll()
                    /*
                      Commit exactly what the preview shows — the drop must not change the screen (#53).
                      With no preview yet it lands on the half it is let go over, as on the grid (GridView):
                      React renders a dragover's update in a later task, so a quick release can come before
                      the preview of its last dragover is on the screen, and that drop used to be lost (#509).
                    */
                    const r = e.currentTarget.getBoundingClientRect()
                    const before = dropsBefore({ top: r.left, height: r.width }, e.clientX)
                    const next = preview ?? (dragging === id ? null : reorderIds(visible, dragging, id, before))
                    if (next) arrange(projectId, withOrder(present, saved, next))
                    setOver(null)
                    setDragging(null)
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
                      viewKey={externalAppKey(projectId, p.id)}
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
