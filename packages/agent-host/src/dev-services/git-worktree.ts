import { existsSync, lstatSync } from 'node:fs'
import { wireSegments } from '@cc/protocol'
import { join } from 'node:path'
import { traitsFor } from '../os.js'
import { rpcError } from '../rpc-error.js'
import { execFailure } from './exec-error.js'
import { runGit } from './git-exec.js'
import { git, gitHeadSha, gitRevParse, gitSummary, isRepo, type GitTrust, type SummaryLimits } from './git.js'
import { cloneEnv } from './project-clone.js'
import { gitWrite } from './git-write.js'
import { removeData } from './data-folder.js'
import { canonicalPath } from './path-guard.js'


/*
 * ── Worktrees (FR-2's lower-priority option) ─────────────────────────────────────
 *
 * **Working directly in the original directory is the default.** A worktree is an isolation
 * mechanism only someone who wants it turns on, and every function here exists for that one
 * checkbox.
 *
 * The location is **outside the repository** (`~/.centralu/worktrees/…`). Putting it inside
 * would require adding a line to `.gitignore` — us editing the user's own file — and leaving it
 * out would make `git status` messy.
 */

export type Worktree = { path: string; branch: string; base?: string }

/**
 * Creates a new worktree and branch. The branch forks **from the current HEAD.**
 *
 * A failure here is never swallowed: if the worktree could not be created but the session went
 * on to run quietly in the original directory, the user believes it is isolated — the worst
 * possible outcome for this feature.
 */
/**
 * Creates one worktree.
 *
 * Given `from`, it forks **from that trunk** (#76). Without it, it falls back to forking from
 * the root's HEAD as before, which is a baseline whose meaning silently changes the moment a
 * person switches branches in the root — with the manager holding the trunk, the answer to
 * "where does this fork from" is pinned to one value.
 *
 * Given a trunk that does not exist, git rejects it. Why this is not checked in advance and
 * quietly falls back to HEAD: a worktree that forked from somewhere other than its named trunk
 * comes back later as "why isn't this being detected as merged."
 */
export async function gitWorktreeAdd(
  repoCwd: string,
  path: string,
  branch: string,
  from?: string,
  trust: GitTrust = {},
  /** The branch is there already (#1662): the worktree checks it out as it is, and `from` is not read */
  existing = false,
): Promise<Worktree> {
  /*
   * **Only in a trusted project (#407).** A checkout writes every tracked file through the
   * repository's smudge filters and then fires `post-checkout` (and `reference-transaction` for
   * the new branch). Turning those off is not a safe middle: the worktree would hold files the
   * filters never converted (an LFS pointer, a git-crypt blob), which the session then edits and
   * commits back. `--no-checkout` avoids the filters but leaves an empty folder the agent would
   * have to fill by running git itself. Refusing leaves nothing half-made; the manager says why
   * before it gets here.
   */
  if (trust.trusted !== true) {
    throw rpcError('A worktree can only be created in a trusted project')
  }
  await gitWrite(repoCwd, existing ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, ...(from ? [from] : [])])
  return { path, branch }
}

/** How long the fetch of a worktree's base may take before the worktree forks from what is here (#1484) */
export const FORK_FETCH_TIMEOUT_MS = 20_000

/** Where a new worktree forks from (#1484): the commit, the ref it was read from, and a note for the start answer, without a final period (the answer adds its own) */
export type ForkBase = {
  sha: string | null; ref: string; note: string
  /** There is a remote and it was not fetched (it failed, or the project is not trusted): the local ref may be behind it (#1488) */
  unfetched?: true
}

/** A repository with no commit: git makes the worktree on an unborn branch, with nothing to record as the base */
const NO_COMMIT: ForkBase = { sha: null, ref: 'HEAD', note: 'This repository has no commit yet, so the worktree starts empty' }

const short = (sha: string) => sha.slice(0, 9)

/** How many commits `range` (`a..b`) holds; null when it cannot be told */
async function commitCount(cwd: string, range: string): Promise<number | null> {
  const n = Number((await git(cwd, ['rev-list', '--count', range]).catch(() => '')).trim())
  return Number.isFinite(n) && n >= 0 ? n : null
}

async function configValue(cwd: string, key: string): Promise<string> {
  return (await git(cwd, ['config', '--get', key]).catch(() => '')).trim()
}

