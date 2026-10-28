import type { ProjectInfo, SavedCommand, GitSource } from '@cc/protocol/client'
import { osPathBaseName, folderNameError, PROJECTS_DIR, gitSourceError, repoNameOf } from '@cc/protocol/client'
import type { ProjectPort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { SessionStore } from './session-store.js'
import type { ProjectStore } from './project-store.js'
import type { AppRegistry } from './app-registry.js'
import type { ToolsMock } from './tools.js'
import type { GridMock } from './grid.js'
import type { MachinesMock } from './machines.js'
import type { TrashMock } from './trash.js'
import type { Emit } from './event-bus.js'
import { mockError } from './mock-error.js'

/** The host's wording and code for a project id it does not know (`SessionManager.requireProject`) */
function projectNotFound(projectId: string): Error {
  return mockError(`Project not found: ${projectId}`)
}

/** `items` in the order `orderedIds` names them; ids not named keep their order after them, unknown ids are ignored */
export function putInOrder<T extends { id: string }>(items: readonly T[], orderedIds: readonly string[]): T[] {
  const byId = new Map(items.map((x) => [x.id, x]))
  const named = [...new Set(orderedIds)].flatMap((id) => {
    const item = byId.get(id)
    return item ? [item] : []
  })
  const rest = items.filter((x) => !orderedIds.includes(x.id))
  return [...named, ...rest]
}

/** The project port: adding, creating (#515), trust, commands and worktree settings */
export class ProjectsMock {
  /** For tests: what deleting a project may do to its folder, by project id (#1301); absent: by the project's mark */
  readonly deleteOutlooks = new Map<string, 'stays' | 'may_move' | 'around_may_move' | 'unsure'>()
  /** For tests: the project ids the Delete project dialog asked about, in order */
  readonly deleteOutlooksAsked: string[] = []
  /** For tests: answer as a host before the call does */
  deleteOutlookUnknown = false
  /** For tests: the answer waits for this to settle, as one from a slow or far host does */
  deleteOutlookHold: Promise<void> | null = null
  /** For tests: paths a new project may not take, as if a folder of that name were already there (#515) */
  takenPaths = new Set<string>()
  /** Every `projects.create` call, as asked (#515) */
  readonly createProjectCalls: { name: string; parent?: string; machine?: string | null; source?: GitSource }[] = []
  /** For tests: the sentence the next clone fails with, as a host's would (#515); null clones */
  nextCloneError: string | null = null

  /**
   * Where a new project would go on a machine (#515), as its host would say: `~/Centralu` on this computer, or on a
   * linked machine in its own path terms. Refuses what the host refuses — the name rule is the host's own (protocol).
   */
  private newProjectTarget(name: string, parent?: string, machine?: string | null, source?: GitSource): { parent: string; path: string | null; error: string | null } {
    const windows = !!machine && this.machinesMock.machinesList.find((m) => m.id === machine)?.shell === 'powershell'
    const sep = windows ? '\\' : '/'
    const home = !machine ? `/Users/you/${PROJECTS_DIR}` : windows ? `C:\\Users\\you\\${PROJECTS_DIR}` : `/home/you/${PROJECTS_DIR}`
    const where = parent?.trim() || home
    const folder = name.trim() || (source ? repoNameOf(source.git) : '')
    if (!name.trim() && !source?.git.trim()) return { parent: where, path: null, error: null }
    const urlError = source ? gitSourceError(source.git) : null
    if (urlError) return { parent: where, path: null, error: urlError }
    const nameError = folderNameError(folder, windows)
    if (nameError) return { parent: where, path: null, error: nameError }
    const path = `${where.replace(/[\\/]+$/, '')}${sep}${folder}`
    const taken = this.takenPaths.has(path) || this.projectStore.list.some((p) => p.path === path && (p.machine ?? null) === (machine ?? null))
    if (taken) return { parent: where, path: null, error: `Something named "${folder}" is already in ${where} — choose another name.` }
    return { parent: where, path, error: null }
  }
  /** For tests: how many times projects.gitStatus was asked — an eye on whether debouncing is working (issue #41) */
  gitStatusCalls = 0
  /** The record of trust turned on and off — tests check "it only asks, it does not send" (M4) */
  readonly trustCalls: { projectId: string; trusted: boolean }[] = []
  readonly projects: ProjectPort = {
    /** The same rule as the real thing (manager.reorderProjects, #999): a project missing from the list stays at the end, as it was */
    reorder: async (orderedIds: string[]) => {
      this.projectStore.list = putInOrder(this.projectStore.list, orderedIds)
      return [...this.projectStore.list]
    },
    create: async (name: string, parent?: string, machine?: string | null, source?: GitSource) => {
      this.createProjectCalls.push({ name, ...(parent ? { parent } : {}), ...(machine ? { machine } : {}), ...(source ? { source } : {}) })
      const t = this.newProjectTarget(name, parent, machine, source)
      if (!t.path) throw mockError(t.error ?? 'Give the new folder a name.')
      // A failed clone leaves nothing, as the host's does
      const cloneError = source ? this.nextCloneError : null
      this.nextCloneError = null
      if (cloneError) throw mockError(cloneError)
      this.takenPaths.add(t.path)
      /*
       * The same rule as the real thing (project-creation.ts createProject, #655, #999): a folder made empty holds only
       * what Centralu and the person write, so it starts trusted, and with no repository its git is null (projectInfo)
       * until an agent makes one. A clone is a repository on its branch, and untrusted: a stranger's code is in it.
       */
      const info = await this.projects.add(t.path, machine)
      const made: ProjectInfo = source
        ? { ...info, git: { branch: source.branch ?? 'main', changedFiles: 0, isRepo: true } }
        : { ...info, trusted: true, git: null }
      this.projectStore.list = this.projectStore.list.map((p) => (p.id === info.id ? made : p))
      // Every window learns of it, the one that asked included
      this.emit({ type: 'projects_changed' })
      return made
    },
    createPreview: async (name: string, parent?: string, machine?: string | null, source?: GitSource) => this.newProjectTarget(name, parent, machine, source),
    add: async (path: string, machine?: string | null) => {
      const existing = this.projectStore.list.find((p) => p.path === path && (p.machine ?? null) === (machine ?? null))
      if (existing) return existing
      /*
       * The name is the directory's last segment under **either** separator (#47).
       *
       * This one is not a wire path — a project's directory is native, and it is the one string
       * that arrives here still spelled the way its own machine spells it. The host names the
       * project with `basename` from `node:path`, which reads `\` on Windows; reading only `/`
       * here meant the mock would have called a project `C:\Users\me\proj` while the host called
       * it `proj`, and e2e — which only ever runs the mock — would have stayed green about it.
       */
      const info: ProjectInfo = {
        // A folder on a linked machine is named the way the hub names it: `<machine>.<id>`, with the machine said (#82)
        id: machine ? `${machine}.mock-project-${this.clock.next()}` : `mock-project-${this.clock.next()}`,
        ...(machine ? { machine } : {}),
        path,
        name: osPathBaseName(path) || path,
        defaultTool: this.toolsMock.firstRegisteredTool(),
        // Default model and strength per tool (#107) — empty for a new project that has never had anything chosen
        defaultModels: {},
        commands: [],
        worktreeSetup: null,
        agentInstructions: '',
        worktreeManager: null,
        // A newly registered project starts untrusted — the same as the real thing (M4, decision 3)
        trusted: false,
        git: { branch: 'main', changedFiles: 0, isRepo: true },
      }
      this.projectStore.list.push(info)
      return info
    },
    /**
     * Trust (M4). Like the real thing, that project's app list follows along: the runtime
     * re-scans when trust changes, standing an untrusted project's apps as `untrusted` and a
     * trusted one's as resting (`stopped`). If the mock skips this, e2e would pass green on a
     * screen where clicking "Trust" still leaves the app blocked.
     */
    setTrusted: async (projectId: string, trusted: boolean) => {
      const at = this.projectStore.list.findIndex((x) => x.id === projectId)
      const current = this.projectStore.list[at]
      if (at === -1 || !current) throw projectNotFound(projectId)
      // Swaps in a new object — the screen holds onto the object `add` returned as-is, so mutating it would let a value that never crossed the wire leak into the screen (the real thing's response is always a new object)
      const was = current.trusted
      this.projectStore.list[at] = { ...current, trusted }
      this.trustCalls.push({ projectId, trusted })
      // Every window re-reads the project, as the host has them (manager.setProjectTrusted, #719)
      if (was !== trusted) this.emit({ type: 'projects_changed' })
      const mine = this.registry.externalAppList.filter((a) => a.projectId === projectId)
      if (mine.length === 0) return
      for (const a of mine) {
        a.trusted = trusted
        if (!trusted && a.status !== 'invalid') Object.assign(a, { status: 'untrusted', error: null })
        else if (trusted && a.status === 'untrusted') a.status = 'stopped'
      }
      this.emit({ type: 'external_apps_changed' })
    },
    list: async () => this.projectStore.list.map((p) => this.projectStore.withGit(p)),
    gitStatus: async (projectId: string) => {
      this.gitStatusCalls++
      const p = this.projectStore.list.find((x) => x.id === projectId)
      if (!p) throw projectNotFound(projectId)
      return this.projectStore.withGit(p)
    },
    /*
     * Removes things in the same order as the real thing: deletes sessions one by one, firing
     * `session_deleted` for each, then drops the project. The screen clears its list from that
     * event, so if the mock silently deleted only the project, e2e would be left with ghost
     * sessions in the sidebar. The sessions go to the session archive (#204), marked to keep
     * the tool's files and worktrees, as the host does.
     */
    remove: async (projectId: string) => {
      const at = this.projectStore.list.findIndex((x) => x.id === projectId)
      if (at === -1) throw projectNotFound(projectId)
      for (const s of [...this.store.sessions.values()].filter((s) => s.projectId === projectId)) {
        this.trashMock.moveToTrash(s.id, false, false)
      }
      this.projectStore.list.splice(at, 1)
      // The project's apps leave the grid with it, as in the host's store
      this.gridMock.gridPanels = this.gridMock.gridPanels.filter((p) => !(p.kind === 'app' && p.projectId === projectId))
      return { ok: true as const }
    },
    /**
     * What deleting a project may do to its folder (#1301): what a test set in `deleteOutlooks`, else what the project's mark says.
     * A test sets `deleteOutlookUnknown` to stand in for a host before the call.
     */
    deleteOutlook: async (projectId: string) => {
      if (this.deleteOutlookUnknown) throw mockError('Unknown method: projects.deleteOutlook')
      await this.deleteOutlookHold
      const p = this.projectStore.list.find((x) => x.id === projectId)
      this.deleteOutlooksAsked.push(projectId)
      // As the host: a project it does not know leaves its folder alone
      return { folder: this.deleteOutlooks.get(projectId) ?? (p?.fromUserFolder ? ('may_move' as const) : ('stays' as const)) }
    },
    /**
     * The registered shell commands (issue #44).
     *
     * **Strips blank lines exactly like the host.** If the mock were more forgiving than the
     * real thing, e2e would stay green while the actual app behaved differently — the contract
     * this file's header lays out.
     */
    setCommands: async (projectId: string, commands: SavedCommand[]) => {
      const p = this.projectStore.list.find((x) => x.id === projectId)
      if (!p) throw projectNotFound(projectId)
      const was = JSON.stringify(p.commands)
      p.commands = commands.flatMap((c): SavedCommand[] => {
        const command = c.command.trim()
        if (!command) return []
        const label = c.label?.trim()
        return [{ command, ...(label ? { label } : {}) }]
      })
      // The Run menu of every other window reads them, as the host tells it (manager.setProjectCommands, #719)
      if (was !== JSON.stringify(p.commands)) this.emit({ type: 'projects_changed' })
      return [...p.commands]
    },
    // The same rule as the real thing (#69): an empty setup lays down as null — a mock that is more forgiving would split the contract apart
    setWorktreeSetup: async (projectId: string, setup: { command: string; copyFiles: string[] } | null) => {
      const p = this.projectStore.list.find((x) => x.id === projectId)
      if (!p) throw projectNotFound(projectId)
      const clean = setup
        ? { command: setup.command.trim(), copyFiles: setup.copyFiles.map((f) => f.trim()).filter(Boolean) }
        : null
      const was = JSON.stringify(p.worktreeSetup)
      p.worktreeSetup = clean && (clean.command || clean.copyFiles.length) ? clean : null
      if (was !== JSON.stringify(p.worktreeSetup)) this.emit({ type: 'projects_changed' })
    },
    // As the host keeps them (manager.setAgentInstructions, #1161 item 2): trimmed, told to every window when changed
    setAgentInstructions: async (projectId: string, text: string) => {
      const p = this.projectStore.list.find((x) => x.id === projectId)
      if (!p) throw projectNotFound(projectId)
      const clean = text.trim()
      if (p.agentInstructions === clean) return
      p.agentInstructions = clean
      this.emit({ type: 'projects_changed' })
    },
    /** The project's worktree trunk (#76), as the real host's `worktrees.setTrunk` sets it */
    setWorktreeTrunk: async (projectId: string, baseBranch: string) => {
      const p = this.projectStore.list.find((x) => x.id === projectId)
      if (!p) throw projectNotFound(projectId)
      const branch = baseBranch.trim()
      if (!branch) throw mockError('Pick the branch worktrees should fork from')
      p.worktreeManager = { sessionId: p.worktreeManager?.sessionId ?? '', baseBranch: branch }
      this.emit({ type: 'projects_changed' })
    },
  }

  constructor(
    private readonly clock: MockClock,
    private readonly emit: Emit,
    private readonly store: SessionStore,
    private readonly projectStore: ProjectStore,
    private readonly registry: AppRegistry,
    private readonly toolsMock: ToolsMock,
    private readonly gridMock: GridMock,
    private readonly machinesMock: MachinesMock,
    private readonly trashMock: TrashMock,
  ) {}
}
