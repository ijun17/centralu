import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { GitSource, ProjectInfo, RpcResult } from '@cc/protocol'
import { gitSourceError, projectAddQuestion, repoNameOf } from '@cc/protocol'
import type { LinkedSessions } from '../adapters/contract.js'
import { gitOriginUrl, isRepo } from '../dev-services/git.js'
import { gitValidBranchName } from '../dev-services/git-worktree.js'
import { cloneInto } from '../dev-services/project-clone.js'
import { canonicalPath } from '../dev-services/path-guard.js'
import { makeProjectFolder, projectFolderTarget, type ProjectFolderTarget } from '../dev-services/project-folder.js'
import { foldsPathCase } from '../os.js'
import { rpcError } from '../rpc-error.js'
import type { DelegationHost } from './delegation-flow.js'
import type { SessionTrashHost } from './session-trash.js'

/**
 * What making a project reaches of the session manager (#428), typed as the manager declares each member. The manager
 * builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type ProjectCreationHost = Pick<DelegationHost, 'askHost' | 'emit' | 'onEvent' | 'store'> & Pick<SessionTrashHost, 'appsHub' | 'projectInfo'>

/** What a folder is, as `projects.inspect` answers (#1220) */
export type FolderFacts = RpcResult<'projects.inspect'>

/** add_project's answer (#1220): the project registered, or why not, in words for the model */
export type FolderAdded = { ok: true; projectId: string; name: string; path: string; machine?: string } | { ok: false; error: string }

/**
 * A project registered or made on this machine (#515, #655): an existing folder added, a new folder made empty or
 * cloned, where it would go, and the orchestrator's create_project behind the person's card, here or on a linked
 * machine (#82 phase 4). Moved out of the session manager as it was (#428); what it reaches of the manager is
 * `ProjectCreationHost`.
 */
export class ProjectCreation {
  constructor(private readonly host: ProjectCreationHost) {}

