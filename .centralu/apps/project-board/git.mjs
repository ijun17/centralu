// Local git, for rebase_stack and release: run with execFile (never a shell), with no prompts and
// plain English messages. The app server runs as the person (docs/security-boundaries.md, "App
// servers"), so this is their git, their credentials and their checkout; stack.mjs works in a
// temporary worktree and release.mjs only reads and pushes by id, so the checkout itself is never touched.
import { execFile } from './system.mjs'
import { resolve as resolvePath } from 'node:path'

export class GitError extends Error {
  constructor(message, stderr = '', code = null) {
    super(message)
    this.stderr = stderr
    this.code = code
  }
}

// What git prints when it could not reach the remote, or the remote did not answer: a failure of the moment, not of the
// change. Connection and name-lookup failures, a dropped transfer, a timeout, and a server that is away (5xx, 408, 429).
// Not what a retry does not mend: "unable to access ... returned error: 403/404", a certificate that does not verify,
// "Permission denied" or "Authentication failed" (and the "could not read from remote repository" that follows them).
// Those say the same thing the next time, and go to the author.
const UNREACHABLE = new RegExp(
  [
    'could not resolve host',
    'failed to connect',
    'connection (?:timed out|refused|reset)',
    'network is unreachable',
    'temporary failure in name resolution',
    'early eof',
    'hung up unexpectedly',
    'operation timed out',
    'ssl_error_syscall',
    'returned error: (?:408|429|5\\d\\d)\\b',
    'rpc failed; curl (?:18|28|52|55|56)\\b',
    'did not finish within',
  ].join('|'),
  'i',
)

/** Whether a git failure is the network's (or the remote's being away) rather than the change's: worth trying again, never a conflict */
export const isNetworkFailure = (e) => e instanceof GitError && UNREACHABLE.test(`${e.message}
${e.stderr}`)

const firstLine = (s) =>
  String(s ?? '')
    .split('\n')
    .map((l) => l.replace(/^(?:fatal|error):\s*/, '').trim())
    .find(Boolean) ?? ''

/** Runs git in `cwd`; answers stdout. `input` goes to stdin. */
export function git(cwd, args, { input, timeoutMs = 120_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 256 * 1024 * 1024,
        // Nobody is at a terminal: no prompts, no editor, and messages in English to read them
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', LC_ALL: 'C', LANG: 'C', ...env },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        if (error.code === 'ENOENT') return reject(new GitError('git was not found on this machine.'))
        if (error.killed) return reject(new GitError(`git ${args[0]} did not finish within ${Math.round(timeoutMs / 1000)} s.`))
        const verb = args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''
        reject(new GitError(`git ${verb} failed: ${firstLine(stderr) || firstLine(stdout) || `exit ${error.code}`}`, String(stderr ?? ''), error.code))
      },
    )
    if (input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

const out = async (cwd, args) => (await git(cwd, args)).trim()

/** The checkout's root, written the way this machine writes paths: git answers `C:/Users/me/x` on Windows */
export const topLevel = async (dir) => resolvePath(await out(dir, ['rev-parse', '--show-toplevel']))

/** The remote whose configured address is github.com's `repo`, or null. Read as written, before insteadOf. */
export async function remoteFor(dir, repo) {
  let text = ''
  try {
    text = await git(dir, ['config', '--get-regexp', '^remote\\..*\\.url$'])
  } catch {
    return null // no remotes at all: git exits 1
  }
  const [owner, name] = repo.toLowerCase().split('/')
  const re = new RegExp(`github\\.com[:/]+${owner.replace(/[.]/g, '\\.')}/${name.replace(/[.]/g, '\\.')}(?:\\.git)?/?$`, 'i')
  for (const line of text.split('\n')) {
    const m = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim())
    if (m && re.test(m[2])) return m[1]
  }
  return null
}

