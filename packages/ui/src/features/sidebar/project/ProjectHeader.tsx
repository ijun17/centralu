import { useEffect, useRef, useState } from 'react'
import { appKeyOf } from '@cc/core'
import type { ProjectInfo } from '@cc/protocol/client'
import type { SessionSummary } from '@cc/core'
import { useStore } from '../../../store/store.js'
import { useIsProjectSelected } from '../../../store/selectors.js'
import { Tooltip } from '../../../components/primitives.jsx'
import { IconButton } from '../../../components/IconButton.jsx'
import { AppIcon, ChevronIcon, DotsIcon } from '../../../components/icons.jsx'
import type { ExternalCatalogApp } from '../../../store/app-catalog.js'
import { MachineBadge } from '../../machines/MachineTag.jsx'
import { useRemoteIde } from '../../machines/remoteIde.js'
import { APP_MIME, PROJECT_MIME, projectItemMime } from '../reorder.js'
import { usePresence } from '../../../components/presence.js'
import { foldSummary } from '../fold.js'
import { GUTTER_WIDTH, DISCLOSURE_BUTTON, DISCLOSURE_ICON } from '../layout.js'
import { ProjectDetail } from './ProjectDetail.jsx'
import { ProjectMenu } from '../menus/ProjectMenu.jsx'
import { ProjectMarks } from '../marks/ProjectMarks.jsx'
import { FoldSummary } from '../marks/FoldSummary.jsx'