/**
 * The commit a new worktree for new work forks from (#1484): **the trunk as the remote has it**, not whatever the checkout
 * has checked out. Forking from the checkout's HEAD gave a session a base 279 commits behind main whenever the checkout sat
 * on another branch, and the work built on it (a store migration number main had taken) was lost.
 *
 * Order, for the trunk the project holds (`trunk`, null when none is set: then the remote's default branch, else a local
 * `main` or `master`):
 *   1. fetch the trunk from its remote, bounded (`timeoutMs`), and fork from the remote-tracking ref it updated;
 *   2. when there is no remote, the fetch failed or timed out, or the project is not trusted (a fetch reads the repository's
 *      network settings, which name programs: `core.sshCommand`, a credential helper, `core.gitProxy`): the newer of the
 *      local trunk and the remote-tracking ref last fetched, and the note says why and how far behind it may be;
 *   3. no trunk found at all: the checkout's HEAD, said as such. Nothing here throws for the fetch.
 *
 * It returns a commit, not a ref: `git worktree add -b <branch> <path> origin/main` would make the new branch track
 * `origin/main`, and the recorded base for merge detection (`baseSha`) is then exactly what the branch started from.
 * The fetch gives a prompt no one can answer nothing to wait on (`cloneEnv`), as a clone does.
 */
