import { execFailure } from './exec-error.js'
import { isGitCancelled, runGit } from './git-exec.js'
import { assertCanonicalGitPath, gitBranches, gitRevParse, gitStatusFiles, isRepo, literalPathspec, type GitTrust } from './git.js'

/** The git writes the person asks for from the git panel: switch, stage, commit, push. */

/**
 * A write the person asked for (stage, commit, switch, push): it runs as plain git does, hooks and
 * filters included, trusted or not. Turning a clean filter off here would change what gets
 * committed (an LFS pointer, a git-crypt file), which is worse than not committing at all.
 * docs/security-boundaries.md lists this as a limit.
 *
 * It gets a bound of its own (`WRITE_TIMEOUT_MS`), not a read's 10 s (#980): a write runs the repository's hooks (a
 * pre-commit type check, a pre-push test run) and the person's credential helper, which can wait on a sign-in.
 * Because that can be long, the person can end one sooner (`signal`, #1007): git is ended as a timeout ends it.
 */
export function gitWrite(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return runGit(cwd, args, { allowRepoPrograms: true, timeout: WRITE_TIMEOUT_MS, signal })
}

/** What a write answers when it did not go through: git's own words, or that the person cancelled it (#1007) */
export type GitWriteResult = { ok: boolean; message?: string; cancelled?: true }

/** How long a write the person asked for may take before git is stopped: the clone's bound (`CLONE_TIMEOUT_MS`) */
export const WRITE_TIMEOUT_MS = 10 * 60_000

/**
 * Checks out a branch. A dirty state does **not block** this — the result is shown first
 * (product philosophy: show, do not block). With dryRun, this only reports what would conflict.
 *
 * `switch` is used rather than `checkout` (#175). `checkout origin/release` detaches HEAD with
 * no error, so a "switched" toast was followed by commits piling up on no branch at all, and
 * `checkout <name>` turns into a command that discards a file's changes if no branch of that
 * name exists but a file of the same name does. `switch` only accepts a branch, and never
 * detaches HEAD without `--detach`. Choosing a remote branch creates a local branch tracking it
 * and switches to that (`--track`) — if a local branch of the same name already exists, git
 * refuses, and that raw message is passed straight through to the person. The
 * `--end-of-options` before the name keeps something like `-f` from being read as an option and
 * discarding changes.
 */
export async function gitCheckout(
  cwd: string,
  branch: string,
  opts: { dryRun?: boolean; signal?: AbortSignal } & GitTrust = {},
): Promise<GitWriteResult & { conflicts: string[] }> {
  if (!(await isRepo(cwd))) return { ok: false, conflicts: [], message: 'Not a git repository' }
  if (opts.dryRun) {
    const dirty = (await gitStatusFiles(cwd, opts)).filter((f) => f.status !== '?').map((f) => f.path)
    return { ok: dirty.length === 0, conflicts: [...new Set(dirty)] }
  }
  try {
    const local = await gitRevParse(cwd, `refs/heads/${branch}`)
    const remote = !local && (await gitRevParse(cwd, `refs/remotes/${branch}`))
    await gitWrite(cwd, ['switch', ...(remote ? ['--track'] : []), '--end-of-options', branch], opts.signal)
    return { ok: true, conflicts: [] }
  } catch (e) {
    return { ...failed(e), conflicts: [] }
  }
}

/** Rejects with `gitCancelled` (message "Cancelled") when `signal` ends it */
export async function gitStage(cwd: string, paths: string[], unstage = false, signal?: AbortSignal): Promise<void> {
  if (paths.length === 0) return
  const safePaths = await Promise.all(paths.map((path) => assertCanonicalGitPath(cwd, path)))
  const pathspecs = safePaths.map(literalPathspec)
  await gitWrite(cwd, unstage ? ['restore', '--staged', '--', ...pathspecs] : ['add', '--', ...pathspecs], signal)
}

export async function gitCommit(cwd: string, message: string, signal?: AbortSignal): Promise<GitWriteResult> {
  try {
    await gitWrite(cwd, ['commit', '-m', message], signal)
    return { ok: true }
  } catch (e) {
    return failed(e)
  }
}

/** Push (part of v1.5, finalized in product-spec §8 M2). Creates an upstream if there is none */
export async function gitPush(cwd: string, signal?: AbortSignal): Promise<GitWriteResult> {
  try {
    const branches = await gitBranches(cwd)
    const current = branches.find((b) => b.current)
    if (!current) return { ok: false, message: 'Current branch is unknown (detached HEAD)' }
    const args = current.upstream ? ['push'] : ['push', '--set-upstream', 'origin', current.name]
    await gitWrite(cwd, args, signal)
    return { ok: true }
  } catch (e) {
    return failed(e)
  }
}

/** A cancelled write says so, not what git printed before it was ended (that reads as a failure) */
function failed(e: unknown): GitWriteResult {
  return isGitCancelled(e) ? { ok: false, message: 'Cancelled', cancelled: true } : { ok: false, message: cleanGitError(e) }
}

/**
 * Shows git's raw error message as-is — summarizing it leaves the user unable to decide what to do next.
 *
 * Falls back to stdout when stderr is empty (#160). `git commit` writes its reason
 * ("nothing to commit") to stdout when there is nothing to commit — so the toast used to show
 * only `Command failed: git commit -m …`. This happens exactly when an agent has already
 * committed with Bash and the person then clicks Commit in the panel.
 */
function cleanGitError(e: unknown): string {
  const err = execFailure(e)
  const text = err.stderr?.trim() || err.stdout?.trim() || err.message || 'Unknown error'
  return text.trim().split('\n').slice(0, 6).join('\n')
}

/**
 * The writes still running, by project, so the person can end them (`git.cancel`, #1007). Each write gets its own
 * signal; cancelling a project ends every write running for it (two windows on one project each start their own).
 */
export class GitWriteRuns {
  private readonly running = new Map<string, Set<AbortController>>()

  async run<T>(key: string, write: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const set = this.running.get(key) ?? new Set<AbortController>()
    this.running.set(key, set)
    set.add(controller)
    try {
      return await write(controller.signal)
    } finally {
      set.delete(controller)
      if (set.size === 0 && this.running.get(key) === set) this.running.delete(key)
    }
  }

  /** Ends every write running for `key`; whether there was one */
  cancel(key: string): boolean {
    const set = this.running.get(key)
    if (!set || set.size === 0) return false
    for (const controller of set) controller.abort()
    return true
  }
}
