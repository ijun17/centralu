import { saveWorktreeRecovery, clearRecoveredBranchMark, worktreeRecoveryDir, type WorktreeRecovery } from '../dev-services/worktree-recovery.js'
import { AgentRunWait } from './app-agents.js'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { foldsPathCase } from '../os.js'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { exec } from 'node:child_process'
import type {
  NormalizedEvent,
  PermissionPreset,
  SessionInfo,
} from '@cc/protocol'
import {
  APP_SLUG,
  frameField,
  isProjectId,
  isSessionId,
  liveBackgroundTasks,
} from '@cc/protocol'
import type { SessionHandle } from '../adapters/contract.js'
import type { Store } from '../dev-services/store.js'
import { inTurn, sessionBusy } from '../idle.js'
import {
  gitSummary,
  gitHeadSha,
  gitRevParse,
  gitBranchDelete,
  gitWorktreeAdd,
  gitValidBranchName,
  type Worktree,
  gitWorktreeRemove,
  gitWorktreePrune,
  gitWorktreePaths,
  gitWorktreeList,
  gitBranchAhead,
} from '../dev-services/git.js'
import {
  copyTree,
  dropEscapingLinks,
  prepareCopyTarget,
  resolveExisting,
} from '../dev-services/fs.js'
import { isMissingPathError } from '../dev-services/path-guard.js'
import { prepareWorktreeDependencies } from '../dev-services/worktree-dependencies.js'
import { RestartPolicy } from './restart-policy.js'

/** A path resolved through the nearest folder that exists, so a folder not made yet still compares with its parent's real path */
export function canonicalPath(path: string): string {
  const full = resolve(path)
  try {
    return realpathSync.native(full)
  } catch {
    const parent = dirname(full)
    return parent === full ? full : join(canonicalPath(parent), basename(full))
  }
}

/** A path as a comparison key: real long name, forward slashes, no trailing slash, case-folded on Windows (git prints its own spelling) */
function pathKey(path: string): string {
  const key = canonicalPath(path).replace(/\\/g, '/').replace(/\/+$/, '')
  return foldsPathCase() ? key.toLowerCase() : key
}

/**
 * Whether a worktree folder is there, gone, or cannot be judged (#715). Gone means `lstat` failed with ENOENT and
 * the folder above it is there: an error of any other kind (EACCES, EIO), or a missing parent (a volume not mounted),
 * says nothing about the work inside, so the caller must not treat the folder as gone.
 */
function worktreeFolderState(path: string): 'present' | 'gone' | { unreachable: string } {
  try {
    lstatSync(path)
    return 'present'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') return { unreachable: `${code ?? 'error'}: ${(e as Error).message}` }
  }
  const parent = dirname(path)
  try {
    if (statSync(parent).isDirectory()) return 'gone'
    return { unreachable: `${parent} is not a folder` }
  } catch (e) {
    return { unreachable: `${parent} cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'}), so the folder may be on a volume that is not mounted` }
  }
}