export async function resolveForkBase(
  repoCwd: string,
  trunk: string | null,
  opts: { trusted?: boolean; timeoutMs?: number } = {},
): Promise<ForkBase> {
  const remotes = (await git(repoCwd, ['remote']).catch(() => '')).split('\n').map((r) => r.trim()).filter(Boolean)
  const local = async (name: string) => (await gitRevParse(repoCwd, `refs/heads/${name}`)) ? name : null
  let branch: string | null = null
  let remote: string | null = null
  if (trunk) {
    const prefixed = remotes.find((r) => trunk.startsWith(`${r}/`))
    if (!(await local(trunk)) && prefixed) {
      remote = prefixed
      branch = trunk.slice(prefixed.length + 1)
    } else {
      branch = trunk
    }
  } else {
    const head = (await git(repoCwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim()
    if (head.startsWith('origin/') && remotes.includes('origin')) {
      remote = 'origin'
      branch = head.slice('origin/'.length)
    } else {
      branch = (await local('main')) ?? (await local('master'))
    }
  }
  if (!branch) {
    const sha = await gitHeadSha(repoCwd)
    if (!sha) return NO_COMMIT
    return { sha, ref: 'HEAD', note: `No trunk is set for this project and none was found (no remote default branch, no main or master), so the worktree forks from the checkout's HEAD at ${short(sha)}, which may not be the trunk` }
  }
  if (!remote) remote = await gitBranchRemote(repoCwd, branch, remotes)
  const tracking = remote ? `refs/remotes/${remote}/${branch}` : null
  let why: string
  if (!remote || !tracking) {
    why = 'This repository has no remote to fetch from'
  } else if (opts.trusted !== true) {
    why = `Not fetched: the project is not trusted, and a fetch runs the repository's network settings`
  } else {
    const fetched = await gitFetchBranch(repoCwd, remote, branch, opts.timeoutMs)
    if ('why' in fetched) why = fetched.why
    else {
      // Commits only the local trunk has: not on the remote, so not in the worktree
      const onlyLocal = (await local(branch)) ? await commitCount(repoCwd, `${tracking}..refs/heads/${branch}`) : null
      return {
        sha: fetched.sha,
        ref: `${remote}/${branch}`,
        note: `Forked from ${remote}/${branch} at ${short(fetched.sha)}, fetched just now${onlyLocal ? `. The local ${branch} has ${onlyLocal} commit(s) the remote does not, which the worktree does not have` : ''}`,
      }
    }
  }
  // Not fetched: the newer of the local trunk and the remote-tracking ref as last fetched
  const l = await gitRevParse(repoCwd, `refs/heads/${branch}`)
  const trackingName = remote ? `${remote}/${branch}` : null
  const t = tracking ? await gitRevParse(repoCwd, tracking) : null
  let ref: string | null = null
  let sha: string | null = null
  if (l && t) {
    const trackingIsNewer = await git(repoCwd, ['merge-base', '--is-ancestor', l, t]).then(() => true, () => false)
    ;[ref, sha] = trackingIsNewer ? [trackingName, t] : [branch, l]
  } else if (l) [ref, sha] = [branch, l]
  else if (t) [ref, sha] = [trackingName, t]
  if (!ref || !sha) {
    const head = await gitHeadSha(repoCwd)
    if (!head) return NO_COMMIT
    return { sha: head, ref: 'HEAD', note: `${why}, and there is no ${branch} here either, so the worktree forks from the checkout's HEAD at ${short(head)}, which may not be the trunk`, ...(remote ? { unfetched: true } : {}) }
  }
  const behindRemote = l && t && sha === l ? await commitCount(repoCwd, `refs/heads/${branch}..${tracking}`) : null
  const stale = behindRemote ? `. It is ${behindRemote} commit(s) behind the last ${remote}/${branch} fetched` : ''
  return { sha, ref, note: `${why}, so the worktree forks from the local ref ${ref} at ${short(sha)}, which may be behind the remote${stale}`, ...(remote ? { unfetched: true } : {}) }
}

/** The remote `branch` is fetched from: its own (`branch.<name>.remote`), else origin, else the only one; null when there is none */
export async function gitBranchRemote(repoCwd: string, branch: string, remotes?: string[]): Promise<string | null> {
  const all = remotes ?? (await git(repoCwd, ['remote']).catch(() => '')).split('\n').map((r) => r.trim()).filter(Boolean)
  const own = await configValue(repoCwd, `branch.${branch}.remote`)
  return all.includes(own) ? own : all.includes('origin') ? 'origin' : all.length === 1 ? (all[0] ?? null) : null
}

/**
 * Fetches `branch` from `remote` into its remote-tracking ref, bounded (`timeoutMs`), and gives the commit it is at; or
 * why not, in words for an answer. It runs the repository's network settings, so a caller fetches for a trusted
 * project only. A prompt no one can answer has nothing to wait on (`cloneEnv`), as for a clone.
 */
export async function gitFetchBranch(repoCwd: string, remote: string, branch: string, timeoutMs = FORK_FETCH_TIMEOUT_MS): Promise<{ sha: string } | { why: string }> {
  const tracking = `refs/remotes/${remote}/${branch}`
  // A remote that just failed is not asked again for a while (#1488): every start would otherwise wait out the bound
  const key = `${pathKey(repoCwd)}\n${remote}`
  const failed = failedFetches.get(key)
  if (failed && Date.now() - failed.at < FETCH_RETRY_AFTER_MS) return { why: failed.why }
  try {
    const own = (await configValue(repoCwd, 'core.sshCommand')) !== ''
    await runGit(repoCwd, ['fetch', '--no-tags', '--no-recurse-submodules', '--quiet', '--', remote, `+refs/heads/${branch}:${tracking}`], {
      allowRepoPrograms: true,
      timeout: timeoutMs,
      env: cloneEnv(process.env, own),
    })
    failedFetches.delete(key)
    const sha = await gitRevParse(repoCwd, tracking)
    return sha ? { sha } : { why: `${remote} has no branch ${branch}` }
  } catch (e) {
    const f = execFailure(e)
    const said = f.stderr?.trim() || f.message || 'git failed'
    const why = `Could not fetch ${remote} (${said.split('\n')[0]})`
    // Not when the remote answered that this branch is not there (a new branch): that says nothing of the next one (untranslated, `cloneEnv`)
    if (!/couldn't find remote ref/i.test(said)) failedFetches.set(key, { at: Date.now(), why })
    return { why }
  }
}

/** How long a repository's failed fetch is remembered, and the remote not asked again (#1488) */
export const FETCH_RETRY_AFTER_MS = 5 * 60_000
const failedFetches = new Map<string, { at: number; why: string }>()

/**
 * The tips `remote`'s copy of `branch` had here, newest first (its reflog, at most 200): a commit one of them holds was
 * pushed, also when a force-push replaced it since (#1662, a rebased pull request). None when there is no reflog.
 */
export async function gitRemoteTips(repoCwd: string, remote: string, branch: string): Promise<string[]> {
  const out = await git(repoCwd, ['log', '--walk-reflogs', '-n', '200', '--format=%H', `refs/remotes/${remote}/${branch}`]).catch(() => '')
  return out.split('\n').map((line) => line.trim()).filter(Boolean)
}

/**
 * Has this branch's work **entirely landed in the trunk** (#69)?
 *
 * The sum of two checks:
 *   1. Has the branch tip moved from its creation point (base)? If not, that is "no work done
 *      yet," not "merged." A freshly created branch is an ancestor of the trunk, so is-ancestor
 *      alone would read it as merged the instant it is created (base is recorded to avoid
 *      exactly this trap).
 *   2. Is the branch an ancestor of the trunk (`merge-base --is-ancestor`)? This catches an
 *      ordinary merge and a fast-forward merge.
 *
 * **The caller says what the trunk is** (#76). This used to always be the root's HEAD, which
 * was a baseline whose meaning silently changed the instant a person switched branches in the
 * root: a merge into main would go undetected if the root happened to be on a different branch,
 * and conversely, if the root's HEAD happened to contain the branch, a branch that was never
 * merged would read as merged. With the manager holding the trunk (worktreeManager.baseBranch),
 * the answer to this question is pinned to one value. With no trunk recorded, this falls back to
 * HEAD — the case for worktrees that existed before a manager did.
 *
 * **What this cannot catch (measured, 2026-08-29):** a squash merge cannot be detected locally —
 * is-ancestor says no, `branch --merged` says no, even `git cherry` reported it as unmerged.
 * A rebase merge is missed too, once the sha changes. Such a branch is left with no automatic
 * marker, and a person can always delete it by hand (the delete conversation) — the cost of
 * missing it is one badge, not data.
 */
export async function gitBranchMerged(
  projectCwd: string,
  branch: string,
  baseSha: string,
  trunk = 'HEAD',
): Promise<boolean> {
  try {
    const tip = (await git(projectCwd, ['rev-parse', '--verify', `refs/heads/${branch}`])).trim()
    if (!tip || tip === baseSha) return false
    await git(projectCwd, ['merge-base', '--is-ancestor', tip, trunk])
    return true
  } catch {
    return false // the branch does not exist, or is not an ancestor — either way this is not "merged"
  }
}

/**
 * Whether a name can be a branch (#69) — the judgment is left to git itself.
 *
 * If ref name rules (the lock suffix, consecutive dots, control characters, `@{`…) were
 * reimplemented here, they would go stale the moment git changed its own rules.
 * `check-ref-format --branch` is the source of truth for that judgment, and its exit code is
 * the answer. This command needs no repository, so cwd can be anywhere.
 */
export async function gitValidBranchName(name: string): Promise<boolean> {
  try {
    await git(process.cwd(), ['check-ref-format', '--branch', name])
    return true
  } catch {
    return false
  }
}

/** A path as a comparison key: real long name, forward slashes, no trailing slash, case-folded on Windows (git prints its own spelling) */
export function pathKey(path: string): string {
  const key = canonicalPath(path).replace(/\\/g, '/').replace(/\/+$/, '')
  return traitsFor().foldsPathCase ? key.toLowerCase() : key
}

/**
 * Removes a worktree for good, uncommitted changes and all: its folder, then git's entry for it. The caller has saved
 * the work in it or has the person's decision to lose it. A locked worktree stays unless `unlocked` (git's second
 * `--force`).
 *
 * **The host removes the folder, not git (#1655, #1560).** On Windows git deleted through a junction what the junction
 * led to (a pnpm-style link out of the worktree; one leading to the project took the project and its `.git`), and
 * stopped at a path past 260 characters once it had already dropped its entry and the worktree's `.git` file, leaving
 * a folder that nothing would clean (measured, git 2.47). `removeData` never follows a link and takes long paths. git
 * then drops its entry for the folder that is gone, named as git lists it (a Windows short name it does not match).
 *
 * Never a link (a symlink, a junction): git would take what it leads to, another worktree uncommitted work and all.
 * Never a folder that holds a checkout this repository lists (the project, another worktree). A folder git no longer
 * lists is what such a removal left part way only when it is a session's folder in `worktreeRoot`
 * (`<root>/<project>/<session>`, never a project's folder of them) and has no `.git` of its own; anything else
 * unlisted stays. A folder that cannot all be removed (a file held open) throws with what was left,
 * and git's entry stays so the removal can be tried again.
 */
export async function gitWorktreeRemove(
  repoCwd: string,
  path: string,
  { unlocked = false, worktreeRoot }: { unlocked?: boolean; worktreeRoot?: string } = {},
): Promise<void> {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${path} is a link, not a worktree; nothing was removed`)
  const key = pathKey(path)
  const list = await gitWorktreeList(repoCwd)
  const entry = list.find((w) => pathKey(w.path) === key)
  if (entry?.main) throw new Error(`${path} is the project's own folder, not a worktree`)
  if (entry?.locked && !unlocked) throw new Error(`${path} is a locked worktree; unlock it first`)
  const held = list.find((w) => w !== entry && pathKey(w.path).startsWith(`${key}/`))
  if (held) throw new Error(`${path} holds ${held.path}, which git lists as a checkout; nothing was removed`)
  const inRoot = worktreeRoot === undefined ? null : `${pathKey(worktreeRoot)}/`
  const leftover = inRoot !== null && key.startsWith(inRoot) && wireSegments(key.slice(inRoot.length)).length === 2
  if (!entry && (list.length === 0 || !leftover || existsSync(join(path, '.git')) || list.some((w) => key.startsWith(`${pathKey(w.path)}/`)))) {
    throw new Error(`${path} is not a worktree of ${repoCwd}`)
  }
  await removeData(path).catch((e: Error) => {
    throw new Error(`${path} was removed only in part, and what is left stays there: ${e.message}`)
  })
  if (entry) await git(repoCwd, ['worktree', 'remove', '--force', '--force', entry.path])
}

/**
 * How many commits `branch` holds that `trunk` does not (#715): what deleting the branch would lose. null when it
 * cannot be told (the branch or the trunk is not there), which a caller must read as "keep the branch".
 */
export async function gitBranchAhead(repoCwd: string, branch: string, trunk: string): Promise<number | null> {
  try {
    const n = Number((await git(repoCwd, ['rev-list', '--count', `${trunk}..refs/heads/${branch}`])).trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/**
 * How many commits of a worktree's own neither a remote nor the trunk has (#1161 item 3): what removing the worktree and
 * its branch would lose for good. Its own: those its checkout is on now (`head`, a commit id) and those of the branch
 * made for it, which the agent may have moved off. Read in the repository, against every remote-tracking ref as last
 * fetched or pushed: a branch pushed from here has its own. `pushed`: commits known to have been on a remote too
 * (`gitRemoteTips`). null when it cannot be told (a ref gone, git failing), which a caller must read as "keep it".
 */
export async function gitUnpublishedCommits(repoCwd: string, head: string, branch: string, trunk: string, pushed: string[] = []): Promise<number | null> {
  try {
    const n = Number((await git(repoCwd, ['rev-list', '--count', head, `refs/heads/${branch}`, '--not', trunk, '--remotes', ...pushed])).trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** Deletes a branch ref after the caller has preserved local work or obtained the person's discard decision. */
export async function gitBranchDelete(repoCwd: string, branch: string, trust: GitTrust = {}): Promise<void> {
  await git(repoCwd, ['branch', '-D', branch], trust)
}

/**
 * Whether uncommitted changes remain — used to ask whether removal is safe.
 *
 * This guards a forced removal, so work inside a submodule has to count. A trusted project's
 * status descends into submodules as plain git does. Before trust, status does not
 * (`--ignore-submodules=all`, `git-exec.ts`: a submodule's own config could name a filter that
 * was not turned off), so any submodule at all counts as a change: removal then asks first
 * rather than guessing. A worktree is only created in a trusted project, so this is the case of
 * trust taken away afterwards.
 */
export async function gitWorktreeDirty(
  path: string,
  trust: GitTrust = {},
  limits: SummaryLimits = {},
): Promise<{ dirty: boolean; changedFiles: number; more?: true; unknown?: true }> {
  const summary = await gitSummary(path, trust, limits)
  // Not known to be clean is not clean: removal asks first (#850 review). A folder the system denied is not known either
  if (summary.unknown || summary.denied) return { dirty: true, changedFiles: 0, unknown: true }
  let changedFiles = summary.changedFiles
  if (trust.trusted !== true && summary.isRepo) {
    // `ls-files --stage` reads the index only; mode 160000 is a submodule (a gitlink)
    const staged = await git(path, ['ls-files', '--stage', '-z']).catch(() => '')
    changedFiles += staged.split('\0').filter((line) => line.startsWith('160000 ')).length
  }
  return { dirty: changedFiles > 0, changedFiles, ...(summary.more ? { more: true as const } : {}) }
}

/** One worktree git lists (#715, #1655): detached ones have no branch; the first git lists is the project's own folder */
export type WorktreeEntry = { path: string; branch: string | null; main: boolean; locked: boolean }

/**
 * Every worktree git lists for this repository, detached ones too. Used to filter out one a person deleted from Finder
 * (git still lists it too — that state is what `prune` is for).
 */
export async function gitWorktreeList(repoCwd: string): Promise<WorktreeEntry[]> {
  if (!(await isRepo(repoCwd))) return []
  const out = await git(repoCwd, ['worktree', 'list', '--porcelain'])
  return out.split('\n\n').filter((block) => block.startsWith('worktree ')).map((block, i) => {
    const lines = block.split('\n').map((line) => line.trim())
    const branch = lines.find((line) => line.startsWith('branch refs/heads/'))
    return {
      path: (lines[0] ?? '').slice('worktree '.length),
      branch: branch ? branch.slice('branch refs/heads/'.length) : null,
      main: i === 0,
      locked: lines.some((line) => line === 'locked' || line.startsWith('locked ')),
    }
  })
}

/** Cleans up only the registration of a worktree that is gone (does not delete the directory) */
export async function gitWorktreePrune(repoCwd: string): Promise<void> {
  await git(repoCwd, ['worktree', 'prune'])
}
