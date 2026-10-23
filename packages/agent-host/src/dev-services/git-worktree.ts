import { rpcError } from '../rpc-error.js'
import { execFailure } from './exec-error.js'
import { runGit } from './git-exec.js'
import { git, gitHeadSha, gitRevParse, gitSummary, isRepo, type GitTrust, type SummaryLimits } from './git.js'
import { cloneEnv } from './project-clone.js'
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

/** How long the fetch of a worktree's base may take before the worktree forks from what is here (#1484) */
export const FORK_FETCH_TIMEOUT_MS = 20_000

/** Where a new worktree forks from (#1484): the commit, the ref it was read from, and a note for the start answer, without a final period (the answer adds its own) */
export type ForkBase = { sha: string; ref: string; note: string }

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
    if (!sha) throw rpcError('This repository has no commit to fork a worktree from')
    return { sha, ref: 'HEAD', note: `No trunk is set for this project and none was found (no remote default branch, no main or master), so the worktree forks from the checkout's HEAD at ${short(sha)}, which may not be the trunk` }
  }
  if (!remote) {
    const own = await configValue(repoCwd, `branch.${branch}.remote`)
    remote = remotes.includes(own) ? own : remotes.includes('origin') ? 'origin' : remotes.length === 1 ? (remotes[0] ?? null) : null
  }
  const tracking = remote ? `refs/remotes/${remote}/${branch}` : null
  let why: string
  if (!remote || !tracking) {
    why = 'This repository has no remote to fetch from'
  } else if (opts.trusted !== true) {
    why = `Not fetched: the project is not trusted, and a fetch runs the repository's network settings`
  } else {
    try {
      const own = (await configValue(repoCwd, 'core.sshCommand')) !== ''
      await runGit(repoCwd, ['fetch', '--no-tags', '--no-recurse-submodules', '--quiet', '--', remote, `+refs/heads/${branch}:${tracking}`], {
        allowRepoPrograms: true,
        timeout: opts.timeoutMs ?? FORK_FETCH_TIMEOUT_MS,
        env: cloneEnv(process.env, own),
      })
      const sha = await gitRevParse(repoCwd, tracking)
      if (sha) {
        // Commits only the local trunk has: not on the remote, so not in the worktree
        const onlyLocal = (await local(branch)) ? await commitCount(repoCwd, `${tracking}..refs/heads/${branch}`) : null
        return {
          sha,
          ref: `${remote}/${branch}`,
          note: `Forked from ${remote}/${branch} at ${short(sha)}, fetched just now${onlyLocal ? `. The local ${branch} has ${onlyLocal} commit(s) the remote does not, which the worktree does not have` : ''}`,
        }
      }
      why = `${remote} has no branch ${branch}`
    } catch (e) {
      const f = execFailure(e)
      const said = f.stderr?.trim() || f.message || 'git failed'
      why = `Could not fetch ${remote} (${said.split('\n')[0]})`
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
    if (!head) throw rpcError('This repository has no commit to fork a worktree from')
    return { sha: head, ref: 'HEAD', note: `${why}, and there is no ${branch} here either, so the worktree forks from the checkout's HEAD at ${short(head)}, which may not be the trunk` }
  }
  const behindRemote = l && t && sha === l ? await commitCount(repoCwd, `refs/heads/${branch}..${tracking}`) : null
  const stale = behindRemote ? `. It is ${behindRemote} commit(s) behind the last ${remote}/${branch} fetched` : ''
  return { sha, ref, note: `${why}, so the worktree forks from the local ref ${ref} at ${short(sha)}, which may be behind the remote${stale}` }
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

/**
 * How many commits of a worktree's own neither a remote nor the trunk has (#1161 item 3): what removing the worktree and
 * its branch would lose for good. Its own: those its checkout is on now (`head`, a commit id) and those of the branch
 * made for it, which the agent may have moved off. Read in the repository, against every remote-tracking ref as last
 * fetched or pushed: a branch pushed from here has its own. null when it cannot be told (a ref gone, git failing),
 * which a caller must read as "keep it".
 */
export async function gitUnpublishedCommits(repoCwd: string, head: string, branch: string, trunk: string): Promise<number | null> {
  try {
    const n = Number((await git(repoCwd, ['rev-list', '--count', head, `refs/heads/${branch}`, '--not', trunk, '--remotes'])).trim())
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
