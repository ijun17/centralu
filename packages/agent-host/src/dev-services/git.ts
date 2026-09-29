import { execFile } from 'node:child_process'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { assertExistingPath, isMissingPathError } from './path-guard.js'

const exec = promisify(execFile)

/**
 * Reads and operates on git (B-1).
 *
 * Document correction (G): an earlier comment called this "throwaway code, to be replaced by
 * Rust git2 at Tauri stage 4," but that plan was **put on hold** once the Node sidecar became
 * the production path at M1.5. The git2 migration will not happen until measurement confirms
 * it is a bottleneck (m2-plan decision 3). The port interface stays the same, so moving it
 * later leaves the UI untouched.
 */

/**
 * `denied`: it is a repository, but the OS blocked access (an unsigned app reading a protected
 * folder such as ~/Desktop). This has to be kept distinct from "not a repository" — what the
 * user needs to do is the opposite in each case (grant permission vs. nothing at all).
 * A situation actually run into, measured against the shipped `.app` (F-1).
 */
export type GitSummary = { isRepo: boolean; branch: string; changedFiles: number; denied?: boolean }
export type GitFileStatus = { path: string; staged: boolean; status: 'M' | 'A' | 'D' | 'R' | 'U' | '?' }
export type GitCommit = { sha: string; shortSha: string; subject: string; author: string; when: number; parents: string[] }
export type GitBranch = { name: string; current: boolean; remote: boolean; upstream?: string }

const OK = { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }

/**
 * Every call is given `core.quotePath=false` (#176). With the default (on), git wraps any path
 * containing a byte at or above 0x80 in quotes with octal escapes, like `"\355\225\234…"` — a
 * Korean file name came out that way in diff headers and `--name-only`, breaking the label on
 * screen and losing the path a click needed to follow it to the file. Turning it off leaves the
 * original name intact (only quotes, backslashes and control characters are still escaped).
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], { cwd, ...OK })
  return stdout
}

/** Every read function returns an empty result when this is not a git repository — so callers do not have to guard every time */
async function isRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

export async function gitSummary(cwd: string): Promise<GitSummary> {
  try {
    const stdout = await git(cwd, ['status', '--porcelain=v2', '--branch'])
    let branch = '(detached)'
    let changed = 0
    for (const line of stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim()
      else if (line && !line.startsWith('#')) changed++
    }
    return { isRepo: true, branch, changedFiles: changed }
  } catch (e) {
    const msg = String((e as { stderr?: string; message?: string }).stderr ?? (e as Error).message ?? '')
    // macOS TCC: an unsigned app reading a protected folder ends up here
    const denied = /Operation not permitted|EPERM|EACCES|permission denied/i.test(msg)
    return { isRepo: denied, branch: '', changedFiles: 0, denied }
  }
}

/** The list of changed files. Why porcelain v2 is used: it stays safe even when a name has spaces or non-ASCII characters */
export async function gitStatusFiles(cwd: string): Promise<GitFileStatus[]> {
  if (!(await isRepo(cwd))) return []
  const stdout = await git(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  const out: GitFileStatus[] = []

  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!
    if (!entry) continue
    if (entry.startsWith('1 ') || entry.startsWith('2 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>␀<origPath>
      const parts = entry.split(' ')
      const xy = parts[1] ?? '..'
      /*
       * A rename (2) has one extra field before the path (<X><score>, e.g. R100). Reading it at
       * the same position as a 1-line (8) turned the path into "R100 new-name" — a file that
       * does not exist — and staging failed silently. Under -z, the original name follows as
       * **the next NUL-separated token**, so that token is skipped rather than mistaken for a
       * new entry.
       */
      const rename = entry.startsWith('2 ')
      const path = parts.slice(rename ? 9 : 8).join(' ')
      if (rename) i++
      if (!path) continue
      const [x, y] = [xy[0] ?? '.', xy[1] ?? '.']
      if (x !== '.') out.push({ path, staged: true, status: mapStatus(x) })
      if (y !== '.') out.push({ path, staged: false, status: mapStatus(y) })
    } else if (entry.startsWith('? ')) {
      out.push({ path: entry.slice(2), staged: false, status: '?' })
    } else if (entry.startsWith('u ')) {
      const path = entry.split(' ').slice(10).join(' ')
      if (path) out.push({ path, staged: false, status: 'U' })
    }
  }
  return out
}

function mapStatus(c: string): GitFileStatus['status'] {
  if (c === 'A') return 'A'
  if (c === 'D') return 'D'
  if (c === 'R' || c === 'C') return 'R'
  if (c === 'U') return 'U'
  return 'M'
}

function assertLexicalGitPath(cwd: string, path: string): string {
  if (!path || path.includes('\0') || path.startsWith(':')) {
    throw Object.assign(new Error('Invalid git path'), { code: 'internal' })
  }
  const root = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, target)
  /*
   * The root itself is not outside (#134) — this still rejects it (what arrives here is
   * supposed to be a single file's path), but says why directly. This used to say the root was
   * "outside the project" too, and readers went looking for the cause in the wrong place.
   */
  if (rel === '') throw Object.assign(new Error('Path is the project root, not a file in it'), { code: 'internal' })
  if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel
  throw Object.assign(new Error('Path is outside the project'), { code: 'internal' })
}

