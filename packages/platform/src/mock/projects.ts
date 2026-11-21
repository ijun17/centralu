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
import { mockProjectInfo } from './session-info.js'
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
  /** By project id (#1301); absent: by the project's mark */
  readonly deleteOutlooks = new Map<string, 'stays' | 'may_move' | 'around_may_move' | 'unsure'>()
  readonly deleteOutlooksAsked: string[] = []
  /** Answers as a host before the call does */
  deleteOutlookUnknown = false
  /** The answer waits for this, as a slow or far host's does */
  deleteOutlookHold: Promise<void> | null = null
  /** As if a folder of that name were already there (#515) */
  takenPaths = new Set<string>()
  readonly createProjectCalls: { name: string; parent?: string; machine?: string | null; source?: GitSource }[] = []
  /** The next clone fails with this sentence (#515); null clones */
  nextCloneError: string | null = null

  /** As the host says (#515): `~/Centralu` here, a linked machine's in its own path terms, by the host's name rule */
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
  gitStatusCalls = 0
  readonly trustCalls: { projectId: string; trusted: boolean }[] = []
  readonly projects: ProjectPort = {
    /** As ProjectRegistry.reorderProjects (#999): a project missing from the list stays at the end */
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
       * As createProject (#655, #999): an empty folder holds only what Centralu and the person write, so it starts
       * trusted, with git null until an agent makes a repository. A clone is untrusted: a stranger's code is in it.
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
       * The last segment under either separator (#47): a project's path is native, and the host's `node:path`
       * `basename` reads `\` on Windows. e2e runs only the mock, so it must name `C:\Users\me\proj` `proj` too.
       */
      const info = mockProjectInfo({
        // A folder on a linked machine is named the way the hub names it: `<machine>.<id>`, with the machine said (#82)
        id: machine ? `${machine}.mock-project-${this.clock.next()}` : `mock-project-${this.clock.next()}`,
        ...(machine ? { machine } : {}),
        path,
        name: osPathBaseName(path) || path,
        defaultTool: this.toolsMock.firstRegisteredTool(),
      })
      this.projectStore.list.push(info)
      return info
    },
    /** The apps follow, as the runtime re-scans; else e2e passes while "Trust" leaves an app blocked */
    setTrusted: async (projectId: string, trusted: boolean) => {
      const at = this.projectStore.list.findIndex((x) => x.id === projectId)
      const current = this.projectStore.list[at]
      if (at === -1 || !current) throw projectNotFound(projectId)
      // A new object, as the host's answer always is: the screen holds the one `add` returned
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
     * As the host: each session to the archive first (#204, keeping its files and worktree), with `session_deleted`,
     * which the screen clears its list from; then the project.
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
    deleteOutlook: async (projectId: string) => {
      if (this.deleteOutlookUnknown) throw mockError('Unknown method: projects.deleteOutlook')
      await this.deleteOutlookHold
      const p = this.projectStore.list.find((x) => x.id === projectId)
      this.deleteOutlooksAsked.push(projectId)
      // As the host: a project it does not know leaves its folder alone
      return { folder: this.deleteOutlooks.get(projectId) ?? (p?.fromUserFolder ? ('may_move' as const) : ('stays' as const)) }
    },
    /** Strips blank lines as the host does (#44): a gentler mock keeps e2e green while the app differs */
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
      // The Run menu of every other window reads them, as the host tells it (ProjectRegistry.setProjectCommands, #719)
      if (was !== JSON.stringify(p.commands)) this.emit({ type: 'projects_changed' })
      return [...p.commands]
    },
    // As the host (#69): an empty setup is stored as null
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