/**
 * Whether `remote` has `ref` (`refs/heads/docs/x`), from the exit code of `git ls-remote --exit-code`: 2 is nothing
 * matched, and a match is taken only when it is `ref` itself (ls-remote matches a pattern on the name's tail, so
 * `refs/heads/refs/heads/docs/x` would match too). Anything else (no network, the remote away, a timeout) throws its
 * GitError. The text of a failed fetch says "couldn't find remote ref" only when that is the first thing git prints: a
 * line before it (a warning, a trace) made a missing branch read as a failure of the moment (the integrator's `retry`,
 * main's CI on Windows, 2026-10-27).
 */
export async function remoteHas(dir, remote, ref) {
  let listed
  try {
    listed = await git(dir, ['ls-remote', '--exit-code', remote, ref])
  } catch (e) {
    if (e instanceof GitError && e.code === 2) return false
    throw e
  }
  return listed.split('\n').some((line) => line.trimEnd().endsWith(`\t${ref}`))
}

/**
 * Fetches refs of the remote by name and answers their commits, in order. They land under a name of
 * this app's own for a moment and are removed again: no branch or remote-tracking ref of the person's
 * moves. stack.mjs runs one restack at a time, so the names never collide; release.mjs names its own
 * `space` per call.
 */
export async function fetchRefs(dir, remote, refs, space = 'refs/centralu-restack') {
  const names = refs.map((_, i) => `${space}/${i}`)
  const specs = refs.map((r, i) => `+${r}:${names[i]}`)
  try {
    await git(dir, ['fetch', '--no-tags', '--quiet', remote, ...specs])
    return await Promise.all(names.map((n) => out(dir, ['rev-parse', '--verify', `${n}^{commit}`])))
  } finally {
    // One after the other: each takes git's lock on the ref store, and at once on Windows under load one of three missed it and stayed behind
    for (const n of names) await git(dir, ['update-ref', '-d', n]).catch(() => {})
  }
}

export async function isAncestor(dir, a, b) {
  try {
    await git(dir, ['merge-base', '--is-ancestor', a, b])
    return true
  } catch (e) {
    // Exit 1: not an ancestor. Anything else is an error (an unknown commit, 128). Not by what it printed: a warning
    // or a trace line comes with an exit 1 too
    if (e.code === 1) return false
    throw e
  }
}

export const treeOf = (dir, commit) => out(dir, ['rev-parse', `${commit}^{tree}`])
export const changedFiles = async (dir, a, b) => (await out(dir, ['diff', '--name-only', '--no-renames', a, b])).split('\n').filter(Boolean)
export const commitCount = async (dir, range) => Number(await out(dir, ['rev-list', '--count', range]))

/**
 * The patch id of the change from `a` to `b`: equal for two diffs that change the same lines the same
 * way, whatever their bases (`git patch-id --stable`). Empty for no change. Without context lines: a
 * line the base changed next to the pull request's own edit is the base's change, not a different
 * edit, and with context the two ids differed for a restack that replayed cleanly.
 */
export async function patchId(dir, a, b) {
  const diff = await git(dir, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '--full-index', '--unified=0', a, b])
  if (!diff.trim()) return ''
  return (await git(dir, ['patch-id', '--stable'], { input: diff })).trim().split(/\s+/)[0] ?? ''
}

// --- For release (release.mjs) ----------------------------------------------------------------------

/** The checkout's uncommitted changes and untracked files, one path each; empty when clean. */
export const changes = async (dir) =>
  (await git(dir, ['status', '--porcelain', '--untracked-files=normal']))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.slice(3))

/** The branch the checkout is on; empty when detached. */
export const head = (dir) => out(dir, ['rev-parse', 'HEAD'])

/** The remote's refs under `prefix` (`refs/tags/` or `refs/heads/`) as { name, sha }; an annotated tag's commit. */
export async function remoteRefs(dir, remote, prefix) {
  const text = await git(dir, ['ls-remote', '--quiet', remote, `${prefix}*`])
  const refs = new Map()
  for (const line of text.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (!sha || !ref?.startsWith(prefix)) continue
    const peeled = ref.endsWith('^{}')
    const name = ref.slice(prefix.length).replace(/\^\{\}$/, '')
    if (peeled || !refs.has(name)) refs.set(name, sha)
  }
  return [...refs].map(([name, sha]) => ({ name, sha }))
}

