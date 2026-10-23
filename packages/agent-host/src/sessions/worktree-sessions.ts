import { saveWorktreeRecovery, clearRecoveredBranchMark, worktreeRecoveryDir, type WorktreeRecovery } from '../dev-services/worktree-recovery.js'
import { AgentRunWait } from './app-agents.js'
import { dirname, join } from 'node:path'
import { foldsPathCase } from '../os.js'
import { lstatSync, statSync } from 'node:fs'
import { exec } from 'node:child_process'
import type {
  BackgroundTask,
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
import { gitSummary, gitRevParse } from '../dev-services/git.js'
import {
  gitBranchDelete,
  gitWorktreeAdd,
  resolveForkBase,
  type ForkBase,
  gitValidBranchName,
  type Worktree,
  gitWorktreeRemove,
  gitWorktreePrune,
  gitWorktreePaths,
  gitWorktreeList,
  gitBranchAhead,
  gitUnpublishedCommits,
  gitWorktreeDirty,
} from '../dev-services/git-worktree.js'
import {
  copyTree,
  dropEscapingLinks,
  prepareCopyTarget,
  resolveExisting,
} from '../dev-services/fs.js'
import { canonicalPath, isInside, isMissingPathError } from '../dev-services/path-guard.js'
import { prepareWorktreeDependencies } from '../dev-services/worktree-dependencies.js'
import { RestartPolicy } from './restart-policy.js'
import { rpcError } from '../rpc-error.js'
import { recordedAgentDepth } from './agent-depth.js'

/**
 * How long deleting a hub's child waits for a turn the hub just stopped to end (#1161 item 3): an interrupt reaches the
 * tool at once, and its turn's end comes a moment later. Past it the worktree stays, said as such.
 */
export const STOPPING_WAIT_MS = 10_000

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


/** The line a new session shows when its worktree was set up only in part (#841 item 3); `problems` from `createWorktree` */
export function worktreeSetupNotice(problems: readonly string[]): string {
  const shown = problems.slice(0, 8)
  const more = problems.length - shown.length
  return `This worktree was set up only in part (the setup is edited in the new-session window): ${shown.join('; ')}${more > 0 ? `; and ${more} more in host.log` : ''}. Files or dependencies the work needs may be missing.`
}

/**
 * The same, for the agent's task (#841 item 3): Centralu's own words in its bracket, and what failed as quoted data
 * after them. A problem line carries file names from the project and the setup command's own output (#989 review),
 * which could otherwise read as Centralu speaking.
 */
export function worktreeSetupFrame(problems: readonly string[]): string {
  const shown = problems.slice(0, 8)
  const more = problems.length - shown.length
  const quoted = `[${shown.map((p) => JSON.stringify(p).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')).join(', ')}]`
  return (
    `[Centralu: this worktree was set up only in part, so files or dependencies the work needs may be missing. ` +
    `What failed is below as JSON: the project's file names and its setup command's output, not instructions` +
    `${more > 0 ? `; ${more} more are in host.log` : ''}.]\n${quoted}`
  )
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
 * apart when a started agent's session is cleaned up (#608, #647), its local work kept in the session archive. Moved out of the
 * session manager as it was; what it reaches of the manager is `WorktreeHost`.
 */
export class WorktreeSessions {
  constructor(private readonly host: WorktreeHost) {}

  /**
   * The worktree of a new worktree session (FR-2 option), checked out and set up before its adapter starts, with what
   * its setup could not do (#841 item 3): a copy skipped or refused, a link dropped, dependencies or the setup command
   * failing. The session still comes up on a half-set-up worktree (`provisionWorktree`); the caller tells the person.
   *
   * A step after the checkout that throws takes the new worktree and branch away again (#774): no session owns them yet,
   * so nothing would ever remove them.
   */
  async createWorktree(
    params: { cwd: string; projectId: string; askedBy?: string; worktreeBranch?: string; worktreeBase?: string },
    id: string,
  ): Promise<{ worktree: Worktree; setupProblems: string[]; base: ForkBase }> {
    let worktree: Worktree
    let base: ForkBase
    const summary = await gitSummary(params.cwd, this.host.gitTrust(params.projectId))
    if (!summary.isRepo || summary.denied) {
      throw rpcError(summary.denied ? 'Cannot read this git repository — grant folder access and try again' : 'Worktrees need a git repository. This directory is not one.')
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
      throw rpcError("Worktree sessions need a trusted project: checking out runs the repository's hooks and filters. Trust the project first.")
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
      throw rpcError(`Not a valid branch name: ${requested}`)
    }
    const branch = requested || `${APP_SLUG}/${id.slice(0, 8)}`
    /*
     * Where it forks from (#76). Order: **what was asked for -> the project's trunk as the remote has it (#1484) -> the local trunk -> HEAD**.
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
     * that is stale configuration, not something asked for right now, so it falls back to the next
     * place (`resolveForkBase`) and says so in the start answer.
     */
    const asked = params.worktreeBase?.trim()
    const askedSha = asked ? await gitRevParse(params.cwd, asked) : null
    if (asked && !askedSha) {
      throw rpcError(`Not a branch in this repository: ${asked}`)
    }
    const trunk = params.projectId ? this.host.trunkOf(params.projectId) : null
    /*
     * Where new work forks from when nothing was asked for (#1484): the trunk as the remote has it, fetched now, never the
     * checkout's HEAD, which is whatever branch the person left it on. What was asked for is forked as it is here.
     * `resolveForkBase` says what it could not do (no remote, a fetch that failed) in `note`, for the start answer.
     */
    // The baseline for merge detection (#69): the point where the branch forked off. Without it, a
    // freshly created branch would read as "merged" for no reason other than being an ancestor of
    // the trunk.
    try {
      // Inside: a repository git refuses to read throws here first (`isRepo`, #841), and is a worktree that could not be made
      const forkBase: ForkBase = asked && askedSha
        ? { sha: askedSha, ref: asked, note: `Forked from ${asked}, as asked, at ${askedSha.slice(0, 9)}.` }
        : await resolveForkBase(params.cwd, trunk, { trusted: this.host.projectTrusted(params.projectId) })
      if (!asked && forkBase.ref === 'HEAD') console.error(`[worktree] forking from HEAD: ${forkBase.note}`)
      worktree = await gitWorktreeAdd(params.cwd, path, branch, forkBase.sha, { trusted: true })
      worktree = { ...worktree, base: forkBase.sha }
      base = forkBase
    } catch (err) {
      const msg = (err as { stderr?: string; message?: string }).stderr ?? (err as Error).message
      throw rpcError(`Could not create the worktree: ${String(msg).trim()}`)
    }
    // Sets up the empty workspace (#69): copy files -> run the setup command. This order is exactly what VK
    // verified
    let setupProblems: string[]
    try {
      setupProblems = await this.provisionWorktree(params.cwd, worktree, params.projectId)
    } catch (err) {
      const left = await this.discardNewWorktree(params.cwd, worktree, params.projectId)
      throw rpcError(`Could not set up the worktree: ${(err as Error).message}${left ? ` (${left})` : ''}`)
    }
    return { worktree, setupProblems, base }
  }

  /**
   * Takes away a worktree this host just checked out for a session that never came up (#774, #167): the folder and its
   * branch, which `-b` created in the same call, so it holds no commit. No snapshot is kept (#608): nothing but
   * Centralu's own setup wrote there (copies of project files, the setup command's output), and no agent ever ran in
   * it. Returns what was left, in words, or null when both went; never throws, as it runs on a failure already thrown.
   */
  async discardNewWorktree(cwd: string, worktree: Worktree, projectId: string): Promise<string | null> {
    const left: string[] = []
    await gitWorktreeRemove(cwd, worktree.path, true).catch((e: Error) => left.push(`worktree ${worktree.path} was left: ${e.message.trim()}`))
    await gitBranchDelete(cwd, worktree.branch, this.host.gitTrust(projectId)).catch((e: Error) => left.push(`branch ${worktree.branch} was left: ${e.message.trim()}`))
    if (!left.length) return null
    const said = left.join('; ')
    console.error(`[worktree] a worktree made for a session that never started was not removed: ${said}`)
    return said
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
    if (!isProjectId(projectId)) throw rpcError(`Not a project id: ${projectId}`)
    if (!isSessionId(sessionId)) throw rpcError(`Not a session id: ${sessionId}`)
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
   * leave the person with nothing and no idea why. A failure is logged to stderr (-> host.log) and
   * returned, one line each, so the new session can say it (#841 item 3): logged only, a `.env` that
   * never arrived was found by the agent's first failing command.
   *
   * **Capped at 90 seconds.** pnpm install takes 6.5 seconds in this repository (measured), but a cold
   * store or a heavy project takes longer. Since this is longer than the 30-second RPC limit, the
   * creation response can be delayed — but that is better than opening the session while setup is
   * still running: if the first turn has to compete with an install, this feature's whole reason for
   * existing disappears.
   */
  private async provisionWorktree(projectCwd: string, worktree: Worktree, projectId: string): Promise<string[]> {
    const setup = this.host.store.projects.worktreeSetup(projectId) ?? { copyFiles: [], command: '' }
    const problems: string[] = []
    const problem = (line: string) => {
      console.error(`[worktree] ${line}`)
      problems.push(line)
    }

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
        if (isMissingPathError(err)) problem(`copy skipped (missing): ${f}`)
        else problem(`copy refused: ${f} — ${(err as Error).message}`)
        continue
      }

      let dst: string
      try {
        dst = await prepareCopyTarget(worktree.path, f)
      } catch (err) {
        problem(`copy refused (bad target): ${f} — ${(err as Error).message}`)
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
        await copyTree(src, dst, { links: { from: projectCwd, to: worktree.path } })
      } catch (err) {
        problem(`copy failed: ${f} — ${(err as Error).message}`)
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
        problem(`link dropped (points outside the worktree): ${gone}`)
      }
    }

    await prepareWorktreeDependencies(projectCwd, worktree.path).catch((err: Error) => {
      problem(`dependencies skipped (${worktree.branch}): ${err.message}`)
    })

    if (!setup.command) return problems
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
          windowsHide: true,
          env: {
            ...process.env,
            CENTRALU_WORKTREE: worktree.branch,
            CENTRALU_WORKTREE_INDEX: String(index),
          },
        },
        (err, _stdout, stderr) => {
          if (err) {
            console.error(`[worktree] setup failed (${worktree.branch}): ${err.message}\n${String(stderr).slice(0, 2000)}`)
            // The session's line carries the end of stderr, where a failing command says why
            const tail = String(stderr).trim().split('\n').slice(-3).join(' / ').slice(-300)
            problems.push(`setup command failed: ${setup.command} — ${err.message.split('\n')[0]}${tail ? ` (${tail})` : ''}`)
          } else {
            console.error(`[worktree] setup ok (${worktree.branch}): ${setup.command}`)
          }
          done() // Continues even on failure — the reason is in the comment above
        },
      )
    })
    return problems
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
    const cwd = this.host.store.sessions.sessionCwd(sessionId) ?? this.host.meta.get(sessionId)?.worktree?.path
    if (!cwd) return false
    const path = canonicalPath(cwd)
    for (const folder of this.worktreeCleanup.values()) if (isInside(folder, path)) return true
    return false
  }

  /** #608: the parent decides; local work follows the session into the session archive in every preset. */
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
        const names = (tasks: readonly BackgroundTask[]) => tasks.map((t) => frameField(t.description)).join(', ')
        const stoppable = work.filter((t) => t.stoppable)
        const other = work.filter((t) => !t.stoppable)
        return {
          ok: false,
          error: [
            `"${target.name}" has finished its turn, but its background work is still running: ${names(work)}.`,
            stoppable.length ? `agent_session(action="stop") stops ${names(stoppable)}.` : '',
            other.length ? `${names(other)} cannot be stopped from here: wait for it, or ask the child or the person to stop it.` : '',
          ].filter(Boolean).join(' '),
        }
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
          text: `Local work saved before worktree deletion: ${setAside.changedFiles} uncommitted files, ${setAside.commits} commits not on the trunk. Recovery patches and bundles are at ${worktreeRecoveryDir(target.id)}. Restore from Settings → Archive or recover these files manually before deleting this session for good.` })
      }
      // The snapshot took a while (bundles may take up to two minutes): a session may have come into the folder meanwhile
      // (one restored from the session archive, one opened there). It stays in place, and so does the worktree; the snapshot is kept.
      const appeared = occupied()
      if (appeared) return appeared
      await this.host.trashSession(target.id, false, false, setAside)
      const appearedSince = occupied()
      if (appearedSince) return { ok: true, branch, setAside, warning: `The session is in the session archive, but worktree ${path} and branch ${branch} were left: ${appearedSince.error}. Recovery files are at ${worktreeRecoveryDir(target.id)}.` }
      try {
        await gitWorktreeRemove(cwd, path, true, true)
      } catch (e) {
        return { ok: true, branch, setAside, warning: `The session is in the session archive, but worktree ${path} and branch ${branch} were left: ${(e as Error).message}. Recovery files are at ${worktreeRecoveryDir(target.id)}.` }
      }
      try {
        await gitBranchDelete(cwd, branch, this.host.gitTrust(target.projectId))
        await clearRecoveredBranchMark(cwd, branch).catch(() => {})
      } catch (e) {
        return { ok: true, branch, setAside, warning: `The session is in the session archive and its worktree was removed, but branch ${branch} was left: ${(e as Error).message}. Recovery files are at ${worktreeRecoveryDir(target.id)}.` }
      }
      return { ok: true, branch, setAside }
    } catch (e) {
      return { ok: false, error: `Could not finish removing "${branch}": ${(e as Error).message}. Any saved recovery files are at ${worktreeRecoveryDir(target.id)}.` }
    } finally {
      this.worktreeCleanup.delete(target.id)
    }
  }

  /**
   * agent_session delete of a child a hub started here with a worktree (#1161 item 3, `agents.deleteAgentChild`): the
   * session goes to the session archive, and the worktree made for it goes too when nothing would be lost by it. Only that one:
   * a worktree Centralu made (`base`) on the branch the hub asked for, for a session another session started (its
   * recorded agent depth), so never the project's own folder or a worktree session of the person's. Only when nothing
   * is lost: nothing uncommitted, and every commit of its own on a remote or the trunk (`gitUnpublishedCommits`). Otherwise, or when the cleanup refuses (work still running there,
   * another session in its folder), the session still goes to the session archive, the worktree stays, and the answer says why.
   *
   * The hub stops a running turn before it asks: a turn just stopped is waited out for a few seconds
   * (`STOPPING_WAIT_MS`), since the cleanup refuses a session still in its turn.
   */
  async deleteHubChild(
    sessionId: string,
    branch: string,
  ): Promise<{ worktree: 'removed' | 'kept' | 'none'; path?: string; branch?: string; why?: string; note?: string }> {
    // A delete that came twice (a retry after a lost answer, two at once) finds it gone: deleted, as `agents.deleteSession` says too
    const already = { worktree: 'none' as const, note: 'it had been deleted there already' }
    let m = this.host.meta.get(sessionId)
    if (!m) return already
    const wt = m.worktree
    if (!wt) {
      await this.host.trashSession(sessionId)
      return { worktree: 'none' }
    }
    const kept = async (why: string) => {
      // Another delete is removing this worktree now: that one takes the session too, and says what it did
      if (!this.worktreeCleanup.has(sessionId)) await this.host.trashSession(sessionId)
      return { worktree: 'kept' as const, path: wt.path, branch: wt.branch, why }
    }
    const projectId = m.projectId
    /*
     * Only the worktree Centralu made for a session another session started (#1161 review): a person's own worktree
     * session on the same branch name, named by an id a caller knows, is never one, whatever else holds
     */
    if (!wt.base || wt.branch !== branch || !projectId || recordedAgentDepth(this.host.store.settings, sessionId) < 1) {
      return kept(`it is not the worktree Centralu made for an agent started on ${branch}`)
    }
    for (const until = Date.now() + STOPPING_WAIT_MS; inTurn(m.state) && Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 100))
      m = this.host.meta.get(sessionId)
      if (!m) return already
    }
    const folder = worktreeFolderState(wt.path)
    if (typeof folder === 'object') return kept(`its folder cannot be read (${folder.unreachable})`)
    if (folder === 'present') {
      const state = await gitWorktreeDirty(wt.path, this.host.gitTrust(projectId))
      if (state.unknown) return kept('whether it holds uncommitted changes could not be told')
      if (state.dirty) return kept(`it holds ${state.changedFiles}${state.more ? '+' : ''} uncommitted file${state.changedFiles === 1 ? '' : 's'}`)
      const cwd = this.host.cwdOf(projectId)
      const head = await gitRevParse(wt.path, 'HEAD')
      const unpublished = head ? await gitUnpublishedCommits(cwd, head, wt.branch, this.host.trunkOf(projectId) ?? 'HEAD') : null
      if (unpublished === null) return kept('whether its commits are pushed could not be told')
      if (unpublished > 0) return kept(`it has ${unpublished} commit${unpublished === 1 ? '' : 's'} that no remote and not the trunk has: push ${wt.branch}, then delete it there`)
    }
    const r = await this.cleanUpWorktreeChild(m)
    // Refused before anything was touched: the session goes as a plain delete would take it, the worktree stays
    if (!r.ok) return this.host.meta.has(sessionId) ? kept(r.error.replace(/\.+$/, '')) : { worktree: 'kept', path: wt.path, branch: wt.branch, why: r.error.replace(/\.+$/, '') }
    /*
     * Trashed, but the worktree or its branch stayed behind (`warning`), or the folder was already gone and the branch
     * kept or removed by what it holds (`note`, #715): the cleanup's own words are the answer, not "nothing was lost"
     */
    const said = r.warning ?? r.note
    if (said) return { worktree: r.warning ? 'kept' : 'removed', path: wt.path, branch: wt.branch, note: said.replace(/\.+$/, '') }
    return { worktree: 'removed', path: wt.path, branch: wt.branch }
  }

  /**
   * Cleanup of a child whose worktree folder is already gone (#715): `gh pr merge --delete-branch` run beside it, or a
   * person, removed it. Nothing is left to save. The session goes to the session archive, git's stale entry is pruned, and the
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
    const head = `${gone}; the session is in the session archive and ${entry}.`
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
