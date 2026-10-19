import type { FsResolvePurpose, NormalizedEvent, SessionInfo } from '@cc/protocol'
import { rpcError, sessionNotFound } from '../rpc-error.js'
import {
  gitStatusFiles,
  gitOriginUrl,
  gitDiff,
  gitLog,
  gitCommitDetail,
  gitBranches,
  gitIgnoredEntries,
} from './git.js'
import { gitCheckout, gitStage, gitCommit, gitPush, GitWriteRuns } from './git-write.js'
import {
  importFile,
  listDir,
  moveEntry,
  readTextFile,
  resolveEntry,
  resolveProjectFolder,
  resolveTarget,
} from './fs.js'
import { DirWatchers, type WatchHolder } from './watch.js'
import { invalidateFileIndex } from './file-search.js'
import { attachCommitSessions } from './git-attrib.js'
import { pathParts } from './path-guard.js'
import type { Store } from './store.js'

/**
 * What a project's git panel, file tree and file operations reach of the session manager (#1143). Injected, so this
 * module never imports `sessions/`: the manager answers each with what it holds, read when called, never kept.
 */
export type ProjectFilesHost = {
  /** A project's folder; throws `Project not found` for one that is not registered (the manager's `cwdOf`) */
  rootOf(projectId: string): string
  /** The project's trust as a git read needs it (#407), read fresh on every call (the manager's `gitTrust`) */
  trust(projectId: string): { trusted: boolean }
  /** A session the manager holds now: its name on a commit, its worktree as a file link's folder */
  session(sessionId: string): Pick<SessionInfo, 'name' | 'projectId' | 'worktree'> | undefined
  /** The store's sessions and trash, for which session made each commit (#50, #96) */
  readonly store: Pick<Store, 'sessions' | 'trash'>
  /** The host's event stream, for `fs_changed`; looked up when a change is sent, as the manager re-wraps it */
  emit(e: NormalizedEvent): void
}

/**
 * A project's git panel (B-1), file tree and viewer (C-1) and file operations (#19), as the RPC router reaches them
 * through the session manager. Only path resolution happens here; the actual work is delegated to the rest of
 * dev-services. Moved out of the session manager as it was (#1143).
 */
export class ProjectFiles {
  /**
   * Watcher for the file tree (#34). Only watches expanded directories — the UI sends the set via
   * fs.watch. Changes go out as an fs_changed event (it is a project-level event, so it has no
   * sessionId).
   */
  private readonly watchers = new DirWatchers((projectId, dirs) => this.host.emit({ type: 'fs_changed', projectId, dirs }))
  /** The git panel's writes still running, so the person can cancel one (`git.cancel`, #1007) */
  private readonly gitWrites = new GitWriteRuns()

  constructor(private readonly host: ProjectFilesHost) {}

  /** How many of a project's directories are watched (tests) */
  watchedDirCount(projectId: string): number {
    return this.watchers.watchedCount(projectId)
  }

  /** What was held for a deleted project's folder goes with it (#392): its watchers and its `@` file index */
  forgetProject(projectId: string, root: string | undefined): void {
    this.watchers.drop(projectId)
    if (root) invalidateFileIndex(root)
  }

  /** The host is leaving: every folder stops being watched */
  close(): void {
    this.watchers.close()
  }

  // ── Git (B-1) — only path resolution happens here; the actual work is delegated to dev-services ──

  /** The project's `origin` remote (#1038), read as a git read is, under its trust; null with no repository or no origin */
  projectOrigin(projectId: string): Promise<string | null> {
    return gitOriginUrl(this.host.rootOf(projectId), this.host.trust(projectId))
  }