/**
 * A file of a commit as text; null when the commit has no such file. A `rev` that is not a commit or tree of the repository
 * (a name that does not exist, an option, a sha it lacks) is a caller's bug, not a missing file: it throws. One
 * `git cat-file --batch` answers "<spec> missing" with exit 0, so nothing is read from git's error text, whose first line is
 * not always the error; but it says "missing" too for an object the tree names and the repository cannot read (a blobless
 * clone with its remote away, a deleted object, a submodule), so a miss asks `rev-parse --verify` whether the tree names the
 * path: if it does, that is a failure and throws. `--batch` reads one name per line, so a path holding a newline (a POSIX file
 * name may) would be two requests and the first one's answer taken for it: those go by `rev-parse --verify` and `git show`,
 * whose arguments are not lines. Any other failure (the repository, a promisor remote away) is git's exit code and throws.
 */
export async function showFile(dir, rev, path) {
  const spec = `${rev}:${path}`
  if (rev.startsWith('-')) throw new GitError(`git cannot read ${spec}: ${rev} is not a revision`)
  // `rev-parse --verify --quiet`: exit 0 the object is named, exit 1 and no output it is not; 128 and others are git failing
  const named = async (name) => {
    try {
      await git(dir, ['rev-parse', '--verify', '--quiet', name])
      return true
    } catch (e) {
      if (e instanceof GitError && e.code === 1) return false
      throw e
    }
  }
  const absent = async () => {
    if (!(await named(`${rev}^{tree}`))) throw new GitError(`git cannot read ${spec}: ${rev} is not a commit of this repository`)
    return null
  }
  if (/[\r\n]/.test(path)) {
    if (!(await named(spec))) return absent()
    return git(dir, ['show', spec])
  }
  const answer = await git(dir, ['cat-file', '--batch'], { input: `${spec}\n` })
  const header = answer.slice(0, answer.indexOf('\n'))
  if (header.endsWith(' missing')) {
    if (await named(spec)) throw new GitError(`git cannot read ${spec}: the tree names it, but its object cannot be read`)
    return absent()
  }
  const found = /^[0-9a-f]{40,64} (\w+) \d+$/.exec(header)
  if (!found) throw new GitError(`git cat-file could not read ${spec}: ${header}`)
  // A folder or anything else that is not a file: as `git show` prints it
  if (found[1] !== 'blob') return git(dir, ['show', spec])
  return answer.slice(header.length + 1, -1)
}

/** Every file of a commit's tree. */
export const filesAt = async (dir, rev) => (await git(dir, ['ls-tree', '-r', '--name-only', '-z', rev])).split('\0').filter(Boolean)

/** The subjects of the first-parent commits after `from` up to `to`, newest first. */
export const subjects = async (dir, from, to) =>
  (await git(dir, ['log', '--first-parent', '--format=%s', from ? `${from}..${to}` : to])).split('\n').filter(Boolean)

/**
 * An annotated tag object for `commit`, named `name`, with `message`, written to the object store only: no tag ref is made
 * in the checkout (the release pushes it by id). The tagger is the person's git identity, as for their commits.
 */
export async function tagObject(dir, commit, name, message) {
  const tagger = await out(dir, ['var', 'GIT_COMMITTER_IDENT'])
  return (await git(dir, ['mktag'], { input: `object ${commit}\ntype commit\ntag ${name}\ntagger ${tagger}\n\n${message.replace(/\s+$/, '')}\n` })).trim()
}

/** Pushes a commit to a new ref of the remote. Never forced: git refuses a ref that exists and is not behind it. */
export const pushRef = (dir, remote, sha, ref) => git(dir, ['push', '--quiet', remote, `${sha}:${ref}`])
/** Deletes a branch on the remote (never a tag: the caller names a branch) */
export const deleteRemoteBranch = (dir, remote, branch) => git(dir, ['push', '--quiet', remote, `:refs/heads/${branch}`])
