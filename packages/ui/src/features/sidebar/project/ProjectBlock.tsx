import { useMemo, useState } from 'react'
import { isAway } from '@cc/core'
import { groupProjectAppSessions } from '../tree.js'
import { useStore } from '../../../store/store.js'
import { NewSessionDialog } from '../../project/NewSessionDialog.jsx'
import { NewAppDialog } from '../../project/NewAppDialog.jsx'
import { DeleteProjectDialog } from '../../project/DeleteProjectDialog.jsx'
import { useIsProjectOpen, useSessionsOf } from '../../../store/selectors.js'
import { useProjectApps } from '../../../store/app-catalog.js'
import { PROJECT_MIME, moveTo } from '../reorder.js'
import { useDropLine, dropLine } from '../dragDrop.js'
import { TrustAsk } from './TrustAsk.jsx'
import { AppRows } from '../apps/AppRows.jsx'
import { ProjectHeader } from './ProjectHeader.jsx'
import { ProjectSessionList } from './ProjectSessionList.jsx'
import { ProjectSessionDialogs } from './ProjectSessionDialogs.jsx'

export function ProjectBlock({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects[projectId])
  const sessions = useSessionsOf(projectId)
  // Whether the dialog is open is held by the store — the first-run screen also needs to open this dialog
  const newSessionOpen = useStore((s) => s.newSessionFor === projectId)
  const openNewSession = useStore((s) => s.openNewSession)
  const [confirming, setConfirming] = useState<string | null>(null)
  /** The session whose handoff confirmation dialog is open (null when none is) */
  const [handingOff, setHandingOff] = useState<string | null>(null)
  /** The open session menu — since there are many rows, the anchor is the pressed button element, not a ref */
  const [sessionMenu, setSessionMenu] = useState<{ id: string; el: HTMLElement } | null>(null)
  /** The session whose name is currently being edited. Only one at a time — with two rows as inputs
   * simultaneously there is no way to tell which one is active */
  const [renaming, setRenaming] = useState<string | null>(null)
  const reorderProjects = useStore((s) => s.reorderProjects)
  // Its screen or one of its sessions is on screen — the whole group is tinted (see the section below)
  const open = useIsProjectOpen(projectId)
  // New app dialog (M4 C-1) — opened from the project row's menu, like the new session dialog
  const [newAppOpen, setNewAppOpen] = useState(false)
  // Is trust being asked about right after registration (M4, decision 3)? Asked only once, then dismissed once answered
  const askingTrust = useStore((s) => s.trustAsk === projectId)
  // This project's apps (M4 B-2) — stand below the sessions, in the same row shape
  const projectApps = useProjectApps(projectId)
  const groupedSessions = useMemo(() => groupProjectAppSessions(sessions, projectApps.map((app) => app.appId)), [sessions, projectApps])
  const [deleting, setDeleting] = useState(false)
  // Fold state (#205) — held by the store: remembered per project and persists across restarts
  const folded = useStore((s) => s.foldedProjects.includes(projectId))
  /*
   * On a linked machine that is away (#82): its rows stay, from what the hub last heard, dimmed so they read as not
   * current. Nothing about them changes on its own until the machine is back.
   */
  const away = useStore((s) => isAway(s.projects[projectId], s.machines))

  /*
   * Hooks are called **before any early return**. If even one render happens without a project,
   * the hook order shifts and React throws — the kind of crash that hits right when a project is
   * being deleted.
   */
  const drop = useDropLine(PROJECT_MIME, (draggedId, before) => {
    const ids = Object.keys(useStore.getState().projects)
    void reorderProjects(moveTo(ids, draggedId, projectId, before))
  })

  if (!project) return null

  return (
    /*
      Which project is on screen, stated in two layers (user request, 2026-10-01): the whole group — its name row,
      its sessions and its apps, between two of the dividers below — is tinted, and the one row that is open keeps
      the row mark inside it. A row mark alone says "this row"; with several projects open in the list the eye then
      has to walk up to find whose row it is, and a folded project has no row to mark at all.

      The tint is the selected Grid and Orchestrator buttons' surface-hover, at the strength of a row's hover rather than
      a button's fill: it covers a dozen rows, and at full strength the group would outshine the row that is open in
      it. It stays well under that row's own mark (surface-hover/40 plus the ink-muted bar), which is what keeps the two layers
      reading as "this project, and this row in it". It is drawn only for the focus lane (openProjectOf) — the grid
      and the orchestrator light their own buttons.

      The divider is the section's own bottom border. A colour change adds no size, so selecting a project moves
      nothing in the list.
    */
    <section
      className={`relative border-b border-line/70 py-2.5 transition-colors ${open ? 'bg-surface-hover/20' : ''} ${away ? 'opacity-60' : ''} ${dropLine(drop.edge)}`}
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
        open={open}
        sessions={sessions}
        setNewAppOpen={setNewAppOpen}
        setDeleting={setDeleting}
      />

      {askingTrust && <TrustAsk project={project} />}

      {/*
        Folding removes the session rows and the app rows together (#205). The trust question
        (above) stays — it is not a row, it is a question waiting for an answer. Dialogs (below)
        stay too: folding is a way of viewing, not closing whatever work was in progress.

        **A session cannot be dropped onto a folded project.** A session only changes position
        within its own project (onReorder only touches that project's own list), and the drop spot
        is a session row — a folded project has no rows, so no line appears and dropping does
        nothing. It also does not expand while being dragged over: the whole point of expanding it
        to show it would be a spot that never accepts the drop anyway. If a session's own project
        is folded, there is no row to drag from it in the first place.
      */}
      {!folded && (
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
      )}
      {!folded && <AppRows apps={projectApps} sessionsByApp={groupedSessions.byApp} testId={`project-apps-${project.name}`} />}

      {newSessionOpen && <NewSessionDialog projectId={projectId} onClose={() => openNewSession(null)} />}
      {newAppOpen && <NewAppDialog projectId={projectId} onClose={() => setNewAppOpen(false)} />}
      {deleting && <DeleteProjectDialog project={project} onClose={() => setDeleting(false)} />}

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
