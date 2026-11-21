import type {
  CommandRunInfo,
  SavedCommand,
  ProjectInfo,
  GitSource,
} from '@cc/protocol/client'

/**
 * A command's last run (#60): the host's record plus two facts only this window saw. A reload loses them, leaving a
 * run without its end time and a stop read as its exit code, never a wrong one.
 */
export type CommandRun = CommandRunInfo & {
  /** When its exit arrived here, so the list can say when it ended */
  endedAt?: number
  /** Stopped from Centralu: its exit is a stop, not a failure */
  stopped?: boolean
}

/** Projects: the list, git state, trust, saved commands and their runs. */
export type ProjectsSlice = {
  projects: Record<string, ProjectInfo>
  /**
   * Raised each time `refreshProjectGit` asks (#160). The evidence panel's lists hold their own copies, which a
   * `project.git` update does not reach; they subscribe to this and read again.
   */
  gitEpoch: Record<string, number>
  /** Git, files and the viewer belong to the project, viewable without a session */
  focusedProjectId: string | null
  /**
   * projectId → command → last run, a projection of the host's `commands.state` (#60) without the log. In the store
   * because the tab badge and the collapsed strip show a running command too.
   */
  commandRuns: Record<string, Record<string, CommandRun>>
  focusProject(id: string): void
  /** Sets the worktree trunk (#76); a failure is thrown back to the dialog, which stays open (#180). */
  setWorktreeTrunk(projectId: string, baseBranch: string): Promise<void>
  /** `machine`: a folder on that linked machine, its path in that machine's terms (#82) */
  addProject(path: string, machine?: string | null): Promise<ProjectInfo>
  /**
   * Makes a new project (#515): folder `name` in `parent` (default: that machine's Desktop) on `machine` (default: this
   * computer), then registers it. With `source`, a clone of that repository instead of an empty folder.
   */
  createProject(name: string, parent?: string, machine?: string | null, source?: GitSource): Promise<ProjectInfo>
  /** On `projects_changed`: projects the host made on its own (#515) */
  refreshProjects(): Promise<void>
  /**
   * A just-registered project whose trust is asked once (M4, decision 3), as a card under it in the sidebar, not a
   * window: the new-session window may open at the same time. Unanswered stays untrusted.
   */
  trustAsk: string | null
  answerTrustAsk(trust: boolean): Promise<void>
  /** The project menu's "Trust this project…" when it has apps to list (#1141) */
  askTrust(projectId: string): void
  /**
   * The app list follows the host's `external_apps_changed`. A running session takes trust only when it comes up
   * (#92), so the change is said in a line only when a session is running.
   */
  setProjectTrusted(projectId: string, trusted: boolean): Promise<void>
  /**
   * The folder goes to the OS bin first (`fs.trashProjectFolder`), the record second: the path is known only from the
   * record, and a bin that refuses (a browser has none) stops it before anything is deleted.
   */
  deleteProject(projectId: string, deleteFiles: boolean): Promise<void>
  /** Debounced (#41): a hint that the tree may have moved, writing `project.git`, which every git view reads. */
  refreshProjectGit(projectId: string): void
  /**
   * Git writes go through the store (#49) so each one refreshes the sidebar's count; reads stay on `platform.git`, with
   * no debounce in front. No `push`: it changes nothing `ProjectInfo['git']` shows.
   */
  gitStage(projectId: string, paths: string[], unstage?: boolean): Promise<void>
  gitCommit(projectId: string, message: string): Promise<{ ok: boolean; message?: string; cancelled?: true }>
  /** Moves the branch name the sidebar shows, not only the count */
  gitCheckout(
    projectId: string,
    branch: string,
  ): Promise<{ ok: boolean; conflicts: string[]; message?: string }>
  /** Replaces the saved commands (#44): adding and deleting both send the whole list. */
  setProjectCommands(projectId: string, commands: SavedCommand[]): Promise<void>
  /** The instructions for agents started in the project (#1161) */
  saveAgentInstructions(projectId: string, text: string): Promise<void>
  /** The worktree provisioning setup (#69) */
  saveWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): Promise<void>
  /** Reads the host's run ledger, so a running command stays visible after a reload */
  loadCommandRuns(projectId: string): Promise<void>
  /** If the command is already running, the host kills it and starts it fresh (#60) */
  runCommand(projectId: string, command: string): Promise<void>
  /** The outcome comes back through `terminal.onExit` into `commandRuns`; the log survives */
  stopCommand(projectId: string, command: string): Promise<void>
  /** The host watches the file tree's open folders (#34); a failed registration is said once until one succeeds (#841) */
  watchProjectDirs(projectId: string, dirs: string[]): Promise<void>
  reorderProjects(orderedIds: string[]): Promise<void>
}