export function ProjectHeader({
  project,
  projectId,
  folded,
  savedFolded,
  onToggleFold,
  onPin,
  onRowEnter,
  onRowLeave,
  onMenuChange,
  sessions,
  rootApp,
  appCount,
  setNewAppOpen,
  setDeleting,
  setInstructing,
}: {
  project: ProjectInfo
  projectId: string
  /** Whether its rows are hidden now: the saved fold, unless hover has expanded it (#1578) */
  folded: boolean
  /** The saved fold alone: what the arrow's label says it will do */
  savedFolded: boolean
  /** The arrow: a hover-expanded project stays; otherwise it folds or unfolds */
  onToggleFold: () => void
  /** A press on the name: a hover-expanded project stays; any other is left as it is */
  onPin: () => void
  /** The mouse pointer came onto / left the name row, any part of it (#1578, #1605); a press counts as leaving */
  onRowEnter: () => void
  onRowLeave: () => void
  /** An open menu keeps a hover-expanded project as it is */
  onMenuChange: (open: boolean) => void
  sessions: SessionSummary[]
  /** The app this project is (#1141): its manifest stands at the project's root */
  rootApp?: ExternalCatalogApp
  /** Its root app and those in `.centralu/apps`: with any, trusting opens the card that lists them */
  appCount: number
  setNewAppOpen: (open: boolean) => void
  setDeleting: (deleting: boolean) => void
  /** The instructions for agents started in the project (#1161 item 2) */
  setInstructing: (open: boolean) => void
}) {
  // A project on a linked machine opens in VS Code over Remote-SSH (#82); null for this computer's, and where that cannot work
  const remoteIde = useRemoteIde(projectId)
  const focusProject = useStore((s) => s.focusProject)
  const openNewSession = useStore((s) => s.openNewSession)
  const startSessionNow = useStore((s) => s.startSessionNow)
  const selected = useIsProjectSelected(projectId)
  // A worktree proposal for this project (#69) lights the ⋯ button
  const proposalHere = useStore((s) => s.worktreeProposals.some((p) => p.projectId === projectId))
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => onMenuChange(menuOpen), [menuOpen, onMenuChange])
  const setProjectTrusted = useStore((s) => s.setProjectTrusted)
  const menuAnchor = useRef<HTMLSpanElement>(null)
  const openApp = useStore((s) => s.openApp)
  const askTrust = useStore((s) => s.askTrust)
  // Lit while the app's screen shows, as an open app row's mark is
  const appShown = useStore(
    (s) =>
      !!rootApp && s.view === 'app' && !!s.focusedApp && appKeyOf(s.focusedApp.projectId, s.focusedApp.appId, s.focusedApp.machine) === rootApp.key,
  )
  // A chain its view started waits on the person (M4 D-4): the mark says so, as an app row's "asks you" does
  const appAsks = useStore((s) => !!rootApp && s.appQuestions.some((q) => q.origin.appId === rootApp.appId && (q.origin.projectId ?? null) === projectId))
  const openRootApp = rootApp ? () => openApp(projectId, rootApp.appId) : undefined
  // Shown open too: drawn only folded, the counts would vanish as the project opens under a resting pointer
  const summary = foldSummary(sessions)
  // Mounted while its last chip fades out, so the line does not jump
  const foldShown = usePresence(summary.length > 0).shown

  return (
    /*
      Dragged by its name line: a draggable section would fight session drags. Open, it is marked as an open session row
      is (bar and /40 band). The band's padding is cancelled by an equal negative margin and both are always on, so
      selecting moves nothing. Items are centred, not on the baseline: icon buttons have none and would sit 2-3px off.
    */
    <header
      className={`group -my-1.5 flex items-center gap-2 border-l-2 py-1.5 pl-0.5 pr-3 transition-colors ${
        selected ? 'border-l-ink-muted bg-surface-hover/40' : 'border-l-transparent'
      }`}
      draggable
      onPointerEnter={(e) => e.pointerType === 'mouse' && onRowEnter()}
      onPointerLeave={(e) => e.pointerType === 'mouse' && onRowLeave()}
      // Pressing anything on the row (the arrow, the name, the menu) is a decision not to wait for the rest
      onPointerDown={(e) => e.pointerType === 'mouse' && onRowLeave()}
      onDragStart={(e) => {
        e.dataTransfer.setData(PROJECT_MIME, projectId)
        // A project that is an app (#1141) also drags as its app row; the project list still reads a reorder
        if (rootApp) {
          e.dataTransfer.setData(APP_MIME, rootApp.key)
          e.dataTransfer.setData(projectItemMime(projectId), projectId)
        }
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      {/*
        The fold arrow (#205), the only door for folding: the name opens the project screen (#206). Always visible, as
        folded is a state. In the chevron gutter one level out (#685; the box cancels the row's gap).
      */}
      <span className={`-my-1 -mr-2 flex ${GUTTER_WIDTH} shrink-0 justify-center self-center`}>
        <IconButton
          label={savedFolded ? `Expand ${project.name}` : `Collapse ${project.name}`}
          onClick={onToggleFold}
          testId={`project-fold-${project.name}`}
          className={DISCLOSURE_BUTTON}
        >
          <ChevronIcon open={!folded} size={DISCLOSURE_ICON} />
        </IconButton>
      </span>
      {/*
        The name opens git, files and the terminal; branch and changes are in its tooltip, not rows that push sessions out
      */}
      {/*
        Name and machine badge (#734) on one baseline: centring suited either "cc" or "APP" but not both. Half the gap
        apart, so the badge reads as part of the name.
      */}
      <span className="flex min-w-0 items-baseline gap-1">
        <Tooltip content={<ProjectDetail project={project} />} testId={`project-tip-${project.name}`}>
          <button
            className={`truncate text-left text-md font-medium tracking-tight text-ink transition-colors ${
              selected ? '' : 'hover:text-ink-signal'
            }`}
            onClick={() => {
              onPin()
              focusProject(projectId)
            }}
            aria-current={selected ? 'page' : undefined}
            data-testid={`project-header-${project.name}`}
          >
            {project.name}
          </button>
        </Tooltip>
        {project.machine && (
          // A pixel up from the shared baseline: the room left for descenders sits the box low against the name
          <MachineBadge machine={project.machine} testId={`project-machine-${project.name}`} className="-translate-y-px" />
        )}
      </span>
      {/*
        The project is an app (#1141): its mark opens it, dimmed and lit as an app row's mark is
      */}
      {rootApp && openRootApp && (
        <span
          className={`-my-1 flex shrink-0 items-center ${rootApp.status.runnable ? '' : 'opacity-50'}`}
          data-testid={`project-app-mark-${project.name}`}
          data-status={rootApp.info.status}
          data-asking={appAsks || undefined}
        >
          <IconButton
            label={`Open the app ${rootApp.title}${rootApp.status.reason ? ` — ${rootApp.status.label.toLowerCase()}: ${rootApp.status.reason}` : ''}${appAsks ? ' — it asks you' : ''}`}
            onClick={openRootApp}
            testId={`project-app-${project.name}`}
            lit={appShown || appAsks}
          >
            <AppIcon />
          </IconButton>
        </span>
      )}

      {/*
        Only marks that claim no new space
      */}
      <ProjectMarks project={project} />
      {foldShown && <FoldSummary name={project.name} counts={summary} />}
      {/*
        Every action is behind the menu; no `+` (#529), which would take the line's width. Hidden by opacity only, so
        nothing moves on hover; focus and a worktree proposal (#69) show it.
      */}
      <span
        ref={menuAnchor}
        className={`-my-1 shrink-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
          foldShown ? '' : 'ml-auto'
        } ${
          menuOpen || proposalHere ? 'opacity-100' : 'opacity-0'
        } ${proposalHere ? 'breathe rounded-md text-ink' : ''}`}
        data-testid={`project-actions-${project.name}`}
        data-worktree-proposal={proposalHere || undefined}
      >
        {/*
          Not an IconButton: a tooltip would overlap the named menu it opens
        */}
        <button
          type="button"
          aria-label={`Actions for ${project.name}`}
          onClick={() => setMenuOpen((v) => !v)}
          data-testid={`project-menu-${project.name}`}
          className="flex items-center justify-center rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-hover/60 hover:text-ink"
        >
          <DotsIcon size={14} />
        </button>
      </span>
      {menuOpen && (
        <ProjectMenu
          project={project}
          anchorEl={menuAnchor.current}
          onClose={() => setMenuOpen(false)}
          // A worktree proposal (#69) waits in the new-session window with its branch filled in; otherwise start at once
          onNewSession={() => (proposalHere ? openNewSession(projectId) : void startSessionNow(projectId))}
          onOpenApp={openRootApp}
          // Not offered on another machine yet (#82): its views open here (remote-hub.md §11), its making does not
          onNewApp={project.machine ? undefined : () => setNewAppOpen(true)}
          // Trusting a project with apps opens the card listing them (#1141); stopping is safe and needs no list
          onToggleTrust={() => (!project.trusted && appCount > 0 ? askTrust(projectId) : void setProjectTrusted(projectId, !project.trusted))}
          trustListsApps={!project.trusted && appCount > 0}
          onOpenInVsCode={remoteIde ? () => void remoteIde.open('') : undefined}
          onAgentInstructions={() => setInstructing(true)}
          onDelete={() => setDeleting(true)}
        />
      )}
    </header>
  )
}
