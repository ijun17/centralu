import { rpcError } from '../rpc-error.js'
import { git, gitSummary, isRepo, type GitTrust, type SummaryLimits } from './git.js'
import { gitWrite } from './git-write.js'


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
  await gitWrite(repoCwd, ['worktree', 'add', '-b', branch, path, ...(from ? [from] : [])])
  return { path, branch }
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

/**
 * Removes a worktree. `force` discards even uncommitted changes.
 *
 * The caller must preserve local work or obtain the person's discard decision before forcing
 * removal. `withSubmodules` also removes initialized submodules (git requires a second force).
 */
export async function gitWorktreeRemove(repoCwd: string, path: string, force = false, withSubmodules = false): Promise<void> {
  await git(repoCwd, ['worktree', 'remove', ...(force ? ['--force', ...(withSubmodules ? ['--force'] : [])] : []), path])
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

/**
 * The list of registered worktrees. Used to filter out one a person deleted from Finder
 * (git still lists it too — that state is what `prune` is for).
 */
export async function gitWorktreeList(repoCwd: string): Promise<Worktree[]> {
  if (!(await isRepo(repoCwd))) return []
  const out = await git(repoCwd, ['worktree', 'list', '--porcelain'])
  const list: Worktree[] = []
  let path = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
    else if (line.startsWith('branch ') && path) {
      list.push({ path, branch: line.slice('branch refs/heads/'.length).trim() })
      path = ''
    }
  }
  return list
}

/** Every path git lists as a worktree of this repository, detached ones too (#715). */
export async function gitWorktreePaths(repoCwd: string): Promise<string[]> {
  if (!(await isRepo(repoCwd))) return []
  const out = await git(repoCwd, ['worktree', 'list', '--porcelain'])
  return out.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length).trim())
}

/** Cleans up only the registration of a worktree that is gone (does not delete the directory) */
export async function gitWorktreePrune(repoCwd: string): Promise<void> {
  await git(repoCwd, ['worktree', 'prune'])
}
