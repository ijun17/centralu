import { useRef, useState } from 'react'
import type { ProjectInfo } from '@cc/protocol'
import type { SessionSummary } from '@cc/core'
import { useStore } from '../../../store/store.js'
import { useIsProjectSelected } from '../../../store/selectors.js'
import { Tooltip } from '../../../components/primitives.jsx'
import { IconButton } from '../../../components/IconButton.jsx'
import { ChevronIcon, DotsIcon, PlusIcon } from '../../../components/icons.jsx'
import { MachineBadge } from '../../machines/MachineTag.jsx'
import { useRemoteIde } from '../../machines/remoteIde.js'
import { PROJECT_MIME } from '../reorder.js'
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
  open,
  sessions,
  setNewAppOpen,
  setDeleting,
}: {
  project: ProjectInfo
  projectId: string
  folded: boolean
  open: boolean
  sessions: SessionSummary[]
  setNewAppOpen: (open: boolean) => void
  setDeleting: (deleting: boolean) => void
}) {
  // A project on a linked machine opens in VS Code over Remote-SSH (#82); null for this computer's, and where that cannot work
  const remoteIde = useRemoteIde(projectId)
  const focusProject = useStore((s) => s.focusProject)
  const openNewSession = useStore((s) => s.openNewSession)
  const startSessionNow = useStore((s) => s.startSessionNow)
  const selected = useIsProjectSelected(projectId)
  // Does the manager's worktree proposal point at this project (#69)? The + button lights up
  const proposalHere = useStore((s) => s.worktreeProposals.some((p) => p.projectId === projectId))
  const [menuOpen, setMenuOpen] = useState(false)
  const setProjectTrusted = useStore((s) => s.setProjectTrusted)
  /** Where the menu hangs from — the pressed button (not a corner of the sidebar) */
  const menuAnchor = useRef<HTMLSpanElement>(null)
  const toggleFold = useStore((s) => s.toggleProjectFold)
  // When expanded, each row's own mark already states its state — do not repeat it on the name line
  const summary = folded ? foldSummary(sessions) : []

  return (
    /*
      Grabbed and moved by its name line — making the whole section draggable would conflict with dragging sessions.

      When the project screen is open this line is marked the way an open session row is — the ink-muted bar and the
      surface-hover/40 band — so the name row and a session row say "open" in one grammar. It replaced an underline
      under the name, which was too faint to find once the group around it was tinted too.

      **The band must not move anything.** A session row is 31.5px tall (py-1.5 around a 13px line); this line
      is only its text. The padding that makes the band a row's height is cancelled by an equal negative margin,
      so every row below stands exactly where it did, and both are always on, so selecting it changes nothing
      but colour. The bar is always there too, transparent until selected. The name starts at 32px, the column every
      level below is measured from (INDENT), with the chevron's 28px gutter just before it (#685).

      Every item on the line is centred on it, not aligned on the text baseline: an icon button has no baseline of its
      own, so the `+`, the ⋯ and the arrow each sat a different distance from the name's centre (2 to 3px).
    */
    <header
      className={`group -my-1.5 flex items-center gap-2 border-l-2 py-1.5 pl-0.5 pr-3 transition-colors ${
        selected ? 'border-l-ink-muted bg-surface-hover/40' : 'border-l-transparent'
      }`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PROJECT_MIME, projectId)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      {/*
        The fold arrow (#205). **This is the one and only door for folding** — the name is where
        the project screen opens (#206), so if pressing it also folded, one of the two would
        always misfire. Expand-on-hover is not used either: if the list expands and collapses as
        the mouse passes over, the row the person meant to press gets shoved out of place, and a
        waiting session gets hidden too (from the original request).

        Unlike that, it is **always visible.** Being folded is a state, not an action, and if it
        only shows on hover there is nowhere to ask why a row is missing. The arrow stands in the
        same gutter a session row's chevron stands in, one level out: a 28px box that ends where the name begins (the
        button is 24px and centred in it, and the box cancels the row's gap), so a session's tool mark starts one
        step right of the name (#685).
      */}
      <span className={`-my-1 -mr-2 flex ${GUTTER_WIDTH} shrink-0 justify-center self-center`}>
        <IconButton
          label={folded ? `Expand ${project.name}` : `Collapse ${project.name}`}
          onClick={() => toggleFold(projectId)}
          testId={`project-fold-${project.name}`}
          className={DISCLOSURE_BUTTON}
        >
          <ChevronIcon open={!folded} size={DISCLOSURE_ICON} />
        </IconButton>
      </span>
      {/*
        Pressing the project name shows git, files and the terminal (without selecting a
        session). Background information like branch, change count or concurrent sessions
        **does not get its own row under the name** — with several projects, those rows would
        stack up and push out the session list that actually needs to be seen. Instead, it is
        answered by a tooltip when asked for (hover, focus).
      */}
      <Tooltip
        content={<ProjectDetail project={project} />}
        testId={`project-tip-${project.name}`}
      >
        <button
          className={`truncate text-left text-md font-medium tracking-tight text-ink transition-colors ${
            selected ? '' : 'hover:text-ink-signal'
          }`}
          onClick={() => focusProject(projectId)}
          aria-current={selected ? 'page' : undefined}
          data-testid={`project-header-${project.name}`}
        >
          {project.name}
        </button>
      </Tooltip>
      {/* Which linked machine it is on (#734), right of its name; this computer's projects carry none */}
      {project.machine && <MachineBadge machine={project.machine} testId={`project-machine-${project.name}`} />}

      {/*
        Only marks that claim no new space stay on the name line.
        Concurrent sessions in particular is a signal that warns of a data-loss risk, and
        hiding it entirely behind a tooltip would violate "show it, do not block it" (FR-2).
      */}
      <ProjectMarks project={project} />
      {summary.length > 0 && <FoldSummary name={project.name} counts={summary} />}
      {/*
        Every action on this row sits behind one button (a dogfooding request).

        `+` (new session) used to be **always visible.** The reason at the time was "new session
        is the most frequent action, so it must not stay invisible until it suddenly appears,"
        and that reason is still right — except that in the meantime this row picked up three
        actions (new session, worktree trunk, delete project). Lining up all three as icons
        would make the button row longer than the project name. So they are folded into one, and
        **it stays hidden by default** instead: a folded button that is always on screen only
        gets in the way of eyes reading the list.

        Hidden, but not made unreachable — keyboard focus (focus-within) and a worktree
        proposal (#69) surface the button without hovering. The proposal case especially:
        making a hidden button breathe is useless if nobody can see it.

        **`+` is back, on the project the person is in** (#529). With it folded into the menu,
        starting a session took three clicks behind a button nobody sees until they hover, and that
        is the task-cost baseline's most expensive everyday task (docs/ux-metrics.md). The project
        that is open is where a new session is most often wanted, and only that one shows `+` all
        the time: one icon on one row, not a row of icons on every project. Elsewhere it appears
        with the menu, on hover or focus.
      */}
      {/*
        While it is hidden it takes no width either (#734): a transparent pair still took 44px of the line, and with a
        machine badge on the line a short name was cut ("notes…") beside empty space. It comes back on hover or focus,
        where the name gives way to it if the line is full.
      */}
      <span
        className={`-my-1 flex shrink-0 items-center transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
          summary.length > 0 ? '' : 'ml-auto'
        } ${open ? 'opacity-100' : 'max-w-0 overflow-hidden opacity-0 focus-within:max-w-none group-hover:max-w-none'}`}
      >
        {/*
          The `+` starts a session at once, with what the project remembers (its last tool and that tool's
          model and effort; #543). Its empty screen offers the past conversations to resume (PastConversations),
          and the project menu's "New session…" still opens the window that chooses a tool or a worktree.
        */}
        <IconButton
          label={`New session in ${project.name}`}
          onClick={() => void startSessionNow(projectId)}
          testId={`project-new-session-${project.name}`}
        >
          <PlusIcon size={14} />
        </IconButton>
      </span>
      <span
        ref={menuAnchor}
        className={`-my-1 shrink-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
          menuOpen || proposalHere ? 'opacity-100' : 'opacity-0'
        } ${proposalHere ? 'breathe rounded-md text-ink' : ''}`}
        data-testid={`project-actions-${project.name}`}
        data-worktree-proposal={proposalHere || undefined}
      >
        {/*
          A plain button, not an IconButton — to drop the tooltip (dogfooding, 2026-09-02).
          Since pressing it opens a named menu right there, a hover tooltip was not an
          explanation but noise left overlapping the open menu. The screen-reader name stays.
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
          onNewSession={() => openNewSession(projectId)}
          // Making an app on another machine is not offered yet (#82): its views open here (remote-hub.md §11), its making does not
          onNewApp={project.machine ? undefined : () => setNewAppOpen(true)}
          onToggleTrust={() => void setProjectTrusted(projectId, !project.trusted)}
          onOpenInVsCode={remoteIde ? () => void remoteIde.open('') : undefined}
          onDelete={() => setDeleting(true)}
        />
      )}
    </header>
  )
}
