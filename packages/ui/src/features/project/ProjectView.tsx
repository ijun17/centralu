import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { appPanelId, arrangePanels, columnsFor, parsePanelId, rowsFor, sessionPanelId, withHidden, withOrder } from '@cc/core'
import { externalAppKey, useStore } from '../../store/store.js'
import { useSessionsOf } from '../../store/selectors.js'
import { useProjectApps } from '../../store/app-catalog.js'
import { SessionPane } from '../session/SessionView.jsx'
import { CloseIcon, PlusIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { DragRegion } from '../../components/DragRegion.jsx'
import { useOrbitSync } from '../../components/orbit.js'
import { PANEL_MIME, SESSION_MIME, dropsBefore, moveTo as reorderIds } from '../sidebar/reorder.js'
import { GRID_GAP, wholePixelTracks } from '../grid/tracks.js'
import { useRealSize } from '../grid/real-size.js'
import { placeSlots } from '../pinned-app/slots.js'
import { AppPanel } from '../pinned-app/AppPanel.jsx'
import { dragVerdict, droppedArrangement, droppedPanelId } from './drop.js'

/**
 * The project screen (#203) — what clicking a project's name opens.
 *
 * It shows **everything the project has** — its sessions and its apps — as panels, laid out and
 * moved the way the grid lays out and moves sessions. Nobody has to put a panel here: a session
 * created in the project appears at the end, a session sent to the trash (#204) is gone because it
 * is no longer in the session list, and a panel the person does not want is hidden, not deleted.
 * What is remembered, per project and across restarts, is only the person's hand: the order they
 * dragged panels into and what they hid (core's `arrangePanels`, the store's `projectPanels`).
 *
 * The project's sidebar rows can be dropped here the way sessions are dropped on the grid: a
 * hidden one comes back where it lands, a visible one moves there (drop.ts). Only this project's —
 * another project's session or app, and the orchestrator, are refused while still being dragged.
 *
 * The global grid is untouched by any of this. It keeps its own hand-picked list across projects;
 * this screen is one project, whole. A session can be on both, the way it can be on the grid and
 * in the sidebar — they are ways of looking, and the session is one.
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
  const foldComposer = useStore((s) => s.foldComposer)
  const ref = useRef<HTMLDivElement>(null)
  // Real pixels, as in GridView: the text scale enlarges letters, not the minimum panel (real-size.ts)
  const { width, height } = useRealSize(ref)
  /** Which side of which panel the pointer is on — the preview order derives from this (GridView, #53) */
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const cards = useRef(new Map<string, HTMLDivElement>())
  /** Conversation scroll positions, taken right before a reorder — GridView has the measurement */
  const scrolls = useRef(new Map<string, number>())

  // The sidebar's order is the natural one: its sessions, then its apps
  const present = useMemo(
    () => [...sessions.map((s) => sessionPanelId(s.id)), ...apps.map((a) => appPanelId(a.appId))],
    [sessions, apps],
  )
  const visible = useMemo(() => arrangePanels(present, saved), [present, saved])
  const hidden = useMemo(() => (saved?.hidden ?? []).filter((id) => present.includes(id)), [saved, present])
  const appsById = useMemo(() => new Map(apps.map((a) => [a.appId, a])), [apps])

  // Same as GridView: moving a DOM node resets its scroll, so it is put back before paint
  useLayoutEffect(() => {
    if (scrolls.current.size === 0) return
    for (const [id, top] of scrolls.current) {
      const sc = cards.current.get(id)?.querySelector('[data-testid="chat-stream"]')
      if (sc && sc.scrollTop !== top) sc.scrollTop = top
    }
    scrolls.current.clear()
  })
  const snapshotScroll = () => {
    scrolls.current.clear()
    for (const [id, el] of cards.current) {
      const sc = el.querySelector('[data-testid="chat-stream"]')
      if (sc) scrolls.current.set(id, sc.scrollTop)
    }
  }

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

  const working = sessions.filter((s) => s.state === 'working' && visible.includes(sessionPanelId(s.id)))
  useOrbitSync(working.map((s) => s.id).join(' '))

  const hide = (id: string) => {
    snapshotScroll()
    const p = parsePanelId(id)
    // An app's panel is its pinned view: taking it off the screen closes the view, teardown first
    if (p?.kind === 'app') void dismissPinned(externalAppKey(projectId, p.id))
    arrange(projectId, withHidden(present, saved, id, true))
  }
  const show = (id: string) => {
    snapshotScroll()
    arrange(projectId, withHidden(present, saved, id, false))
  }
  const labelOf = (id: string): string => {
    const p = parsePanelId(id)
    if (p?.kind === 'app') return appsById.get(p.id)?.title ?? p.id
    return (p && sessions.find((s) => s.id === p.id)?.name) || id
  }

  const startDrag = (id: string, e: DragEvent<HTMLElement>) => {
    e.dataTransfer.setData(PANEL_MIME, id)
    // A session's panel also carries the session, so it can be dropped on the Grid button like a sidebar row
    const p = parsePanelId(id)
    if (p?.kind === 'session') e.dataTransfer.setData(SESSION_MIME, p.id)
    e.dataTransfer.effectAllowed = 'move'
    // The panel is lifted, not its header (GridView)
    const card = cards.current.get(id)
    if (card) {
      const r = card.getBoundingClientRect()
      e.dataTransfer.setDragImage(card, e.clientX - r.left, e.clientY - r.top)
    }
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
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-void"
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
      <DragRegion className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-edge px-4 py-2">
        <h1 className="truncate text-[13px] font-medium text-chalk" data-testid="project-view-name">
          {project.name}
        </h1>
        <span className="readout truncate text-[11px] text-slate">{project.path}</span>
        {hidden.length > 0 && (
          /*
            Hidden panels are named here, one button each, rather than behind a menu: a panel that
            left the screen with no trace is a panel nobody remembers hiding.
          */
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1" data-testid="project-hidden">
            <span className="text-[11px] text-slate">Hidden</span>
            {hidden.map((id) => (
              <button
                key={id}
                type="button"
                className="max-w-[160px] truncate rounded border border-edge px-1.5 py-0.5 text-[11px] text-ash transition-colors hover:border-graphite hover:text-chalk"
                onClick={() => show(id)}
                title={`Show ${labelOf(id)} on this screen again`}
                data-testid={`project-show-${id}`}
              >
                {labelOf(id)}
              </button>
            ))}
          </div>
        )}
      </DragRegion>
      <div
        ref={ref}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-deck p-2"
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
            {present.length === 0 ? (
              <>
                <p className="text-[13px] text-ash">Nothing in this project yet</p>
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded border border-edge px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite"
                  onClick={() => openNewSession(projectId)}
                  data-testid="project-empty-new-session"
                >
                  <PlusIcon size={12} /> New session
                </button>
                <p className="text-[11px] text-slate">Its sessions and apps appear here as panels you can arrange</p>
              </>
            ) : (
              // Said the way the empty grid says it — and the names above still bring a panel back
              <p className="text-[13px] leading-relaxed text-ash">
                Drag this project&apos;s sessions and apps here from the sidebar
                <span className="mt-1 block text-[11px] text-slate">
                  They keep running — this is another way to look at them
                </span>
              </p>
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
              const isWorking = !!sessionId && working.some((s) => s.id === sessionId)
              return (
                <div
                  key={id}
                  ref={(el) => {
                    if (el) cards.current.set(id, el)
                    else cards.current.delete(id)
                  }}
                  // The grid's panel, class for class — the ring (#208), the isolation and the colours are its reasons
                  className={`relative isolate flex min-h-0 flex-col overflow-hidden rounded-lg border border-graphite bg-void transition-opacity ${
                    isWorking ? 'cc-orbit-ring' : ''
                  } ${dragging === id ? 'opacity-40' : ''}`}
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
                    // Commit exactly what the preview shows — the drop must not change the screen (#53)
                    if (preview) arrange(projectId, withOrder(present, saved, preview))
                    setOver(null)
                    setDragging(null)
                  }}
                >
                  {isWorking && <div className="cc-orbit-ring-layer" aria-hidden />}
                  {sessionId ? (
                    <SessionPane
                      sessionId={sessionId}
                      fold={foldComposer}
                      headerDrag={(e) => startDrag(id, e)}
                      headerExtra={
                        <IconButton
                          label="Hide from this screen (the session keeps running)"
                          onClick={() => hide(id)}
                          testId={`project-hide-${id}`}
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
                      remove={{ label: 'Hide from this screen (closes its view)', testId: `project-hide-${id}`, onClick: () => hide(id) }}
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
