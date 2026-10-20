import { execFailure } from './exec-error.js'
import { isAbsolute, relative, resolve } from 'node:path'
import { assertExistingPath, isInside, isMissingPathError } from './path-guard.js'
import type { GitBranch, GitCommit, GitFileStatus } from '@cc/protocol'
import { runGit, streamGit, type GitTrust } from './git-exec.js'
import { duSizes, walkedSizes } from './entry-sizes.js'
import { measuresWithDu } from '../os.js'
import { rpcError } from '../rpc-error.js'

/**
 * Reads and operates on git (B-1). This file holds the reads; the writes the person asks for are in git-write.ts,
 * worktrees and their branches in git-worktree.ts, a branch's pull request in git-pr.ts.
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
export type GitSummary = {
  isRepo: boolean
  branch: string
  changedFiles: number
  denied?: boolean
  /** More files changed than `changedFiles`, which stopped at the cap (`SUMMARY_CAP`) */
  more?: true
  /** git did not answer (a timeout, a crash): neither the count nor "clean" is known */
  unknown?: true
}
// The git panel's shapes are the protocol's (FR-4); a hand copy here had already lost `sessionName` (#428)
export type { GitBranch, GitCommit, GitFileStatus, GitTrust }

/** A read: the repository's programs run only for a trusted project */
export function git(cwd: string, args: string[], trust: GitTrust = {}): Promise<string> {
  return runGit(cwd, args, { allowRepoPrograms: trust.trusted === true })
}

/**
 * Every read function returns an empty result when this is not a git repository — so callers do not have to guard every
 * time. Only what says so is "not a repository", by the rule `gitSummary` reads: git's own words for it, or no git at
 * all. Any other failure (a repository git refuses to read, a timeout, a crash) is thrown, so the git panel says what
 * went wrong instead of showing an empty repository (#841 item 1).
 */
export async function isRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--git-dir'])
    return true
  } catch (e) {
    if (notARepository(e)) return false
    throw e
  }
}

/** What git says of a folder that is no repository (untranslated, `gitEnv`), and a machine with no git at all */
function notARepository(e: unknown): boolean {
  const err = execFailure(e)
  return /not a git repository/i.test(String(err.stderr || err.message || '')) || err.code === 'ENOENT'
}

/** The most changed files a summary counts; past it the count says "at least" (`more`) and git is stopped */
export const SUMMARY_CAP = 10_000

/** A summary's bounds, for tests: how many files to count before stopping, and how long git may take */
export type SummaryLimits = { cap?: number; timeoutMs?: number }

export async function gitSummary(cwd: string, trust: GitTrust = {}, limits: SummaryLimits = {}): Promise<GitSummary> {
  const cap = limits.cap ?? SUMMARY_CAP
  let branch = '(detached)'
  /** Distinct paths (#850 review): a file staged for removal and still on disk is `1 D.` and `? path`, one file */
  const paths = new Set<string>()
  let more = false
  /** A rename's entry is followed by its original path, which is not an entry of its own */
  let skipNext = false
  const take = (entry: string) => {
    if (skipNext) {
      skipNext = false
      return
    }
    if (entry.startsWith('# branch.head ')) branch = entry.slice('# branch.head '.length).trim()
    if (!entry || entry.startsWith('#')) return
    const kind = entry[0]
    // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path> · 2 … <X><score> <path>␀<orig> · u … <h3> <path> · ? <path>
    const fields = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : 1
    if (kind === '2') skipNext = true
    if (paths.size < cap) paths.add(entry.split(' ').slice(fields).join(' '))
    else if (!paths.has(entry.split(' ').slice(fields).join(' '))) more = true
  }
  try {
    /*
     * Untracked files one by one, as the panel lists them (`gitStatusFiles`): by default git names a new folder once,
     * and the sidebar said 1 where the panel listed its files (#850 item 10).
     *
     * Read as it arrives and stopped at the cap (#850 review): an un-ignored folder of 150,000 files made this answer
     * megabytes long, and a buffered read past its 32 MB said "not a repository".
     */
    await streamGit(
      cwd,
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
      (entry) => {
        take(entry.toString('utf8'))
        return more
      },
      { allowRepoPrograms: trust.trusted === true, timeout: limits.timeoutMs },
    )
    return { isRepo: true, branch, changedFiles: paths.size, ...(more ? { more: true as const } : {}) }
  } catch (e) {
    const err = execFailure(e)
    const msg = String(err.stderr || err.message || '')
    // macOS TCC: an unsigned app reading a protected folder ends up here
    if (/Operation not permitted|EPERM|EACCES|permission denied/i.test(msg)) return { isRepo: true, branch: '', changedFiles: 0, denied: true }
    // What git says of a folder that is no repository (in English: every git call runs untranslated, `gitEnv`, as Git for
    // Windows and WSL translate it otherwise), and a machine with no git at all
    if (notARepository(e)) return { isRepo: false, branch: '', changedFiles: 0 }
    /*
     * Anything else (git ran past its time on a slow disk, crashed, refused for another reason) says nothing about
     * whether this is a repository (#850 review). This summary is also the "is this a repository" check for new
     * worktrees and the "is this worktree clean" check before removing one: an unknown count must read as neither
     * "no repository" nor "clean".
     */
    return { isRepo: true, branch: '', changedFiles: 0, unknown: true }
  }
}

