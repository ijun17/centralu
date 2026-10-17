import type {
  CommandRunInfo,
  SavedCommand,
  ProjectInfo,
  GitSource,
} from '@cc/protocol'

/** Projects: the list, git state, trust, saved commands and their runs. */
export type ProjectsSlice = {
  projects: Record<string, ProjectInfo>
  /**
   * How many times, per project, we have heard "the working tree may have moved" (#160). Bumped
   * by one each time `refreshProjectGit` actually goes and asks. The evidence panel's change list,
   * history and collapsed strip hold their own lists, so they never heard a re-read that only
   * updated `project.git` (the sidebar's summary) — they now subscribe to this counter and re-read
   * together on turn end, window focus, approval, and branch switch.
   */
  gitEpoch: Record<string, number>
  /** Git, files and the viewer belong to the project — they must be viewable without a session */
  focusedProjectId: string | null
  /**
   * Per-project command run state — a projection of the host's `commands.state` (#60, moved into
   * the terminal panel). The host's buffer holds the log body; this only holds the facts a badge
   * needs to read (is it running, what did it end with). Why this lives in the store: "it is
   * running" is not only the run window's own concern, it is a fact the tab badge and the collapsed
   * strip must read too — the gap this piece exists to close is that leaving a dev server on and
   * moving away left no trace of it visible anywhere. Keyed projectId → command → last run.
   */
  commandRuns: Record<string, Record<string, CommandRunInfo>>
  focusProject(id: string): void
  /**
   * Sets the project's worktree trunk (#76). It was chosen when making the worktree manager, which was folded into
   * ordinary sessions (#561 part 3); a failure is thrown back to the dialog, which keeps it in place (#180).
   */
  setWorktreeTrunk(projectId: string, baseBranch: string): Promise<void>
  /** `machine`: a folder on that linked machine, its path in that machine's terms (#82) */
  addProject(path: string, machine?: string | null): Promise<ProjectInfo>
  /**
   * Makes a new project (#515): an empty folder `name` in `parent` (that machine's Desktop when absent), made by the
   * host of `machine` (this computer's when absent), then registered as `addProject` registers one. With `source`, a
   * clone of that repository instead of an empty folder.
   */
  createProject(name: string, parent?: string, machine?: string | null, source?: GitSource): Promise<ProjectInfo>
  /** Re-reads the project list for projects the host made on its own (#515, `projects_changed`) */
  refreshProjects(): Promise<void>
  /**
   * A project just registered whose trust is still being asked about (M4, decision 3). Asked
   * **once**, at registration — answering or dismissing it clears it. Nothing is blocked while it
   * is being asked (it stands under that project in the sidebar): right after registering there is
   * also a path where the new-session window pops up immediately, and stacking a window on a window
   * would leave both half-read. A project left unanswered stays untrusted, and can be changed at any
   * time from the project menu.
   */
  trustAsk: string | null
  answerTrustAsk(trust: boolean): Promise<void>
  /**
   * Turns trust on and off. The app list follows from the host's broadcast
   * (`external_apps_changed`).
   *
   * A session already running receives trust only when a session comes up (#92, the manager's
   * `projectTrusted`) — a changed trust setting takes effect only from the next time that session
   * restarts or resumes. That fact is stated in a single line **only when there is a running
   * session**. Saying it when there is none would be a warning about nothing, and not saying it when
   * there is one would let the person believe that turning off trust changed those sessions too, at
   * that instant.
   */
  setProjectTrusted(projectId: string, trusted: boolean): Promise<void>
  /**
   * Delete a project — the record here, and optionally the folder on disk.
   *
   * Two calls, in this order and not the other: the trash first, the record second. The
   * path is only known from the record, so removing it first would leave nothing to point
   * the trash at; and if the trash refuses (a browser has none), nothing has been deleted
   * yet and the whole thing stops with the reason. The reverse order can lose the folder
   * *and* the history in the failure case, which is the one case that matters.
   */
  deleteProject(projectId: string, deleteFiles: boolean): Promise<void>
  /**
   * Ask for this project's git status again, debounced (issue #41).
   *
   * `project.git` was measured once, at attach, and never again — so the sidebar's changed
   * count was a snapshot from app start that an agent's edits and commits never moved.
   * Everything that shows git for a project reads that one field, so this writes back
   * there rather than growing a second, parallel copy for the sidebar.
   *
   * Returns nothing and is safe to call from anywhere: the call is a *hint* that the tree
   * may have moved, not a request the caller waits on.
   */
  refreshProjectGit(projectId: string): void
  /**
   * Changing a repository on purpose, from inside the app (issue #49).
   *
   * #41 gave the sidebar three ways to hear that a tree moved — a turn ending, an approval
   * granted, the window regaining focus — and every one of them is a *guess* that something
   * probably happened elsewhere. The git panel then went straight to `platform.git` and told
   * only itself, so **committing, the one change we make deliberately and know about, was the
   * only one the sidebar never heard**. The count sat on its old value until an unrelated
   * signal happened to fire.
   *
   * So the writes come through here and the refresh is part of the operation rather than
   * something each call site has to remember. Reads stay on `platform.git`: a panel asking
   * for its own file list or a diff is nobody else's business, and routing those through the
   * store would put a debounce in front of a list that has to repaint on the click.
   *
   * `push` is deliberately absent. It moves nothing the sidebar shows — `ProjectInfo['git']`
   * is branch, changed count and is-repo, with no ahead/behind — so a refresh after it would
   * be a status call whose answer can only be identical.
   */
  gitStage(projectId: string, paths: string[], unstage?: boolean): Promise<void>
  gitCommit(projectId: string, message: string): Promise<{ ok: boolean; message?: string; cancelled?: true }>
  /** Switching branch is the one of these that moves the **name** the sidebar shows, not the count */
  gitCheckout(
    projectId: string,
    branch: string,
  ): Promise<{ ok: boolean; conflicts: string[]; message?: string }>
  /**
   * Replace this project's saved shell commands (issue #44).
   * Adding one and deleting one both arrive here as "the list is this now".
   */
  setProjectCommands(projectId: string, commands: SavedCommand[]): Promise<void>
  /** Saves the worktree provisioning setup (#69) — called from the new-session window's worktree section */
  saveWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): Promise<void>
  /** Reads the host's run ledger — when the evidence panel views a project, so a running command stays visible even after just reloading the UI */
  loadCommandRuns(projectId: string): Promise<void>
  /** Runs a saved command (#44 → #60). If the same command is already running, the host kills it and starts fresh */
  runCommand(projectId: string, command: string): Promise<void>
  /** Stops a dev server — the outcome comes back through `terminal.onExit` and is recorded in `commandRuns`. The log survives */
  stopCommand(projectId: string, command: string): Promise<void>
  /** Sidebar order (set by the person dragging) */
  reorderProjects(orderedIds: string[]): Promise<void>
}
