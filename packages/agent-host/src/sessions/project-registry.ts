import { basename } from 'node:path'
import type { ProjectInfo, SavedCommand } from '@cc/protocol'
import { gitSummary } from '../dev-services/git.js'
import { gitValidBranchName } from '../dev-services/git-worktree.js'
import type { Store } from '../dev-services/store.js'
import { rpcError } from '../rpc-error.js'
import type { DelegationHost } from './delegation-flow.js'
import { orchestratorHome } from './orchestrator-home.js'

/**
 * What the project registry reaches of the session manager (#1143), typed as the manager declares each member. The
 * manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type ProjectRegistryHost = Pick<DelegationHost, 'store' | 'emit' | 'firstTool'> & {
  /** Root under which worktrees are created, one of "our own folders" (`folderRoots`) */
  readonly worktreeRoot: string
  /** Merge detection (#69, merge-checks.ts), started without waiting for it */
  checkMergedInBackground: (projectId: string) => void
}

/**
 * The registered projects as the manager and its modules read them: a project's row, folder and trust, its
 * `ProjectInfo`, and the settings the person keeps on it (saved commands, worktree setup and trunk, sidebar order).
 * Moved out of the session manager as it was (#1143); what it reaches of the manager is `ProjectRegistryHost`.
 */
export class ProjectRegistry {
  constructor(private readonly host: ProjectRegistryHost) {}

  /** A registered project's row, read now (trust and paths change under a running host) */
  projectRow(projectId: string | null | undefined): ReturnType<Store['projects']['listProjects']>[number] | undefined {
    return projectId ? this.host.store.projects.listProjects().find((p) => p.id === projectId) : undefined
  }

  /** A registered project's row, or `Project not found` */
  requireProject(projectId: string): ReturnType<Store['projects']['listProjects']>[number] {
    const p = this.projectRow(projectId)
    if (!p) throw rpcError(`Project not found: ${projectId}`)
    return p
  }

  /**
   * Is this project trusted (decision 3, #92) — passed to the adapter when launching a session. False
   * if the project does not exist.
   *
   * Read fresh from the store on every call, the same as the app runtime — holding a cached copy
   * would keep answering "yes" even after trust was turned off.
   */
  projectTrusted(projectId: string | null): boolean {
    if (!projectId) return false
    return this.host.store.projects.projectRoots().some((p) => p.id === projectId && p.trusted)
  }

  /**
   * A project's working directory. **The orchestrator (projectId=null) uses a neutral location.**
   *
   * Placing it inside a project would have it touching the same files as that project's sessions —
   * creating with our own hands exactly the concurrent-session conflict FR-2 warns about. The
   * orchestrator has no hands of its own: sessions do the work, and the orchestrator instructs and reads.
   */
  cwdOf(projectId: string | null): string {
    if (projectId === null) return orchestratorHome()
    const p = this.requireProject(projectId)
    return p.path
  }

  /**
   * The project's trust as a git read needs it (#407): before trust, a read runs none of the
   * repository's hooks, filters, textconv or fsmonitor (`git-exec.ts`). Read fresh on every call,
   * like `projectTrusted`.
   */
  gitTrust(projectId: string | null): { trusted: boolean } {
    return { trusted: this.projectTrusted(projectId) }
  }

  async projectInfo(id: string, path: string): Promise<ProjectInfo> {
    /*
     * **Reads the stored value.** 'claude' used to be hardcoded here, which meant the DB's
     * default_tool column was never read anywhere — and since nothing wrote to it either, nobody
     * noticed (2026-08-27, caught by a test while adding the remember-tool feature).
     */
    const row = this.projectRow(id)
    const git = await gitSummary(path, { trusted: row?.trusted ?? false })
    const stored = row?.defaultTool
    return {
      id, path, name: basename(path), defaultTool: this.host.firstTool(stored),
      // Trust (M4, decision 3) — reads the same column as the app runtime. The trust toggle on screen shows
      // this value
      trusted: row?.trusted ?? false,
      // Default model/effort per tool (#107) — read separately since it is JSON, like commands and
      // worktreeSetup
      defaultModels: this.host.store.projects.projectToolDefaults(id),
      // Saved shell commands ride along with the project so the Run menu never has a
      // "loading" state to distinguish from an empty one (issue #44)
      commands: this.host.store.projects.projectCommands(id),
      // Worktree provisioning (#69) rides along too — a new session window prefills it without a separate
      // fetch
      worktreeSetup: this.host.store.projects.worktreeSetup(id),
      // Manager slot and trunk (#76). Treated as absent if the pointed-to session does not exist or
      // is archived — so the screen never navigates to a ghost slot, this side (which knows about
      // sessions) does the check
      /*
       * The trunk, in the shape the window has read since #76. The session is the former manager's, or empty: the
       * manager was folded into ordinary sessions (#561 part 3), and the window reads only `baseBranch`
       */
      worktreeManager: (() => {
        const trunk = this.host.store.projects.worktreeTrunk(id)
        return trunk ? { sessionId: this.host.store.projects.worktreeManager(id)?.sessionId ?? '', baseBranch: trunk } : null
      })(),
      git: git.isRepo ? git : null,
    }
  }