  /**
   * `trusted` is the trust a project new to this host starts with (#655); registering a folder that is already a
   * project never changes its trust. Registering an existing folder from the screen leaves it untrusted, as the
   * person decides; only `createProject` passes it, for a folder it made empty itself.
   */
  async addProject(path: string, opts: { trusted?: boolean } = {}): Promise<ProjectInfo> {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw rpcError(`Directory not found: ${path}`)
    }
    // One folder is one project (#849): `C:\proj\`, `c:\proj` and `C:\Proj` were three. A new one is kept without a
    // trailing separator and with a capital drive letter; one already kept in another spelling is found and kept as is
    const spelled = resolve(path).replace(/^[a-z]:/, (drive) => drive.toUpperCase())
    const existing = this.projectAt(spelled)
    const at = existing?.path ?? spelled
    const id = existing?.id ?? randomUUID()
    this.host.store.projects.addProject({ id, path: at, name: basename(at), ...(opts.trusted ? { trusted: true } : {}) })
    return this.host.projectInfo(id, at)
  }

  /**
   * The orchestrator's add_project once the person allowed it (#1220), as the sidebar's Add project (`projects.add`)
   * registers a folder: the same checks and registration (`addProject`, untrusted when new), then the apps list read
   * again, since the folder may hold apps. The RPC handler refreshes the runtime it was given rather than this one, which
   * is the same runtime in a running host (main.ts).
   */
  async registerFolder(path: string): Promise<ProjectInfo> {
    const info = await this.addProject(path)
    this.host.appsHub?.rt.refresh()
    return info
  }

  /**
   * What a folder on this machine is (#1220, `projects.inspect`), nothing changed: whether it is there and a folder,
   * whether it is in a git repository and that repository's `origin` (read from its config, as an untrusted project's
   * git reads are: none of its programs runs), and the project already kept for it. A leading `~` is this machine's
   * home; any other path that is not absolute is refused.
   */
  async inspectFolder(given: string): Promise<FolderFacts> {
    const typed = given.trim()
    const expanded = /^~(?=$|[\\/])/.test(typed) ? join(homedir(), typed.slice(1)) : typed
    if (!expanded || !isAbsolute(expanded)) throw rpcError(`Give the folder's full path: ${JSON.stringify(given)} is not one`)
    // Spelled as addProject keeps a new one: no trailing separator, a capital drive letter
    const path = resolve(expanded).replace(/^[a-z]:/, (drive) => drive.toUpperCase())
    let found: ReturnType<typeof statSync> | null
    try {
      found = statSync(path)
    } catch {
      found = null
    }
    const folder = found?.isDirectory() === true
    const git = folder ? await isRepo(path).catch(() => false) : false
    const origin = git ? await gitOriginUrl(path, { trusted: false }) : null
    const kept = folder ? this.projectAt(path) : undefined
    const project = kept ? { id: kept.id, name: this.host.store.projects.listProjects().find((p) => p.id === kept.id)?.name ?? basename(kept.path) } : null
    return { path, exists: found !== null, folder, git, origin, project }
  }

  /**
   * add_project on this computer (#1220): the folder's facts read first, a refusal before any card for a path that is
   * missing, a file or already a project, then the person's card with those facts on it. On Allow they are read again
   * (the folder may have gone, or been added, while the card stood) and it is registered through `registerFolder`, as the
   * sidebar's own path; the windows hear which project it is, to ask about its trust as Add project does.
   */
  async addFolderAsked(sessionId: string, path: string, signal?: AbortSignal): Promise<FolderAdded> {
    try {
      const facts = await this.inspectFolder(path)
      const refused = folderRefusal(facts) ?? (await this.askFolderAdd(sessionId, facts, undefined, signal))
      if (refused) return { ok: false, error: refused }
      const changed = folderRefusal(await this.inspectFolder(facts.path))
      if (changed) return { ok: false, error: `${changed} It changed while the card stood, so nothing was added.` }
      const info = await this.registerFolder(facts.path)
      this.host.emit({ type: 'projects_changed', added: info.id })
      return { ok: true, projectId: info.id, name: info.name, path: info.path }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /**
   * add_project on a linked machine (#1220): the same, with the facts that machine's host reads (`projects.inspect`
   * there) and, on Allow, read again and that machine's `projects.add`, the call the sidebar's Add project on its group
   * makes. That host makes the same checks again when it registers the folder.
   */
  async addFolderOnMachine(sessionId: string, reader: LinkedSessions, machine: { id: string; name: string }, path: string, signal?: AbortSignal): Promise<FolderAdded> {
    const read = await reader.inspectFolder(machine.id, path)
    if (!read.ok) return read
    const refused = folderRefusal(read.facts, machine.name) ?? (await this.askFolderAdd(sessionId, read.facts, machine.name, signal))
    if (refused) return { ok: false, error: refused }
    // Read again, as here: a folder gone or added while the card stood is not added
    const again = await reader.inspectFolder(machine.id, read.facts.path)
    if (!again.ok) return again
    const changed = folderRefusal(again.facts, machine.name)
    if (changed) return { ok: false, error: `${changed} It changed while the card stood, so nothing was added.` }
    const added = await reader.addProject(machine.id, read.facts.path)
    if (!added.ok) return added
    this.host.emit({ type: 'projects_changed', added: added.projectId })
    return { ...added, machine: machine.name }
  }

  /**
   * add_project's card (#1220): the person's refusal or a withdrawn card as the error the orchestrator reads, or null
   * once allowed. Asked under every preset (`alwaysAsk`), auto included: an existing folder can be anything on that
   * disk, and once it is a project the orchestrator can start sessions in it.
   */
  private async askFolderAdd(sessionId: string, facts: FolderFacts, machine: string | undefined, signal?: AbortSignal): Promise<string | null> {
    const card = { name: folderName(facts.path), path: facts.path, ...(machine ? { machine } : {}), exists: facts.exists, folder: facts.folder, git: facts.git, origin: facts.origin }
    const decision = await this.host.askHost(sessionId, { kind: 'project_add', ...card, text: projectAddQuestion(card) }, signal, { alwaysAsk: true })
    if (decision === 'deny') return 'The person did not approve it. Do not ask again unless they tell you to.'
    if (decision === null) return 'The card was withdrawn before the person answered, so nothing was added.'
    return null
  }

  /**
   * The project kept for this folder, in whatever spelling it was kept. Where paths fold case (Windows), two spellings
   * are one folder when their real paths are equal: `realpathSync.native` gives the case on disk and the long name for
   * a short one. Case is not folded by JS's rules, which join names Windows keeps apart (the Kelvin sign lowers to k)
   * and would merge two folders of a case-sensitive directory; only a kept path that is gone is matched by ASCII case.
   * Only a kept path that could name this folder is resolved (equal but for ASCII case, or with a short name in it),
   * and never one on a share, which may not answer: a registration does not touch every project's folder.
   */
  private projectAt(path: string): { id: string; path: string } | undefined {
    const exact = this.host.store.projects.findProjectByPath(path)
    if (exact) return { id: exact.id, path }
    const kept = this.host.store.projects.listProjects()
    if (!foldsPathCase()) return kept.find((p) => resolve(p.path) === path)
    const ascii = (p: string) => p.replace(/[A-Z]/g, (c) => c.toLowerCase())
    const real = canonicalPath(path)
    const near = new Set([ascii(path), ascii(real)])
    return kept.find((p) => {
      const spelled = resolve(p.path)
      if (!near.has(ascii(spelled)) && !spelled.includes('~')) return false
      if (spelled.startsWith('\\\\')) return ascii(spelled) === ascii(real)
      try {
        return realpathSync.native(spelled) === real
      } catch {
        return ascii(spelled) === ascii(real)
      }
    })
  }

  /**
   * Where a new project goes by default: this machine's `~/Centralu` (#515, `projectsHome`). Unset, there is none and
   * creating without a parent is refused — main.ts wires the real one in, so a test that forgets to give a folder
   * fails instead of writing in the home of whoever runs it.
   */
  projectsHome: () => string = () => {
    throw rpcError('This host has no default location for a new project — give a parent folder')
  }

  useProjectsHome(resolve: () => string): void {
    this.projectsHome = resolve
  }


  /**
   * The folder a new project would get, and whether a clone source is one this host clones (#515) — checked, nothing
   * made. With a source and no name, the folder is named after the repository.
   */
  private async newProjectTarget(name: string, parent?: string, source?: GitSource): Promise<ProjectFolderTarget> {
    if (source) {
      const urlError = gitSourceError(source.git)
      if (urlError) throw rpcError(urlError)
      if (source.branch !== undefined && !(await gitValidBranchName(source.branch))) {
        throw rpcError(`"${source.branch}" is not a branch name.`)
      }
    }
    const folder = name.trim() || (source ? repoNameOf(source.git) : '')
    if (!folder && source) throw rpcError('The repository address gives no name for the folder — give one.')
    return projectFolderTarget({ name: folder, parent }, parent?.trim() ? null : this.projectsHome())
  }

  /** Where `projects.create` would make the folder, and why it would refuse (#515) — nothing is made */
  async projectCreatePreview(name: string, parent?: string, source?: GitSource): Promise<{ parent: string; path: string | null; error: string | null }> {
    const given = parent?.trim()
    const location = given || this.projectsHome()
    if (!name.trim() && !source?.git.trim()) return { parent: location, path: null, error: null }
    try {
      const t = await this.newProjectTarget(name, given, source)
      return { parent: t.parent, path: t.path, error: null }
    } catch (e) {
      return { parent: location, path: null, error: (e as Error).message }
    }
  }

  /**
   * Makes a new project (#515): a folder named `name` in `parent` (this machine's `~/Centralu` when absent), empty, or a
   * clone of `source` made with this machine's git and saved sign-ins, then registers it. Never reuses anything
   * already there (`projectFolderTarget`). An empty folder is registered trusted, a clone untrusted (#655). A clone that fails leaves nothing behind: the folder this made is removed
   * and no project is registered.
   */
  async createProject(name: string, parent?: string, source?: GitSource): Promise<ProjectInfo> {
    const target = await this.newProjectTarget(name, parent, source)
    makeProjectFolder(target)
    if (source) {
      console.error(`[projects] cloning ${source.git}${source.branch ? ` (${source.branch})` : ''} into ${target.path}`)
      try {
        await cloneInto(source.git, target.path, target.parent, source.branch)
      } catch (e) {
        // Only the folder made just above: it held nothing before the clone
        rmSync(target.path, { recursive: true, force: true })
        console.error(`[projects] clone into ${target.path} failed, folder removed: ${(e as Error).message}`)
        throw e
      }
    }
    console.error(`[projects] made ${target.path}`)
    // A folder made empty here holds only what Centralu and the person write, so it starts trusted (#655). A clone
    // holds what a stranger's repository put there (an agent can ask for any URL), so the person decides, as today.
    const info = await this.addProject(target.path, { trusted: !source })
    // Every window learns of it, the one that asked included: the orchestrator's card answers no list (#515)
    this.host.emit({ type: 'projects_changed' })
    return info
  }

  /**
   * The folder a new app project would get (#1141): `<parent>/<id>`, in `~/Centralu` unless a parent is given — the
   * same default, rules and refusals as a new project's folder (`projectFolderTarget`). Checked, nothing made.
   */
  appProjectTarget(id: string, parent?: string): ProjectFolderTarget {
    return projectFolderTarget({ name: id, parent }, parent?.trim() ? null : this.projectsHome())
  }

  /**
   * Registers a folder Centralu just made for a new app (#1141) and tells every window. Trusted by default, as an empty
   * folder Centralu made is (#655): only Centralu's template is in it. An imported app's folder holds someone else's
   * code, so it is trusted only when the person chose "Import and enable".
   */
  async registerMadeFolder(path: string, opts: { trusted?: boolean } = {}): Promise<ProjectInfo> {
    const info = await this.addProject(path, { trusted: opts.trusted ?? true })
    this.host.emit({ type: 'projects_changed' })
    return info
  }

  /**
   * The orchestrator's create_app without a project (#1141) makes a folder and a project, so it asks on create_project's
   * card first, naming the folder; null once allowed, else why not (a refusal, a withdrawn card, a name taken).
   */
  async askAppProject(sessionId: string, spec: { id: string; parent?: string }, signal?: AbortSignal): Promise<string | null> {
    let target: ProjectFolderTarget
    try {
      target = this.appProjectTarget(spec.id, spec.parent)
    } catch (e) {
      return (e as Error).message
    }
    return this.askProjectCreate(sessionId, { name: target.name, path: target.path }, undefined, target.path, signal)
  }

  /**
   * create_project (#515): the orchestrator's request becomes a card in its own approval slot, with the full path (and
   * the repository, for a clone) on it, and the folder is made only when the person allows it. Checked before the card
   * (a refusal costs the person nothing) and again after it (a folder of that name may have appeared while the card
   * stood). A clone says so in the conversation while it runs, since it can take minutes.
   */
  async createProjectAsked(
    sessionId: string,
    spec: { name: string; parent?: string; source?: GitSource },
    signal?: AbortSignal,
  ): Promise<{ ok: true; projectId: string; name: string; path: string } | { ok: false; error: string }> {
    let target: ProjectFolderTarget
    try {
      target = await this.newProjectTarget(spec.name, spec.parent, spec.source)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    const refused = await this.askProjectCreate(sessionId, { name: target.name, path: target.path }, spec.source, target.path, signal)
    if (refused) return { ok: false, error: refused }
    try {
      const info = await this.createProject(target.name, spec.parent, spec.source)
      return { ok: true, projectId: info.id, name: info.name, path: info.path }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /**
   * The orchestrator's create_project on a linked machine (#82 phase 4): the same card as here, naming the machine,
   * with the path that machine would make (`projects.createPreview` there, in its own path terms); on Create, the
   * machine makes and registers it (`projects.create` there). Nothing is made on either machine before the answer.
   */
  async createProjectOnMachine(
    sessionId: string,
    reader: LinkedSessions,
    machine: { id: string; name: string },
    spec: { name: string; parent?: string; source?: GitSource },
    signal?: AbortSignal,
  ): Promise<{ ok: true; projectId: string; name: string; path: string; machine: string } | { ok: false; error: string }> {
    const preview = await reader.previewProject(machine.id, spec)
    if (!preview.ok) return preview
    const refused = await this.askProjectCreate(sessionId, { name: preview.name, path: preview.path, machine: machine.name }, spec.source, `${preview.path} on ${machine.name}`, signal)
    if (refused) return { ok: false, error: refused }
    const made = await reader.createProject(machine.id, spec)
    return made.ok ? { ...made, machine: machine.name } : made
  }

  /**
   * create_project's card (#515), here or for a linked machine: the person's refusal or a withdrawn card as the error
   * the orchestrator reads, or null once allowed. A clone says so in the conversation while it runs (into `where`),
   * since it can take minutes.
   */
  private async askProjectCreate(
    sessionId: string,
    card: { name: string; path: string; machine?: string },
    source: GitSource | undefined,
    where: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const decision = await this.host.askHost(sessionId, { kind: 'project_create', name: card.name, path: card.path, ...(source ? { source } : {}), ...(card.machine ? { machine: card.machine } : {}) }, signal)
    if (decision === 'deny') return 'The person did not approve it. Do not ask again unless they tell you to.'
    if (decision === null) return 'The card was withdrawn before the person answered, so nothing was made.'
    if (source) this.host.onEvent({ type: 'notice', sessionId, level: 'info', from: 'Centralu', label: 'cloning', text: `Cloning ${source.git} into ${where}…` })
    return null
  }
}

/** A folder's name, from a path in either machine's terms */
function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

/** Why add_project stops before the card (#1220), in words for the model; null when the person can be asked */
function folderRefusal(facts: FolderFacts, machine?: string): string | null {
  const where = machine ? `${facts.path} on ${machine}` : facts.path
  if (!facts.exists) return `Nothing is at ${where}.`
  if (!facts.folder) return `${where} is a file, not a folder.`
  if (facts.project) return `${where} is already the project ${JSON.stringify(facts.project.name)} [${facts.project.id}].`
  return null
}