/** Whether `path` is `folder` or lies inside it, judged by segment: `/a/wt-old` is not inside `/a/wt` */
export function insideFolder(path: string, folder: string): boolean {
  const rel = relative(folder, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * What the worktree code reaches of the session manager (#428), typed as the manager declares each member. The
 * manager builds it with getters for its fields, so each is read when used, never kept.
 */
export type WorktreeHost = {
  readonly agentRuns: Map<string, AgentRunWait>
  autoBoundaryOpen: (sessionId: string, boundary?: string) => boolean
  cwdOf: (projectId: string | null) => string
  gitTrust: (projectId: string | null) => { trusted: boolean; }
  readonly handles: Map<string, SessionHandle>
  readonly meta: Map<string, SessionInfo>
  onEvent: (raw: NormalizedEvent, from?: SessionHandle | null) => void
  projectTrusted: (projectId: string | null) => boolean
  readonly restartPolicy: RestartPolicy
  readonly resuming: Map<string, Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean; }>>
  readonly running: Map<string, { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null; permissionPreset: PermissionPreset; }>
  sessionsInside: (target: SessionInfo) => SessionInfo[]
  readonly store: Store
  trashSession: (sessionId: string, removeWorktree?: boolean, removeExternal?: boolean, recovery?: WorktreeRecovery, fromCleanup?: boolean) => Promise<void>
  readonly trashing: Map<string, Promise<void>>
  trunkOf: (projectId: string) => string | null
  readonly worktreeRoot: string
}

/**
 * A worktree session's worktree (#428): checked out and set up for a new session (FR-2 option, #69, #407), and taken
 * apart when a started agent's session is cleaned up (#608, #647), its local work kept in the trash. Moved out of the
 * session manager as it was; what it reaches of the manager is `WorktreeHost`.
 */
export class WorktreeSessions {
  constructor(private readonly host: WorktreeHost) {}

  /** The worktree of a new worktree session (FR-2 option), checked out and set up before its adapter starts */
  async createWorktree(
    params: { cwd: string; projectId: string; askedBy?: string; worktreeBranch?: string; worktreeBase?: string },
    id: string,
  ): Promise<Worktree> {
    let worktree: Worktree
    const summary = await gitSummary(params.cwd, this.host.gitTrust(params.projectId))
    if (!summary.isRepo || summary.denied) {
      throw Object.assign(
        new Error(
          summary.denied
            ? 'Cannot read this git repository — grant folder access and try again'
            : 'Worktrees need a git repository. This directory is not one.',
        ),
        { code: 'internal' },
      )
    }
    const path = this.worktreePathFor(params.projectId, id)
    /*
     * **Only in a trusted project (#407).** `git worktree add` checks every file out through the
     * repository's smudge filters and fires its `post-checkout` hook: the repository's own code,
     * before the person said the repository may run any. Why this refuses instead of checking
     * out with those turned off: `gitWorktreeAdd`. Nothing before this point ran the
     * repository's programs (the read above is locked for an untrusted project).
     */
    if (!this.host.projectTrusted(params.projectId) && !(params.askedBy && this.host.autoBoundaryOpen(params.askedBy, 'worktree in an untrusted project'))) {
      throw Object.assign(
        new Error("Worktree sessions need a trusted project: checking out runs the repository's hooks and filters. Trust the project first."),
        { code: 'internal' },
      )
    }
    /*
     * The person can set the branch name (#69) — because the branch name doubles as the session
     * name, it is effectively permanent. If not set, the session id's leading characters are used
     * (the session has no name yet, or the auto-name is applied later, and it can contain spaces
     * and unicode that would not work as a branch name). Validation is left to git itself — we do
     * not re-implement ref naming rules.
     */
    const requested = params.worktreeBranch?.trim()
    if (requested && !(await gitValidBranchName(requested))) {
      throw Object.assign(new Error(`Not a valid branch name: ${requested}`), { code: 'internal' })
    }
    const branch = requested || `${APP_SLUG}/${id.slice(0, 8)}`
    /*
     * Where it forks from (#76). Order: **what was asked for -> the project's trunk -> HEAD**.
     *
     * Why what was asked for comes first (user feedback, 2026-09-07: "there is no way to say
     * where to fork a new worker from"): the trunk is the project's default, not the answer for
     * every case. Without a way to say "just this one, from that branch", the only path left is
     * swapping the branch in the original folder, which gives up the whole reason for using
     * worktrees in the first place.
     *
     * If asked for something that does not exist, it is **rejected.** Silently falling back to
     * HEAD would let the person think it forked from that branch, and the mistake would not show
     * up until commits had already piled up. A trunk that has disappeared is a different case —
     * that is stale configuration, not something asked for right now, so it falls back to HEAD but
     * logs it.
     */
    const asked = params.worktreeBase?.trim()
    if (asked && !(await gitRevParse(params.cwd, asked))) {
      throw Object.assign(new Error(`Not a branch in this repository: ${asked}`), { code: 'internal' })
    }
    const trunk = params.projectId ? this.host.trunkOf(params.projectId) : null
    const fromTrunk = trunk && (await gitRevParse(params.cwd, trunk)) ? trunk : null
    if (trunk && !fromTrunk) console.error(`[worktree] trunk not found, forking from HEAD instead: ${trunk}`)
    const from = asked ?? fromTrunk
    // The baseline for merge detection (#69): the point where the branch forked off. Without it, a
    // freshly created branch would read as "merged" for no reason other than being an ancestor of
    // the trunk.
    const baseSha = from ? await gitRevParse(params.cwd, from) : await gitHeadSha(params.cwd)
    try {
      worktree = await gitWorktreeAdd(params.cwd, path, branch, from ?? undefined, { trusted: true })
      if (baseSha) worktree = { ...worktree, base: baseSha }
    } catch (err) {
      const msg = (err as { stderr?: string; message?: string }).stderr ?? (err as Error).message
      throw Object.assign(new Error(`Could not create the worktree: ${String(msg).trim()}`), { code: 'internal' })
    }
    // Sets up the empty workspace (#69): copy files -> run the setup command. This order is exactly what VK
    // verified
    await this.provisionWorktree(params.cwd, worktree, params.projectId)
    return worktree
  }

  /** A worktree is created **outside the repository** — the person's repository is never touched with it (not
   * even .gitignore) */
  private worktreePathFor(projectId: string, sessionId: string): string {
    /*
     * The two ids are exactly the two path segments (#132) — if either is not a plain segment, this
     * path lands outside the root. Given `"../escaped"`, a worktree was once created outside the root,
     * and the check for whether it was a registered project happened only after that. The type
     * boundary (`ProjectId`) already filters this, but the code building the path checks it again
     * itself — this function is also called by callers that never go through RPC.
     */
    if (!isProjectId(projectId)) throw Object.assign(new Error(`Not a project id: ${projectId}`), { code: 'internal' })
    if (!isSessionId(sessionId)) throw Object.assign(new Error(`Not a session id: ${sessionId}`), { code: 'internal' })
    return join(this.host.worktreeRoot, projectId, sessionId)
  }

  /**
   * Sets up a new worktree's workspace (#69): copy configured files, reuse JS dependencies, run setup.
   *
   * A fresh worktree is an empty workspace with only tracked files — no node_modules, no .env — so
   * the session's first turn starts not with real work but with "command not found". The agent cannot
   * even recover a .env-type file on its own (its contents were never in git). This is the single most
   * repeated complaint across this whole category.
   *
   * **Session creation continues even if this fails.** A half-set-up workspace is something the agent
   * can finish setting up itself, but failing to create the session just because setup died would
   * leave the person with nothing and no idea why. A failure is logged to stderr (-> host.log).
   *
   * **Capped at 90 seconds.** pnpm install takes 6.5 seconds in this repository (measured), but a cold
   * store or a heavy project takes longer. Since this is longer than the 30-second RPC limit, the
   * creation response can be delayed — but that is better than opening the session while setup is
   * still running: if the first turn has to compete with an install, this feature's whole reason for
   * existing disappears.
   */
  private async provisionWorktree(projectCwd: string, worktree: Worktree, projectId: string): Promise<void> {
    const setup = this.host.store.worktreeSetup(projectId) ?? { copyFiles: [], command: '' }

    for (const f of setup.copyFiles) {
      /*
       * Blocks path escape — this list is only ever meant to hold paths relative to inside the
       * project. The old comment claimed "same rule as the fs port", but in practice it was a plain
       * string comparison (#95): a `.env` that was actually a symlink pointing outside still passed
       * because its text looked like it was inside the project, and `cp -Rc` copied the symlink as a
       * symlink, leaving a window straight to `~/.ssh` inside the worktree (measured). Now it really
       * does call the same function — walking each segment with lstat, resolving links, and checking
       * the result is inside the realpath'd root.
       *
       * What comes back is **the real path.** So a `.env` link that pointed inside the project arrives
       * in the worktree as an actual file — not a window back into the original repository. If
       * worktree isolation can be broken by a single symlink, this feature has no reason to exist.
       */
      let src: string
      try {
        src = await resolveExisting(projectCwd, f)
      } catch (err) {
        // A missing file is skipped, but leaves a trace — if .env silently never arrives, that is discovered
        // much too late
        if (isMissingPathError(err)) console.error(`[worktree] copy skipped (missing): ${f}`)
        else console.error(`[worktree] copy refused: ${f} — ${(err as Error).message}`)
        continue
      }

      let dst: string
      try {
        dst = await prepareCopyTarget(worktree.path, f)
      } catch (err) {
        console.error(`[worktree] copy refused (bad target): ${f} — ${(err as Error).message}`)
        continue
      }
      /*
       * Session creation continues even if a single copy fails (#167) — this is the promise made in
       * the header comment above. This used to sit outside the try block, so a single unreadable file
       * inside node_modules threw an exception all the way out of createSession, and since that path
       * runs before the failure cleanup, the worktree and its branch were left with no owner.
       */
      try {
        // Clone is tried first (#76) — an 8.5GB target crosses over in 4 seconds and 10MB (measured). Falls
        // back to a plain copy if that fails
        await copyTree(src, dst)
      } catch (err) {
        console.error(`[worktree] copy failed: ${f} — ${(err as Error).message}`)
      }
      // Links inside the tree are checked only after the copy finishes — the line between what stays
      // and what gets removed lives in dropEscapingLinks.
      // Even if the copy stopped partway through, whatever links did cross over are still checked — a
      // half-finished tree can still have a window in it.
      // If nothing at all crossed over, there is nothing to check (any other kind of failure is still thrown)
      const landed = await dropEscapingLinks(worktree.path, dst).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return []
        throw err
      })
      for (const gone of landed) {
        console.error(`[worktree] link dropped (points outside the worktree): ${gone}`)
      }
    }

    await prepareWorktreeDependencies(projectCwd, worktree.path).catch((err: Error) => {
      console.error(`[worktree] dependencies skipped (${worktree.branch}): ${err.message}`)
    })

    if (!setup.command) return
    /*
     * Two deterministic variables — this is the entire extent of what the app knows about resource
     * assignment (#69's resource decision). The index is this project's existing worktree session
     * count + 1. It can be reused after a deletion, but the consequence of a collision is an error
     * message, not a disaster — the kind of thing an agent can read and fix.
     */
    const index = [...this.host.meta.values()].filter((s) => s.projectId === projectId && s.worktree).length + 1
    await new Promise<void>((done) => {
      exec(
        setup.command,
        {
          cwd: worktree.path,
          timeout: 90_000,
          env: {
            ...process.env,
            CENTRALU_WORKTREE: worktree.branch,
            CENTRALU_WORKTREE_INDEX: String(index),
          },
        },
        (err, _stdout, stderr) => {
          if (err) {
            console.error(
              `[worktree] setup failed (${worktree.branch}): ${err.message}\n${String(stderr).slice(0, 2000)}`,
            )
          } else {
            console.error(`[worktree] setup ok (${worktree.branch}): ${setup.command}`)
          }
          done() // Continues even on failure — the reason is in the comment above
        },
      )
    })
  }

  /** Prevent a send/resume from racing the snapshot and worktree removal: the child, by id, and its worktree folder */
  readonly worktreeCleanup = new Map<string, string>()

  /**
   * Whether a cleanup under way holds this session still (#647): the child whose worktree goes, and every session whose
   * folder is inside that worktree. A helper the child started works there; woken during the snapshot, it would write
   * into a folder about to be removed. Cheap while no cleanup runs, which is nearly always.
   */
  worktreeCleanupBlocks(sessionId: string): boolean {
    if (this.worktreeCleanup.size === 0) return false
    if (this.worktreeCleanup.has(sessionId)) return true
    const cwd = this.host.store.sessionCwd(sessionId) ?? this.host.meta.get(sessionId)?.worktree?.path
    if (!cwd) return false
    const path = canonicalPath(cwd)
    for (const folder of this.worktreeCleanup.values()) if (insideFolder(path, folder)) return true
    return false
  }

  /** #608: the parent decides; local work follows the session into the trash in every preset. */
  async cleanUpWorktreeChild(target: SessionInfo): Promise<{ ok: true; branch: string; setAside: { changedFiles: number; commits: number }; warning?: string; note?: string } | { ok: false; error: string }> {
    if (!target.worktree?.base || !target.projectId) {
      return { ok: false, error: `"${target.name}" works in no worktree of its own, so there is nothing to clean up — the person deletes a session` }
    }
    /*
     * Background work left after the turn (#718) is named, and it is what agent_session's stop stops. A timer the tool
     * holds (`/loop`, a scheduled prompt) is not work: stop cannot reach it, so it does not hold the cleanup either
     */
    const live = this.host.handles.has(target.id)
    const work = live ? liveBackgroundTasks(target.backgroundTasks).filter((t) => !t.timer) : []
    if (inTurn(target.state) || this.host.agentRuns.has(target.id) || sessionBusy({ ...target, live, backgroundTasks: work })) {
      if (!inTurn(target.state) && !this.host.agentRuns.has(target.id) && !target.pendingApproval && !target.pendingQuestions.length) {
        return { ok: false, error: `"${target.name}" has finished its turn, but its background work is still running: ${work.map((t) => frameField(t.description)).join(', ')}. agent_session(action="stop") stops it; wait for it or stop it first.` }
      }
      return { ok: false, error: `"${target.name}" is still working — stop it or wait first` }
    }
    // A folder that is already gone holds no work to lose (#715): cleanup goes on without a snapshot
    const folder = worktreeFolderState(target.worktree.path)
    if (typeof folder === 'object') {
      return { ok: false, error: `Cannot reach the worktree folder for "${target.name}" (${target.worktree.path}): ${folder.unreachable}. Nothing was removed; try again once the folder can be read.` }
    }
    const folderGone = folder === 'gone'
    if (this.host.resuming.has(target.id) || this.host.restartPolicy.deferredRestarts.has(target.id)) return { ok: false, error: `"${target.name}" is waking or restarting — wait for it first` }
    if (this.worktreeCleanup.has(target.id)) return { ok: false, error: 'This worktree is already being removed' }
    // A sidebar delete already under way keeps the worktree in place; it is not taken away behind it (#647)
    if (this.host.trashing.has(target.id)) return { ok: false, error: `"${target.name}" is already being deleted; its worktree stays in place` }
    const occupied = (): { ok: false; error: string } | null => {
      const occupants = this.host.sessionsInside(target)
      if (!occupants.length) return null
      return { ok: false, error: `${occupants.map((s) => `"${s.name}"`).join(', ')} ${occupants.length === 1 ? 'is' : 'are'} still in the worktree of "${target.name}" — delete ${occupants.length === 1 ? 'it' : 'them'} first` }
    }
    const taken = occupied()
    if (taken) return taken
    const { branch, path } = target.worktree
    this.worktreeCleanup.set(target.id, canonicalPath(path))
    try {
      const cwd = this.host.cwdOf(target.projectId)
      // Disposal must succeed before reading a snapshot or removing any files. An idle CLI is still a process.
      const handle = this.host.handles.get(target.id)
      if (handle) {
        await handle.dispose()
        this.host.handles.delete(target.id)
        this.host.running.delete(target.id)
      }
      if (folderGone) return await this.cleanUpGoneWorktree(target, cwd, branch, path)
      const trunk = await gitRevParse(cwd, this.host.trunkOf(target.projectId) ?? 'HEAD')
      const setAside = await saveWorktreeRecovery(target.id, path, trunk ?? 'missing-trunk', branch)
      if (setAside.changedFiles || setAside.commits) {
        this.host.onEvent({ type: 'notice', sessionId: target.id, level: 'info', from: 'Centralu', label: 'worktree recovery',
          text: `Local work saved before worktree deletion: ${setAside.changedFiles} uncommitted files, ${setAside.commits} commits not on the trunk. Recovery patches and bundles are at ${worktreeRecoveryDir(target.id)}. Restore from Settings → Trash or recover these files manually before deleting this session for good.` })
      }
      // The snapshot took a while (bundles may take up to two minutes): a session may have come into the folder meanwhile
      // (one restored from the trash, one opened there). It stays in place, and so does the worktree; the snapshot is kept.
      const appeared = occupied()
      if (appeared) return appeared
      await this.host.trashSession(target.id, false, false, setAside)
      const appearedSince = occupied()
      if (appearedSince) return { ok: true, branch, setAside, warning: `The session is in the trash, but worktree ${path} and branch ${branch} were left: ${appearedSince.error}. Recovery files are at ${worktreeRecoveryDir(target.id)}.` }
      try {
        await gitWorktreeRemove(cwd, path, true, true)
      } catch (e) {
        return { ok: true, branch, setAside, warning: `The session is in the trash, but worktree ${path} and branch ${branch} were left: ${(e as Error).message}. Recovery files are at ${worktreeRecoveryDir(target.id)}.` }
      }
      try {
        await gitBranchDelete(cwd, branch, this.host.gitTrust(target.projectId))
        await clearRecoveredBranchMark(cwd, branch).catch(() => {})
      } catch (e) {
        return { ok: true, branch, setAside, warning: `The session is in the trash and its worktree was removed, but branch ${branch} was left: ${(e as Error).message}. Recovery files are at ${worktreeRecoveryDir(target.id)}.` }
      }
      return { ok: true, branch, setAside }
    } catch (e) {
      return { ok: false, error: `Could not finish removing "${branch}": ${(e as Error).message}. Any saved recovery files are at ${worktreeRecoveryDir(target.id)}.` }
    } finally {
      this.worktreeCleanup.delete(target.id)
    }
  }

  /**
   * Cleanup of a child whose worktree folder is already gone (#715): `gh pr merge --delete-branch` run beside it, or a
   * person, removed it. Nothing is left to save. The session goes to the trash, git's stale entry is pruned, and the
   * branch stays when it holds commits the trunk lacks (or when that cannot be told), so no work is lost with it.
   * Runs inside cleanUpWorktreeChild, which holds the cleanup mark.
   */
  private async cleanUpGoneWorktree(
    target: SessionInfo,
    cwd: string,
    branch: string,
    path: string,
  ): Promise<{ ok: true; branch: string; setAside: { changedFiles: number; commits: number }; note: string }> {
    const setAside = { changedFiles: 0, commits: 0 }
    const gone = `The worktree folder was already gone (${path})`
    await this.host.trashSession(target.id, false, false, undefined, true)
    const key = pathKey(path)
    const listedNow = async () => (await gitWorktreePaths(cwd)).some((p) => pathKey(p) === key)
    const had = await listedNow().catch(() => false)
    let entry: string
    try {
      await gitWorktreePrune(cwd)
      // Said only when git no longer lists it afterwards (a locked entry stays)
      entry = !had ? "git had no entry for it" : (await listedNow().catch(() => true)) ? "git's entry for it is still listed" : "git's entry was pruned"
    } catch (e) {
      return { ok: true, branch, setAside, note: `${gone}, but git's entry for it could not be pruned (${(e as Error).message}); branch ${branch} was left.` }
    }
    const head = `${gone}; the session is in the trash and ${entry}.`
    if ((await gitRevParse(cwd, `refs/heads/${branch}`)) === null) {
      return { ok: true, branch, setAside, note: `${head} Branch ${branch} was already gone.` }
    }
    const elsewhere = (await gitWorktreeList(cwd).catch(() => [])).find((w) => w.branch === branch)
    if (elsewhere) {
      return { ok: true, branch, setAside, note: `${head} Branch ${branch} was kept: it is checked out at ${elsewhere.path}.` }
    }
    const ahead = await gitBranchAhead(cwd, branch, this.host.trunkOf(target.projectId!) ?? 'HEAD')
    if (ahead === null || ahead > 0) {
      return { ok: true, branch, setAside, note: `${head} Branch ${branch} was kept${ahead ? ` because it has ${ahead} commit${ahead === 1 ? '' : 's'} the trunk lacks` : ''}.` }
    }
    try {
      await gitBranchDelete(cwd, branch, this.host.gitTrust(target.projectId!))
      await clearRecoveredBranchMark(cwd, branch).catch(() => {})
    } catch (e) {
      return { ok: true, branch, setAside, note: `${head} Branch ${branch} was left: ${(e as Error).message}.` }
    }
    return { ok: true, branch, setAside, note: `${head} The merged branch ${branch} was removed.` }
  }
}