  /**
   * Replace this project's saved shell commands (issue #44).
   *
   * Blank entries are dropped here rather than trusted to the caller: a row that runs
   * nothing when clicked is worse than no row, and this is the one place every edit —
   * from any client — has to pass through.
   *
   * Nothing else is inspected. These are the user's own commands and go to their own
   * shell; the approval machinery exists for what an agent proposes, and running these
   * through it would put a permission prompt in front of what the person just typed.
   */
  setProjectCommands(projectId: string, commands: readonly SavedCommand[]): SavedCommand[] {
    this.requireProject(projectId)
    // Drop empty commands, and turn an empty alias into no alias — the label is display-only, so all it needs
    // is normalizing
    const clean = commands.flatMap((c): SavedCommand[] => {
      const command = c.command.trim()
      if (!command) return []
      const label = c.label?.trim()
      return [{ command, ...(label ? { label } : {}) }]
    })
    const was = JSON.stringify(this.host.store.projects.projectCommands(projectId))
    this.host.store.projects.setProjectCommands(projectId, clean)
    // The Run menu of every other window reads the project's commands (#719)
    if (was !== JSON.stringify(clean)) this.host.emit({ type: 'projects_changed' })
    return clean
  }

  /** Worktree provisioning settings (#69) — saved by the new session window's worktree section */
  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): void {
    this.requireProject(projectId)
    const clean = setup
      ? { command: setup.command.trim(), copyFiles: setup.copyFiles.map((f) => f.trim()).filter(Boolean) }
      : null
    const saved = clean && (clean.command || clean.copyFiles.length) ? clean : null
    const was = JSON.stringify(this.host.store.projects.worktreeSetup(projectId))
    this.host.store.projects.setWorktreeSetup(projectId, saved)
    if (was !== JSON.stringify(this.host.store.projects.worktreeSetup(projectId))) this.host.emit({ type: 'projects_changed' })
  }

  /**
   * Sidebar order (the person sets it by dragging).
   *
   * Anything missing from the received list is **left at the end, as-is** — something that was off
   * screen should never jump to the front just because an order was saved once.
   */
  async reorderProjects(orderedIds: readonly string[]): Promise<ProjectInfo[]> {
    const known = this.host.store.projects.listProjects().map((p) => p.id)
    const rest = known.filter((id) => !orderedIds.includes(id))
    this.host.store.projects.setProjectOrder([...orderedIds.filter((id) => known.includes(id)), ...rest])
    return this.listProjects()
  }

  async listProjects(): Promise<ProjectInfo[]> {
    return Promise.all(this.host.store.projects.listProjects().map((p) => this.projectInfo(p.id, p.path)))
  }

  /**
   * One project, re-measured (issue #41).
   *
   * The caller is a refresh loop — the sidebar count is re-read every time a turn ends —
   * so this has to cost **one** `git status`. Answering it by calling `listProjects` and
   * discarding all but one row would run a status per registered project on every turn,
   * which is exactly the quiet cost that keeps this out of the hot path.
   */
  async projectGitStatus(projectId: string): Promise<ProjectInfo> {
    const p = this.requireProject(projectId)
    /*
     * Merge detection (#69) piggybacks here — the UI's call is debounced to fire whenever a turn
     * ends, which happens to be the same rhythm as "something just moved". A merge done in a
     * terminal is caught on the next refresh too. It does not block the response: the badge flows
     * separately as an event.
     */
    this.host.checkMergedInBackground(projectId)
    return this.projectInfo(p.id, p.path)
  }

  /**
   * "Our own folders" — the search scope used when hunting for stray processes (strays.ts).
   *
   * Project directories plus the worktree root. Why the worktree root is included separately:
   * everything under it is **a folder the app itself created**, so anything running there is by
   * definition our own business, and it can still exist even after the project is removed from the list.
   */
  folderRoots(): string[] {
    return [...this.host.store.projects.listProjects().map((p) => p.path), this.host.worktreeRoot]
  }

  /** This project's trunk branch (#76): the one chosen for the former worktree manager's slot, still read from its row (#561
   * part 3). null if none was set — HEAD is then used as the baseline */
  trunkOf(projectId: string): string | null {
    return this.host.store.projects.worktreeTrunk(projectId)
  }

  /** Sets the project's worktree trunk (`worktrees.setTrunk`, #76; the manager's dialog chose it before #561 part 3) */
  async setWorktreeTrunk(projectId: string, baseBranch: string): Promise<void> {
    this.requireProject(projectId)
    const branch = baseBranch.trim()
    if (!branch) throw rpcError('Pick the branch worktrees should fork from')
    if (!(await gitValidBranchName(branch))) throw rpcError(`Not a branch name: ${branch}`)
    this.host.store.projects.setWorktreeTrunk(projectId, branch)
    this.host.emit({ type: 'projects_changed' })
  }
}
