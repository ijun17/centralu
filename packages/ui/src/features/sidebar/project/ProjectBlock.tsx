import { useMemo, useRef, useState } from 'react'
import { isAway } from '@cc/core'
import { groupProjectAppSessions, treeRows } from '../tree.js'
import { childrenGroupKey } from '../../../store/foldGroups.js'
import { handoffBlockedBy, useStore } from '../../../store/store.js'
import { BackgroundMark } from '../../session/BackgroundTasks.jsx'
import { NewSessionDialog } from '../../project/NewSessionDialog.jsx'
import { NewAppDialog } from '../../project/NewAppDialog.jsx'
import { DeleteProjectDialog } from '../../project/DeleteProjectDialog.jsx'
import { useIsProjectOpen, useIsProjectSelected, useSelectedSessionId, useSessionsOf } from '../../../store/selectors.js'
import { Tooltip } from '../../../components/primitives.jsx'
import { IconButton } from '../../../components/IconButton.jsx'
import { ChevronIcon, DotsIcon, PlusIcon } from '../../../components/icons.jsx'
import { useProjectApps } from '../../../store/app-catalog.js'
import { MachineBadge } from '../../machines/MachineTag.jsx'
import { useRemoteIde } from '../../machines/remoteIde.js'
import { PROJECT_MIME, moveTo } from '../reorder.js'
import { foldSummary, groupAttention } from '../fold.js'
import { GUTTER_WIDTH, ROW_MENU_PAD, ROW_PAD, DISCLOSURE_BUTTON, DISCLOSURE_ICON } from '../layout.js'
import { useDropLine, dropLine } from '../dragDrop.js'
import { GroupToggle } from '../rows/GroupToggle.jsx'
import { FoldedMark } from '../marks/FoldedMark.jsx'
import { foldKeys } from '../rows/groupFold.js'
import { SessionRow, approvalLine } from '../rows/SessionRow.jsx'
import { SessionNameInput } from '../rows/SessionNameInput.jsx'
import { TrustAsk } from './TrustAsk.jsx'
import { ProjectDetail } from './ProjectDetail.jsx'
import { AppRows } from '../apps/AppRows.jsx'
import { ConfirmHandoff } from '../dialogs/ConfirmHandoff.jsx'
import { ConfirmDelete } from '../dialogs/ConfirmDelete.jsx'
import { ProjectMenu } from '../menus/ProjectMenu.jsx'
import { SessionMenu } from '../menus/SessionMenu.jsx'
import { ProjectMarks } from '../marks/ProjectMarks.jsx'
import { FoldSummary } from '../marks/FoldSummary.jsx'
import { ToolMark } from '../marks/ToolMark.jsx'