async function assertCanonicalGitPath(cwd: string, path: string): Promise<string> {
  const rel = assertLexicalGitPath(cwd, path)
  try {
    await assertExistingPath(cwd, path)
  } catch (error) {
    if (isMissingPathError(error)) return rel
    throw error
  }
  return rel
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`
}

/**
 * The diff cap — in **characters**, not bytes (#134). Measured and sliced with `String.length`,
 * so this counts UTF-16 code units; mixing in Korean text or emoji makes the actual byte count
 * several times this value. The old name (`maxBytes`) made a promise the code did not keep.
 * Counting bytes would have shrunk the diff length a person actually saw, so the behavior was
 * left alone and the name was made to say what it does instead (the owner's decision).
 *
 * `gitDiff` and `gitCommitDetail` share this one value — hardcoding the number in two places
 * would let one of them drift. When e2e builds a fixture sized to this cap, it also imports this
 * constant rather than writing the number again.
 */
export const GIT_DIFF_MAX_CHARS = 400_000

/** A file's diff. A large diff is truncated to its start — the screen cuts it with virtual scrolling anyway */
export async function gitDiff(
  cwd: string,
  path: string,
  opts: { staged?: boolean; maxChars?: number } = {},
): Promise<{ diff: string; truncated: boolean; binary: boolean }> {
  if (!(await isRepo(cwd))) return { diff: '', truncated: false, binary: false }
  const safePath = await assertCanonicalGitPath(cwd, path)
  const args = ['diff', '--no-color', '--no-ext-diff']
  if (opts.staged) args.push('--cached')
  args.push('--', literalPathspec(safePath))

  let stdout: string
  try {
    stdout = await git(cwd, args)
  } catch {
    return { diff: '', truncated: false, binary: false }
  }
  // An untracked file has no diff — so its content is shown directly
  if (!stdout.trim() && !opts.staged) {
    try {
      stdout = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', safePath])
    } catch (e) {
      // --no-index exits 1 when there is a difference, so stdout rides along on the error
      stdout = String((e as { stdout?: string }).stdout ?? '')
    }
  }

  const binary = /^Binary files /m.test(stdout) || stdout.includes('\0')
  const max = opts.maxChars ?? GIT_DIFF_MAX_CHARS
  const truncated = stdout.length > max
  return { diff: binary ? '' : truncated ? stdout.slice(0, max) : stdout, truncated, binary }
}

export async function gitLog(cwd: string, limit = 50): Promise<GitCommit[]> {
  if (!(await isRepo(cwd))) return []
  const SEP = '\x1f'
  const stdout = await git(cwd, [
    'log',
    /*
     * The order is pinned so that **a child always comes before its parent.**
     *
     * The default sort is commit time, and a commit whose time got reversed by a rebase or
     * cherry-pick can have its parent appear before its child. The graph layout (core
     * git/graph.ts) cannot draw a line going upward for input shaped like that, so it drops the
     * edge — guaranteeing the order here means there is never an edge to drop in the first
     * place (this was the cause of the phantom lanes).
     */
    '--topo-order',
    `-n${limit}`,
    `--pretty=format:%H${SEP}%h${SEP}%s${SEP}%an${SEP}%at${SEP}%P`,
  ])
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', shortSha = '', subject = '', author = '', when = '0', parents = ''] = line.split(SEP)
      return { sha, shortSha, subject, author, when: Number(when) * 1000, parents: parents.split(' ').filter(Boolean) }
    })
}

/**
 * Commits that touched a path (M4 E-1) — a project app's history is git's, so this shows the recent commits for that
 * app's folder (`.centralu/apps/<id>`). The path is passed separately, after `--` (so it is not read as an option).
 * This does not follow a renamed folder back to its earlier commits (`--follow` only works on a single file).
 */
export async function gitLogPath(cwd: string, rel: string, limit = 20): Promise<{ repo: boolean; commits: GitCommit[] }> {
  if (!(await isRepo(cwd))) return { repo: false, commits: [] }
  const SEP = '\x1f'
  let stdout: string
  try {
    stdout = await git(cwd, ['log', '--topo-order', `-n${limit}`, `--pretty=format:%H${SEP}%h${SEP}%s${SEP}%an${SEP}%at${SEP}%P`, '--', assertLexicalGitPath(cwd, rel)])
  } catch {
    return { repo: true, commits: [] } // a repository with no commits at all
  }
  return {
    repo: true,
    commits: stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha = '', shortSha = '', subject = '', author = '', when = '0', parents = ''] = line.split(SEP)
        return { sha, shortSha, subject, author, when: Number(when) * 1000, parents: parents.split(' ').filter(Boolean) }
      }),
  }
}

/**
 * A single commit's files and diff. The `--end-of-options` before `sha` keeps a value starting with `-` from being
 * read as an option (#175).
 *
 * A merge commit shows its difference against the first parent (`--diff-merges=first-parent`, #160). The default,
 * a combined diff, is empty for a merge that had no conflicts, so every such merge showed up as `0 files` with an
 * empty diff. The difference against the first parent is exactly "what this merge brought into this branch."
 */
export async function gitCommitDetail(cwd: string, sha: string): Promise<{ files: string[]; diff: string; truncated: boolean }> {
  if (!(await isRepo(cwd))) return { files: [], diff: '', truncated: false }
  const show = ['show', '--diff-merges=first-parent', '--pretty=format:']
  const files = (await git(cwd, [...show, '--name-only', '--end-of-options', sha])).split('\n').filter(Boolean)
  const raw = await git(cwd, [...show, '--no-color', '--end-of-options', sha])
  const max = GIT_DIFF_MAX_CHARS
  return { files, diff: raw.slice(0, max), truncated: raw.length > max }
}

/** The current HEAD — a fallback for commit attribution (#50) when the tool's output was truncated and the hash could not be picked up */
export async function gitHeadSha(cwd: string): Promise<string | null> {
  if (!(await isRepo(cwd))) return null
  try {
    return (await git(cwd, ['rev-parse', 'HEAD'])).trim() || null
  } catch {
    return null // a repository with no commits at all — nothing to attribute either
  }
}

/**
 * The sha this ref points at — null if there is none (#76).
 *
 * Checks existence and reads the sha in one call. This is meant to keep the spot that asks
 * whether the trunk branch was deleted and the spot that records that branch's sha from asking
 * the same question twice.
 */
export async function gitRevParse(cwd: string, ref: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])).trim() || null
  } catch {
    return null
  }
}

/**
 * What git ignores — the list of files that will be **missing** from a new worktree (#76).
 *
 * These are exactly what a new worktree lacks (tracked files come along with git), so this list
 * is the entire set of candidates for "what should be copied." So the app does not choose for
 * itself; it only **points them out** — defaulting to "copy everything" here would drag along
 * node_modules's 637MB and the Rust target's 8.5GB, just from this one repository.
 *
 * `--directory` is the key part: a directory that is ignored wholesale is folded into one line
 * instead of expanded, so a directory like node_modules/ does not turn the list into noise the
 * size of its file count.
 *
 * Only .DS_Store is filtered out. Every macOS repository has dozens of them, there is never a
 * reason to copy one, and they always occupy the top of the list, pushing out the .env a person
 * actually needs to see.
 */
export async function gitIgnoredEntries(cwd: string, limit = 50): Promise<{ path: string; bytes: number | null }[]> {
  if (!(await isRepo(cwd))) return []
  let raw: string
  try {
    raw = await git(cwd, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
  } catch {
    return []
  }
  const paths = raw
    .split('\0')
    .filter(Boolean)
    .filter((p) => !p.endsWith('.DS_Store'))
  if (paths.length === 0) return []

  /*
   * The size is included, because the judgment a person actually makes from this list is
   * "this one is too big." One call to du asks for all of them, and if it takes too long the
   * list is returned without sizes (the size is only a nicety, and it would be backwards for
   * that to freeze the window).
   */
  const sizes = new Map<string, number>()
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile('du', ['-sk', ...paths.slice(0, limit)], { cwd, timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) =>
        // du exits non-zero if even one entry cannot be read — whatever it did print is used anyway
        stdout ? resolve(stdout) : reject(err),
      )
    })
    for (const line of out.split('\n')) {
      const [kb, ...rest] = line.split('\t')
      const p = rest.join('\t').trim()
      if (p && kb) sizes.set(p.replace(/\/$/, ''), Number(kb) * 1024)
    }
  } catch {
    // proceed without sizes
  }

  return paths
    .slice(0, limit)
    .map((p) => ({ path: p, bytes: sizes.get(p.replace(/\/$/, '')) ?? null }))
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
}

/**
 * The branch list. Whether a branch is remote is decided by the prefix of its **full ref name**
 * (#175).
 *
 * This used to take `%(refname:short)` and call it remote whenever the name had a `/`. But a
 * short name does not add `remotes/` to `origin/main`, and shortens `refs/remotes/origin/HEAD`
 * to plain `origin` — so remote branches got mixed into the local column, `origin` passed itself
 * off as a local branch, and a local branch like `feature/login` was sorted as remote. A full
 * name (`refs/heads/…`, `refs/remotes/…`) is never shortened, so its prefix is the answer.
 * A remote's `HEAD` is excluded because it is not a branch but an alias pointing at the default
 * branch. A line that is not a ref at all, like the detached HEAD line, is excluded too — taking
 * it for a branch would make a push try to create an upstream named "(HEAD detached at …)".
 */
export async function gitBranches(cwd: string): Promise<GitBranch[]> {
  if (!(await isRepo(cwd))) return []
  const stdout = await git(cwd, ['branch', '--all', '--format=%(refname)\x1f%(HEAD)\x1f%(upstream:short)'])
  const out: GitBranch[] = []
  for (const line of stdout.split('\n')) {
    const [ref = '', head = '', upstream = ''] = line.split('\x1f')
    const remote = ref.startsWith('refs/remotes/')
    if (!remote && !ref.startsWith('refs/heads/')) continue
    const name = ref.slice(remote ? 'refs/remotes/'.length : 'refs/heads/'.length)
    if (remote && name.endsWith('/HEAD')) continue
    out.push({ name, current: head.trim() === '*', remote, upstream: upstream || undefined })
  }
  return out
}

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
  opts: { dryRun?: boolean } = {},
): Promise<{ ok: boolean; conflicts: string[]; message?: string }> {
  if (!(await isRepo(cwd))) return { ok: false, conflicts: [], message: 'Not a git repository' }
  if (opts.dryRun) {
    const dirty = (await gitStatusFiles(cwd)).filter((f) => f.status !== '?').map((f) => f.path)
    return { ok: dirty.length === 0, conflicts: [...new Set(dirty)] }
  }
  try {
    const local = await gitRevParse(cwd, `refs/heads/${branch}`)
    const remote = !local && (await gitRevParse(cwd, `refs/remotes/${branch}`))
    await git(cwd, ['switch', ...(remote ? ['--track'] : []), '--end-of-options', branch])
    return { ok: true, conflicts: [] }
  } catch (e) {
    return { ok: false, conflicts: [], message: cleanGitError(e) }
  }
}

export async function gitStage(cwd: string, paths: string[], unstage = false): Promise<void> {
  if (paths.length === 0) return
  const safePaths = await Promise.all(paths.map((path) => assertCanonicalGitPath(cwd, path)))
  const pathspecs = safePaths.map(literalPathspec)
  await git(cwd, unstage ? ['restore', '--staged', '--', ...pathspecs] : ['add', '--', ...pathspecs])
}

export async function gitCommit(cwd: string, message: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await git(cwd, ['commit', '-m', message])
    return { ok: true }
  } catch (e) {
    return { ok: false, message: cleanGitError(e) }
  }
}

/** Push (part of v1.5, finalized in product-spec §8 M2). Creates an upstream if there is none */
export async function gitPush(cwd: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const branches = await gitBranches(cwd)
    const current = branches.find((b) => b.current)
    if (!current) return { ok: false, message: 'Current branch is unknown (detached HEAD)' }
    const args = current.upstream ? ['push'] : ['push', '--set-upstream', 'origin', current.name]
    await git(cwd, args)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: cleanGitError(e) }
  }
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
  const err = e as { stderr?: string; stdout?: string; message?: string }
  const text = err.stderr?.trim() || err.stdout?.trim() || err.message || 'Unknown error'
  return text.trim().split('\n').slice(0, 6).join('\n')
}

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
): Promise<Worktree> {
  await git(repoCwd, ['worktree', 'add', '-b', branch, path, ...(from ? [from] : [])])
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

export type BranchPr = {
  number: number
  state: 'open' | 'merged' | 'closed'
  url: string
  /**
   * The commit sha at the PR's head. This is what the hard gate (#76) bases its "up to date"
   * check on: the local tip has to match this before "all of the branch's work has landed in
   * that PR" is proven — a new commit stacked on after a squash merge is the one way to lose
   * work that neither is-ancestor nor the PR status can see.
   */
  headOid?: string
}

/**
 * This branch's pull request status — **asked of gh** (#76 stage 3).
 *
 * What PR status knows precisely is exactly what gitBranchMerged cannot see (squash and rebase
 * merges — the dominant outcome for a GitHub PR): MERGED is not an inference, it is a fact the
 * server recorded.
 *
 * This function fails quietly. Two branches of failure are returned as distinct:
 *   - `'unavailable'` — gh itself is missing (ENOENT). The answer will not change on asking
 *     again, so the caller is right to stop asking for the rest of this process.
 *   - `null` — unknown for now (no PR, offline, not a GitHub repository, not authenticated).
 *     Asking again later may get an answer.
 * Neither branch throws — this signal is the basis for one badge, not a precondition for the
 * session list.
 */
export async function gitBranchPr(projectCwd: string, branch: string): Promise<BranchPr | 'unavailable' | null> {
  try {
    const { stdout } = await exec('gh', ['pr', 'view', branch, '--json', 'number,state,url,headRefOid'], { cwd: projectCwd, ...OK })
    const j = JSON.parse(stdout) as { number?: unknown; state?: unknown; url?: unknown; headRefOid?: unknown }
    if (typeof j.number !== 'number' || typeof j.state !== 'string' || typeof j.url !== 'string') return null
    return {
      number: j.number,
      state: j.state === 'MERGED' ? 'merged' : j.state === 'CLOSED' ? 'closed' : 'open',
      url: j.url,
      ...(typeof j.headRefOid === 'string' && j.headRefOid ? { headOid: j.headRefOid } : {}),
    }
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : null
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
 * Checking with `gitWorktreeDirty` before removing is **the caller's job** — making that
 * judgment here would turn this into "silently deleted." This is a place that can hold hours of
 * an agent's work.
 */
export async function gitWorktreeRemove(repoCwd: string, path: string, force = false): Promise<void> {
  await git(repoCwd, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
}

/**
 * Deletes a branch ref (for the hard gate in #76 only).
 *
 * Why `-D`: `-d`'s own safety check (confirming a merge) cannot see a squash merge — the gate
 * exists precisely to cover that blind spot, so **the caller's proof** is the safety check here,
 * not git's. Code that has not passed the gate must not call this function.
 * Deleting still leaves the commit in the reflog — the caller logs the tip sha to leave a path
 * back to it.
 */
export async function gitBranchDelete(repoCwd: string, branch: string): Promise<void> {
  await git(repoCwd, ['branch', '-D', branch])
}

/** Whether uncommitted changes remain — used to ask whether removal is safe */
export async function gitWorktreeDirty(path: string): Promise<{ dirty: boolean; changedFiles: number }> {
  const summary = await gitSummary(path)
  return { dirty: summary.changedFiles > 0, changedFiles: summary.changedFiles }
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

/** Cleans up only the registration of a worktree that is gone (does not delete the directory) */
export async function gitWorktreePrune(repoCwd: string): Promise<void> {
  await git(repoCwd, ['worktree', 'prune'])
}
