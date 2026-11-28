import { useMemo, useState } from 'react'
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
  const folded = useStore((s) => s.foldedProjects.includes(projectId))
  // Until the saved folds are read the list is drawn open; folding then is not the person's, so it does not slide
  const workspaceReady = useStore((s) => s.workspaceReady)
  const toggleFold = () => useStore.getState().toggleProjectFold(projectId)
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
      Each project sits on its own raised card so a name on the left pairs with its right-aligned status counts without
      dividers. The open project's whole card is tinted (/30), under the row's own mark (/40 and the bar). Focus lane only.
    */
    <section
      className={`relative rounded-lg py-2 ring-1 ring-inset transition-colors ${
        open ? 'bg-surface-hover/30 ring-line' : 'bg-surface-raised ring-surface-selected'
      } ${away ? 'opacity-60' : ''} ${dropLine(drop.edge)}`}
      data-testid={`project-${project.name}`}
      data-machine={project.machine ?? undefined}
      data-away={away || undefined}
      data-folded={folded || undefined}
      data-selected={open || undefined}
      {...drop.handlers}
    >
      <ProjectHeader
        project={project}
        projectId={projectId}
        folded={folded}
        onToggleFold={toggleFold}
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