export function ProjectBlock({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects[projectId])
  // A project on a linked machine opens in VS Code over Remote-SSH (#82); null for this computer's, and where that cannot work
  const remoteIde = useRemoteIde(projectId)
  const focusedSessionId = useSelectedSessionId()
  const focusSession = useStore((s) => s.focusSession)
  const sessions = useSessionsOf(projectId)
  // Whether the dialog is open is held by the store — the first-run screen also needs to open this dialog
  const newSessionOpen = useStore((s) => s.newSessionFor === projectId)
  const openNewSession = useStore((s) => s.openNewSession)
  const startSessionNow = useStore((s) => s.startSessionNow)
  const [confirming, setConfirming] = useState<string | null>(null)
  /** The session whose handoff confirmation dialog is open (null when none is) */
  const [handingOff, setHandingOff] = useState<string | null>(null)
  /** The open session menu — since there are many rows, the anchor is the pressed button element, not a ref */
  const [sessionMenu, setSessionMenu] = useState<{ id: string; el: HTMLElement } | null>(null)
  /** The session whose name is currently being edited. Only one at a time — with two rows as inputs
   * simultaneously there is no way to tell which one is active */
  const [renaming, setRenaming] = useState<string | null>(null)
  const renameSession = useStore((s) => s.rename)
  const deleteSession = useStore((s) => s.deleteSession)
  const handoffSession = useStore((s) => s.handoffSession)
  const focusProject = useStore((s) => s.focusProject)
  const reorderProjects = useStore((s) => s.reorderProjects)
  const reorderSessions = useStore((s) => s.reorderSessions)
  const selected = useIsProjectSelected(projectId)
  // Its screen or one of its sessions is on screen — the whole group is tinted (see the section below)
  const open = useIsProjectOpen(projectId)
  // Does the manager's worktree proposal point at this project (#69)? The + button lights up
  const proposalHere = useStore((s) => s.worktreeProposals.some((p) => p.projectId === projectId))
  // New app dialog (M4 C-1) — opened from the project row's menu, like the new session dialog
  const [newAppOpen, setNewAppOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // Is trust being asked about right after registration (M4, decision 3)? Asked only once, then dismissed once answered
  const askingTrust = useStore((s) => s.trustAsk === projectId)
  // This project's apps (M4 B-2) — stand below the sessions, in the same row shape
  const projectApps = useProjectApps(projectId)
  const groupedSessions = useMemo(() => groupProjectAppSessions(sessions, projectApps.map((app) => app.appId)), [sessions, projectApps])
  const setProjectTrusted = useStore((s) => s.setProjectTrusted)
  /** Where the menu hangs from — the pressed button (not a corner of the sidebar) */
  const menuAnchor = useRef<HTMLSpanElement>(null)
  const [deleting, setDeleting] = useState(false)
  // Fold state (#205) — held by the store: remembered per project and persists across restarts
  const folded = useStore((s) => s.foldedProjects.includes(projectId))
  const toggleFold = useStore((s) => s.toggleProjectFold)
  // Folded groups (#666): the children of a session. `foldedGroups` is one array, so this re-renders only when it changes
  const foldedGroups = useStore((s) => s.prefs.foldedGroups)
  const setGroupsFolded = useStore((s) => s.setGroupsFolded)
  /*
   * On a linked machine that is away (#82): its rows stay, from what the hub last heard, dimmed so they read as not
   * current. Nothing about them changes on its own until the machine is back.
   */
  const away = useStore((s) => isAway(s.projects[projectId], s.machines))
  // When expanded, each row's own mark already states its state — do not repeat it on the name line
  const summary = folded ? foldSummary(sessions) : []

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
      {/*
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
      */}
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
            A split button (#543): the `+` starts a session at once, with what the project remembers (its last
            tool and that tool's model and effort); the chevron beside it opens the window that asks. In the
            common case the window's only step was Start, a decision and a click (2.7 s) every time.
          */}
          <IconButton
            label={`New session in ${project.name}`}
            onClick={() => void startSessionNow(projectId)}
            testId={`project-new-session-${project.name}`}
          >
            <PlusIcon size={14} />
          </IconButton>
          <IconButton
            label={`New session in ${project.name}: choose the tool, a worktree or a past conversation`}
            onClick={() => openNewSession(projectId)}
            testId={`project-new-session-options-${project.name}`}
          >
            <ChevronIcon open size={14} />
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
        <ul className="mt-1.5">
          {treeRows(groupedSessions.project, (id) => foldedGroups.includes(childrenGroupKey(id))).map(({ s, nested, children, folded: childrenFolded }) => {
            const unread = s.lastSeq > s.lastReadSeq
            const focused = focusedSessionId === s.id
            const groupKey = childrenGroupKey(s.id)
            return (
              <SessionRow
                key={s.id}
                id={s.id}
                projectId={projectId}
                nested={nested}
                level={nested ? 2 : 1}
                below={approvalLine(s, renaming, () => focusSession(s.id))}
                /*
                 * A child row cannot be dragged — position is membership (#69). Letting a row
                 * drawn indented under a parent be moved by hand would make the new position read
                 * as membership, while the actual membership (parentSessionId) stays unchanged,
                 * and the screen would end up lying.
                 */
                draggable={renaming !== s.id && !nested}
                onReorder={(draggedId, before) => {
                  // App-owned rows can still be dropped on the grid, but their appId — not list position — is their membership.
                  if (
                    [...groupedSessions.byApp.values()].some((owned) =>
                      owned.some((session) => session.id === draggedId),
                    )
                  )
                    return
                  void reorderSessions(
                    projectId,
                    moveTo(
                      sessions.map((x) => x.id),
                      draggedId,
                      s.id,
                      before,
                    ),
                  )
                }}
              >
                {renaming === s.id ? (
                  <SessionNameInput
                    id={s.id}
                    initial={s.name}
                    onDone={(name) => {
                      setRenaming(null)
                      // No reason for a round trip when the name is unchanged (and no reason for a failure toast either)
                      if (name && name !== s.name) void renameSession(s.id, name)
                    }}
                  />
                ) : (
                  <>
                    {children.length > 0 && (
                      <GroupToggle
                        folded={childrenFolded}
                        label={`${childrenFolded ? 'Show' : 'Hide'} the ${children.length === 1 ? 'session' : `${children.length} sessions`} ${s.name} started`}
                        testId={`children-fold-${s.id}`}
                        onToggle={() => setGroupsFolded([groupKey], !childrenFolded)}
                      />
                    )}
                    <button
                      onClick={() => focusSession(s.id)}
                      onKeyDown={foldKeys(children.length > 0, childrenFolded, (next) => setGroupsFolded([groupKey], next))}
                      /*
                        Double-clicking the name edits it in place — the same convention as file
                        explorers and tab names, so the hand knows it before the person even finds
                        the button. The pencil button is a second entry point for a person who does
                        not know that convention: keeping only one of the two would leave half the
                        people unable to rename anything.
                      */
                      onDoubleClick={() => setRenaming(s.id)}
                      data-testid={`session-row-${s.id}`}
                      // The open row inside the tinted group — the same word an app row and the project's name row use
                      aria-current={focused ? 'page' : undefined}
                      /*
                        Unread (FR-16) is stated by the name's brightness (the text-ink on the
                        truncate span below). It is also kept as an attribute so a test can see a
                        fact not otherwise present on screen — asserting a class name would break
                        the test every time the color gets adjusted.
                      */
                      data-unread={(unread && !focused) || undefined}
                      /*
                        The right padding has to clear the menu button that appears on hover
                        (ROW_MENU_PAD): a long name that ran in underneath it would be text hidden
                        under a button, which is worse than text truncated.
                      */
                      className={`flex w-full items-center gap-2 border-l-2 py-1.5 ${ROW_PAD} ${ROW_MENU_PAD} text-left text-md transition-colors ${
                        focused
                          ? 'border-l-ink-muted bg-surface-hover/40 text-ink'
                          : 'border-l-transparent text-ink-muted hover:bg-surface-hover/20 hover:text-ink'
                      }`}
                    >
                      {/*
                        One mark states two things: the letter is the tool, the border is the
                        state. A separate dot right next to the mark would read as overlapping the
                        two, and blur both instead.
                      */}
                      <ToolMark tool={s.tool} state={s.state} asleep={!s.live && !s.unreachable} interruption={s.interruption ?? null} openQuestions={s.pendingQuestions.length} />
                      <span className={`truncate ${unread && !focused ? 'text-ink' : ''}`}>{s.name}</span>
                      {childrenFolded && (
                        <FoldedMark count={children.length} attention={groupAttention(children)} testId={`children-folded-${s.id}`} />
                      )}
                      {/*
                        Merged (#69) — this branch's work has landed on the trunk. A sign that it
                        is history, not ongoing work. Cleaning it up is the person's, in the delete
                        dialog, or the session that started it (agent_session delete, #561).
                      */}
                      {s.merged && (
                        <span
                          className="shrink-0 rounded-md border border-line px-1 text-2xs leading-body text-ink-faint"
                          data-testid={`merged-badge-${s.id}`}
                          title="Branch merged into the trunk — safe to clean up from the delete dialog"
                        >
                          merged
                        </span>
                      )}
                      {/*
                        The PR chip (#76 stage 3) — this branch's pull request, measured through
                        gh. Not drawn once merged is showing: a merged PR also lights up the merged
                        badge, and stating the same outcome twice on a 13px row blurs both.
                      */}
                      {s.pr && !s.merged && (
                        <span
                          className="shrink-0 rounded-md border border-line px-1 text-2xs leading-body text-ink-faint"
                          data-testid={`pr-badge-${s.id}`}
                          title={`Pull request #${s.pr.number} — ${s.pr.state}\n${s.pr.url}`}
                        >
                          PR #{s.pr.number}
                          {s.pr.state === 'closed' ? ' ✕' : ''}
                        </span>
                      )}
                      {/*
                        Background work still running (#290) — the header's count, on the row. A session whose turn
                        ended can still have agents or shells running behind it; restarting or interrupting it would
                        end them.
                      */}
                      <BackgroundMark tasks={s.backgroundTasks} testId={`background-mark-${s.id}`} />
                      {/*
                        An unread dot used to be here and **was removed** (dogfooding, 2026-09-02).

                        It was stating the same fact for a third time on this row: the tool mark's
                        border already states the state (an ink-muted ring when a turn ends), and the
                        name's brightness already states unread (the text-ink above). Since all
                        three lit up together when a turn ended while the person was away, the dot
                        added no information, only the question "what is that now" — and that
                        question was actually asked. The determination logic (lastReadSeq, markRead)
                        is unchanged.
                      */}
                    </button>
                    {/*
                      One menu instead of four icons (pencil, handoff, worktree, delete) — a
                      dogfooding request, the same grammar as the project row. With four icons it
                      turned into an unlabeled game of matching pictures, and two of them (handoff,
                      delete) were the kind that must not be pressed by mistake.
                    */}
                    {/*
                      The right padding has to match the project header's px-3 — the two are
                      buttons standing in the same vertical column in the sidebar, and leaving them
                      at 4px and 12px stood out immediately to the eye (a dogfooding finding).
                      Fixing only one side would put them out of alignment again, so the value is
                      kept matched.
                    */}
                    <span
                      className={`absolute right-3 top-1/2 flex -translate-y-1/2 items-center transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 ${
                        sessionMenu?.id === s.id ? 'opacity-100' : 'opacity-0'
                      }`}
                      data-testid={`session-actions-${s.id}`}
                    >
                      {/* A plain button like the project's ⋯ — a named menu opens right away, so a tooltip is noise */}
                      <button
                        type="button"
                        aria-label={`Actions for ${s.name}`}
                        onClick={(e) => {
                          // Reading it inside the updater is too late — React clears currentTarget once the handler returns
                          const el = e.currentTarget
                          setSessionMenu((cur) => (cur?.id === s.id ? null : { id: s.id, el }))
                        }}
                        data-testid={`session-menu-${s.id}`}
                        className="flex items-center justify-center rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-hover/60 hover:text-ink"
                      >
                        <DotsIcon size={14} />
                      </button>
                    </span>
                    {sessionMenu?.id === s.id && (
                      <SessionMenu
                        session={s}
                        anchorEl={sessionMenu.el}
                        onClose={() => setSessionMenu(null)}
                        onRename={() => setRenaming(s.id)}
                        onHandoff={() => setHandingOff(s.id)}
                        onDelete={() => setConfirming(s.id)}
                      />
                    )}
                  </>
                )}
              </SessionRow>
            )
          })}
        </ul>
      )}
      {!folded && <AppRows apps={projectApps} sessionsByApp={groupedSessions.byApp} testId={`project-apps-${project.name}`} />}

      {newSessionOpen && <NewSessionDialog projectId={projectId} onClose={() => openNewSession(null)} />}
      {newAppOpen && <NewAppDialog projectId={projectId} onClose={() => setNewAppOpen(false)} />}
      {deleting && <DeleteProjectDialog project={project} onClose={() => setDeleting(false)} />}

      {confirming && (
        <ConfirmDelete
          sessionId={confirming}
          name={sessions.find((s) => s.id === confirming)?.name ?? 'Session'}
          // This session's own tool, not the project default — this sentence states where the transcript ends up, so it must not be wrong
          tool={sessions.find((s) => s.id === confirming)?.tool ?? project.defaultTool ?? ''}
          onCancel={() => setConfirming(null)}
          onConfirm={(deleteWorktree, deleteExternal) => {
            void deleteSession(confirming, deleteWorktree, deleteExternal)
            setConfirming(null)
          }}
        />
      )}

      {handingOff && (
        <ConfirmHandoff
          name={sessions.find((s) => s.id === handingOff)?.name ?? 'Session'}
          tool={sessions.find((s) => s.id === handingOff)?.tool ?? project.defaultTool ?? ''}
          // Determining a dead session (#78): asking a session that has errored or hit a rate limit
          // to write a handoff note is asking someone who cannot respond for a will — the transcript mode is pre-selected
          dead={(() => {
            const s = sessions.find((x) => x.id === handingOff)
            return s ? s.state === 'error' || !!s.limit : false
          })()}
          // Asking the agent is blocked while a card is up — the request would go through as the answer to a question (#174, same determination as the store)
          blocked={(() => {
            const s = sessions.find((x) => x.id === handingOff)
            return s ? handoffBlockedBy(s) : null
          })()}
          onCancel={() => setHandingOff(null)}
          onConfirm={(tool, deleteOld, mode) => {
            // The dialog closes and progress is shown inside the session — the handoff request and its text stay in the conversation as is
            void handoffSession(handingOff, { tool, deleteOld, mode })
            setHandingOff(null)
          }}
        />
      )}
    </section>
  )
}