  gitStatusFiles(projectId: string) {
    return gitStatusFiles(this.host.rootOf(projectId), this.host.trust(projectId))
  }
  gitDiff(projectId: string, path: string, staged?: boolean) {
    return gitDiff(this.host.rootOf(projectId), path, { staged, ...this.host.trust(projectId) })
  }
  async gitLog(projectId: string, limit?: number) {
    const commits = await gitLog(this.host.rootOf(projectId), limit)
    // Tags which session created each commit (#50) — passes through untouched wherever there is no record
    // A commit link of a session in the trash is kept (#96, #204) — and says where the session is rather than "deleted"
    const trashed = this.host.store.trash.trashedIds()
    return attachCommitSessions(commits, this.host.store.sessions.commitSessions(projectId), (sid) =>
      this.host.session(sid)?.name ?? (trashed.has(sid) ? '(in the trash)' : undefined),
    )
  }
  gitCommitDetail(projectId: string, sha: string) {
    return gitCommitDetail(this.host.rootOf(projectId), sha, this.host.trust(projectId))
  }
  gitBranches(projectId: string) {
    return gitBranches(this.host.rootOf(projectId))
  }
  /** Things a fresh worktree will not have (#76) — used to point out candidates to copy */
  gitIgnoredEntries(projectId: string) {
    return gitIgnoredEntries(this.host.rootOf(projectId), undefined, this.host.trust(projectId))
  }
  gitCheckout(projectId: string, branch: string, dryRun?: boolean) {
    const cwd = this.host.rootOf(projectId)
    return this.gitWrites.run(projectId, (signal) => gitCheckout(cwd, branch, { dryRun, signal, ...this.host.trust(projectId) }))
  }
  gitStage(projectId: string, paths: string[], unstage?: boolean) {
    const cwd = this.host.rootOf(projectId)
    return this.gitWrites.run(projectId, (signal) => gitStage(cwd, paths, unstage, signal))
  }
  gitCommit(projectId: string, message: string) {
    const cwd = this.host.rootOf(projectId)
    return this.gitWrites.run(projectId, (signal) => gitCommit(cwd, message, signal))
  }
  gitPush(projectId: string) {
    const cwd = this.host.rootOf(projectId)
    return this.gitWrites.run(projectId, (signal) => gitPush(cwd, signal))
  }
  /** Ends the git panel's write still running for this project (#1007); whether there was one */
  gitCancel(projectId: string): { cancelled: boolean } {
    return { cancelled: this.gitWrites.cancel(projectId) }
  }

  // ── File tree/viewer (C-1) ──
  listDir(projectId: string, path: string) {
    return listDir(this.host.rootOf(projectId), path, this.host.trust(projectId))
  }

  /**
   * Updates the file tree's watch set (#34). When the UI sends the whole set of expanded
   * directories, changes come back as an `fs_changed` event — this lives here because the direction
   * is round-trip: the request arrives via RPC, but the answer (a change) goes out through the same
   * broadcast path as a session event.
   */
  watchDirs(projectId: string, paths: readonly string[], holder?: WatchHolder): number {
    return this.watchers.setWatched(projectId, this.host.rootOf(projectId), paths, holder)
  }

  /** A window's connection closed: the folders only it had open stop being watched (#842 item 6) */
  forgetWatchHolder(holder: WatchHolder): void {
    this.watchers.forgetHolder(holder)
  }
  readTextFile(projectId: string, path: string, sessionId?: string) {
    return readTextFile(this.folderOf(projectId, sessionId), path)
  }

  /**
   * The folder a file link of this session is in (#1209): its worktree, or the project's when it has none. Without a
   * session, the project's. A session of another project is refused, so a project's id cannot carry another's folder.
   * The answer is the root the caller both checks the path against and reads through: one string, never re-derived.
   */
  private folderOf(projectId: string, sessionId: string | undefined): string {
    if (sessionId === undefined) return this.host.rootOf(projectId)
    const m = this.host.session(sessionId)
    if (!m) throw sessionNotFound(sessionId)
    if (m.projectId !== projectId) throw rpcError(`Session ${sessionId} is not a session of this project`)
    return m.worktree?.path ?? this.host.rootOf(projectId)
  }

  // ── File operations (#19) — only path resolution happens here; validation and execution are delegated to
  // dev-services ──
  moveEntry(projectId: string, from: string, toDir: string) {
    return moveEntry(this.host.rootOf(projectId), from, toDir)
  }
  importFile(projectId: string, toDir: string, name: string, dataBase64: string) {
    return importFile(this.host.rootOf(projectId), toDir, name, Buffer.from(dataBase64, 'base64'))
  }
  /** The absolute path handed to the OS by the desktop shell (trash, file manager, IDE). Built by the side that
   * knows the project: for the trash the entry itself, a link included; otherwise what it is, a link followed inside the
   * project; never the project folder (#838) */
  resolveFile(projectId: string, path: string, purpose?: FsResolvePurpose, sessionId?: string) {
    // A session's folder is only revealed and opened: the trash and the project folder stay the project's (#1209)
    if (sessionId !== undefined && (purpose === 'trash' || purpose === 'project'))
      throw rpcError(`A session's folder is not resolved for ${purpose}`)
    if (sessionId !== undefined) return resolveTarget(this.folderOf(projectId, sessionId), path)
    const root = this.host.rootOf(projectId)
    // The project folder for its delete dialog only (#838); an older window's dialog sends the literal root and no purpose
    if (purpose === 'project' || (purpose === undefined && pathParts(root, path).length === 0)) return resolveProjectFolder(root)
    return purpose === 'trash' ? resolveEntry(root, path) : resolveTarget(root, path)
  }
}
