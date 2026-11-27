import { useEffect, useMemo, useRef, useState } from 'react'
import { isAway } from '@cc/core'
import { groupProjectAppSessions } from '../tree.js'
import { useStore } from '../../../store/store.js'
import { NewSessionDialog } from '../../project/NewSessionDialog.jsx'
import { NewAppDialog } from '../../project/NewAppDialog.jsx'
import { DeleteProjectDialog } from '../../project/DeleteProjectDialog.jsx'
import { AgentInstructionsDialog } from '../../project/AgentInstructionsDialog.jsx'
import { useIsProjectOpen, useSessionsOf } from '../../../store/selectors.js'
import { useProjectApps } from '../../../store/app-catalog.js'
import { PROJECT_MIME, moveTo } from '../reorder.js'
import { useDropLine, dropLine } from '../dragDrop.js'
import { HoverExpander } from '../fold.js'
import { Fold } from '../../../components/Fold.jsx'
import { TrustAsk } from './TrustAsk.jsx'
import { AppRows } from '../apps/AppRows.jsx'
import { ProjectHeader } from './ProjectHeader.jsx'
import { ProjectSessionList } from './ProjectSessionList.jsx'
import { ProjectSessionDialogs } from './ProjectSessionDialogs.jsx'

export function ProjectBlock({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects[projectId])
  const sessions = useSessionsOf(projectId)
  // In the store: the first-run screen opens this dialog too
  const newSessionOpen = useStore((s) => s.newSessionFor === projectId)
  const openNewSession = useStore((s) => s.openNewSession)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [handingOff, setHandingOff] = useState<string | null>(null)
  /** Anchored to the pressed button element, as there are many rows */
  const [sessionMenu, setSessionMenu] = useState<{ id: string; el: HTMLElement } | null>(null)
  /** One rename at a time: with two rows as inputs, which one is active is unclear */
  const [renaming, setRenaming] = useState<string | null>(null)
  const reorderProjects = useStore((s) => s.reorderProjects)
  // Its screen or one of its sessions is on screen: the whole group is tinted
  const open = useIsProjectOpen(projectId)
  const [newAppOpen, setNewAppOpen] = useState(false)
  // Trust asked once, after registration (M4, decision 3)
  const askingTrust = useStore((s) => s.trustAsk === projectId)
  const apps = useProjectApps(projectId)
  // A root app (#1141) is the project itself: marked on its line (ProjectHeader), no row; its sessions are the project's
  const rootApp = apps.find((a) => a.info.root === true)
  const projectApps = useMemo(() => apps.filter((a) => a.info.root !== true), [apps])
  const groupedSessions = useMemo(() => groupProjectAppSessions(sessions, projectApps.map((app) => app.appId)), [sessions, projectApps])
  const [deleting, setDeleting] = useState(false)
  // The instructions for agents started here (#1161 item 2)
  const [instructing, setInstructing] = useState(false)
  // Fold state (#205), kept per project across restarts
  const savedFolded = useStore((s) => s.foldedProjects.includes(projectId))
  // Until the saved folds are read the list is drawn open; folding then is not the person's, so it does not slide
  const workspaceReady = useStore((s) => s.workspaceReady)
  const toggleFold = (id: string) => useStore.getState().toggleProjectFold(id)
  // Hover expansion (#1578, HoverExpander); a click pins it, the saved fold taking over. It counts only while saved folded
  const [hoverOpen, setHoverOpen] = useState(false)
  const hoverActive = savedFolded && hoverOpen
  const folded = savedFolded && !hoverOpen
  const sectionRef = useRef<HTMLElement>(null)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const expander = useMemo(
    () => new HoverExpander({ onChange: setHoverOpen, pointerInside: () => !!sectionRef.current?.matches(':hover') }),
    [],
  )
  // An open menu, a name being edited or a drag keeps the project as it is until it ends
  const holding = headerMenuOpen || sessionMenu !== null || renaming !== null || dragging
  useEffect(() => expander.hold(holding), [expander, holding])
  useEffect(() => {
    if (!savedFolded) expander.reset()
  }, [expander, savedFolded])
  useEffect(() => () => expander.reset(), [expander])
  /** A hover-expanded project stays open; otherwise the fold toggles as the arrow does */
  const toggleFoldFromClick = () => {
    if (hoverActive) expander.reset()
    toggleFold(projectId)
  }
  const pinHoverExpanded = () => {
    // Pressing the name of a folded project is a decision not to wait for the rest: no expansion follows it
    if (!hoverActive) return expander.leaveRow()
    expander.reset()
    toggleFold(projectId)
  }
  // An away machine (#82): its rows, as the hub last heard them, stay dimmed
  const away = useStore((s) => isAway(s.projects[projectId], s.machines))

  // Before the early return: a render without a project (as it is deleted) would shift the hook order and throw
  const drop = useDropLine(PROJECT_MIME, (draggedId, before) => {
    const ids = Object.keys(useStore.getState().projects)
    void reorderProjects(moveTo(ids, draggedId, projectId, before))
  })

  if (!project) return null

  return (
    /*
      The open project's whole group is tinted and its open row keeps its mark: a folded project has no row to mark. The
      tint is a row hover's strength (/20), under the row's own mark (/40 and the bar). Focus lane only (openProjectOf).
    */
    <section
      className={`relative rounded-lg py-2.5 transition-colors hover:bg-surface-hover/30 ${open ? 'bg-surface-hover/20' : ''} ${away ? 'opacity-60' : ''} ${dropLine(drop.edge)}`}
      data-testid={`project-${project.name}`}
      data-machine={project.machine ?? undefined}
      data-away={away || undefined}
      data-folded={folded || undefined}
      data-selected={open || undefined}
      data-hover-expanded={(savedFolded && hoverOpen) || undefined}
      ref={sectionRef}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') expander.leaveBlock()
      }}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => setDragging(false)}
      {...drop.handlers}
    >
      <ProjectHeader
        project={project}
        projectId={projectId}
        folded={folded}
        savedFolded={savedFolded}
        onToggleFold={toggleFoldFromClick}
        onPin={pinHoverExpanded}
        onRowEnter={() => expander.enterRow(savedFolded)}
        onRowLeave={() => expander.leaveRow()}
        onMenuChange={setHeaderMenuOpen}
        sessions={sessions}
        rootApp={rootApp}
        appCount={apps.length}
        setNewAppOpen={setNewAppOpen}
        setDeleting={setDeleting}
        setInstructing={setInstructing}
      />

      {askingTrust && <TrustAsk project={project} />}

      {/*
        A fold hides the session and app rows (#205); the trust question and dialogs stay. A folded project takes no
        session drop and does not expand under a drag: a session only moves within its own project.
      */}
      {/*
        The rows slide (#1605); with no rows, no gap under the header
      */}
      <Fold open={!folded} instant={!workspaceReady} className={sessions.length > 0 || projectApps.length > 0 ? 'pt-1.5' : undefined} testId={`project-rows-${project.name}`}>
        <ProjectSessionList
          projectId={projectId}
          sessions={sessions}
          groupedSessions={groupedSessions}
          renaming={renaming}
          setRenaming={setRenaming}
          sessionMenu={sessionMenu}
          setSessionMenu={setSessionMenu}
          setHandingOff={setHandingOff}
          setConfirming={setConfirming}
        />
        <AppRows apps={projectApps} sessionsByApp={groupedSessions.byApp} testId={`project-apps-${project.name}`} />
      </Fold>

      {newSessionOpen && <NewSessionDialog projectId={projectId} onClose={() => openNewSession(null)} />}
      {newAppOpen && <NewAppDialog projectId={projectId} onClose={() => setNewAppOpen(false)} />}
      {deleting && <DeleteProjectDialog project={project} onClose={() => setDeleting(false)} />}
      {instructing && <AgentInstructionsDialog project={project} onClose={() => setInstructing(false)} />}

      <ProjectSessionDialogs
        defaultTool={project.defaultTool ?? ''}
        sessions={sessions}
        confirming={confirming}
        setConfirming={setConfirming}
        handingOff={handingOff}
        setHandingOff={setHandingOff}
      />
    </section>
  )
}