/** The list of changed files. Why porcelain v2 is used: it stays safe even when a name has spaces or non-ASCII characters */
export async function gitStatusFiles(cwd: string, trust: GitTrust = {}): Promise<GitFileStatus[]> {
  if (!(await isRepo(cwd))) return []
  const stdout = await git(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], trust)
  const out: GitFileStatus[] = []

  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] ?? ''
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
    throw rpcError('Invalid git path')
  }
  const root = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, target)
  /*
   * The root itself is not outside (#134) — this still rejects it (what arrives here is
   * supposed to be a single file's path), but says why directly. This used to say the root was
   * "outside the project" too, and readers went looking for the cause in the wrong place.
   */
  if (rel === '') throw rpcError('Path is the project root, not a file in it')
  if (isInside(root, target)) return rel
  throw rpcError('Path is outside the project')
}

export async function assertCanonicalGitPath(cwd: string, path: string): Promise<string> {
  const rel = assertLexicalGitPath(cwd, path)
  try {
    await assertExistingPath(cwd, path)
  } catch (error) {
    if (isMissingPathError(error)) return rel
    throw error
  }
  return rel
}

export function literalPathspec(path: string): string {
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
  opts: { staged?: boolean; maxChars?: number } & GitTrust = {},
): Promise<{ diff: string; truncated: boolean; binary: boolean }> {
  if (!(await isRepo(cwd))) return { diff: '', truncated: false, binary: false }
  const safePath = await assertCanonicalGitPath(cwd, path)
  const args = ['diff', '--no-color', '--no-ext-diff']
  if (opts.staged) args.push('--cached')
  args.push('--', literalPathspec(safePath))

  let stdout: string
  try {
    stdout = await git(cwd, args, opts)
  } catch {
    return { diff: '', truncated: false, binary: false }
  }
  // An untracked file has no diff — so its content is shown directly
  if (!stdout.trim() && !opts.staged) {
    try {
      stdout = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', safePath], opts)
    } catch (e) {
      // --no-index exits 1 when there is a difference, so stdout rides along on the error
      stdout = execFailure(e).stdout ?? ''
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
    // An empty `rel` is the whole repository: a root app's folder is its project (#1141)
    const path = rel === '' ? [] : ['--', assertLexicalGitPath(cwd, rel)]
    stdout = await git(cwd, ['log', '--topo-order', `-n${limit}`, `--pretty=format:%H${SEP}%h${SEP}%s${SEP}%an${SEP}%at${SEP}%P`, ...path])
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
export async function gitCommitDetail(
  cwd: string,
  sha: string,
  trust: GitTrust = {},
): Promise<{ files: string[]; diff: string; truncated: boolean }> {
  if (!(await isRepo(cwd))) return { files: [], diff: '', truncated: false }
  const show = ['show', '--diff-merges=first-parent', '--pretty=format:']
  const files = (await git(cwd, [...show, '--name-only', '--end-of-options', sha], trust)).split('\n').filter(Boolean)
  const raw = await git(cwd, [...show, '--no-color', '--end-of-options', sha], trust)
  const max = GIT_DIFF_MAX_CHARS
  return { files, diff: raw.slice(0, max), truncated: raw.length > max }
}

/** The current HEAD — a fallback for commit attribution (#50) when the tool's output was truncated and the hash could not be picked up */
/**
 * The `origin` remote's address as the repository's config has it (#1038), or null: not a repository, or no `origin`.
 * Only the config is read, so nothing of the repository runs, trusted or not.
 */
export async function gitOriginUrl(cwd: string, trust: GitTrust = {}): Promise<string | null> {
  try {
    return (await git(cwd, ['config', '--get', 'remote.origin.url'], trust)).trim() || null
  } catch {
    return null
  }
}

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
export async function gitIgnoredEntries(
  cwd: string,
  limit = 50,
  trust: GitTrust = {},
): Promise<{ path: string; bytes: number | null }[]> {
  if (!(await isRepo(cwd))) return []
  let raw: string
  try {
    raw = await git(cwd, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], trust)
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
   * "this one is too big." If measuring takes too long the list is returned without sizes (the
   * size is only a nicety, and it would be backwards for that to freeze the window).
   */
  const listed = paths.slice(0, limit)
  const sizes = measuresWithDu() ? await duSizes(cwd, listed) : await walkedSizes(cwd, listed)

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
