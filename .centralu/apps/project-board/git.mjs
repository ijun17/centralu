// Local git, for rebase_stack and release: run with execFile (never a shell), with no prompts and
// plain English messages. The app server runs as the person (docs/security-boundaries.md, "App
// servers"), so this is their git, their credentials and their checkout; stack.mjs works in a
// temporary worktree and release.mjs in a temporary index, so the checkout itself is never touched.
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export class GitError extends Error {
  constructor(message, stderr = '', code = null) {
    super(message)
    this.stderr = stderr
    this.code = code
  }
}

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

export const topLevel = (dir) => out(dir, ['rev-parse', '--show-toplevel'])

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
    await Promise.all(names.map((n) => git(dir, ['update-ref', '-d', n]).catch(() => {})))
  }
}

export async function isAncestor(dir, a, b) {
  try {
    await git(dir, ['merge-base', '--is-ancestor', a, b])
    return true
  } catch (e) {
    // Exit 1 with nothing said: not an ancestor. Anything else is an error (an unknown commit)
    if (e.code === 1 && !e.stderr.trim()) return false
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
export const currentBranch = (dir) => out(dir, ['branch', '--show-current'])
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

/** A file of a commit as text; null when the commit has no such file. */
export async function showFile(dir, rev, path) {
  try {
    return await git(dir, ['show', `${rev}:${path}`])
  } catch (e) {
    if (/does not exist|exists on disk, but not in/.test(e.message)) return null
    throw e
  }
}

/** Every file of a commit's tree. */
export const filesAt = async (dir, rev) => (await git(dir, ['ls-tree', '-r', '--name-only', '-z', rev])).split('\0').filter(Boolean)

/** The files of a commit that hold any of the fixed strings; empty when none does. */
export async function filesHolding(dir, rev, strings) {
  try {
    const text = await git(dir, ['grep', '-l', '-I', '-F', ...strings.flatMap((s) => ['-e', s]), rev, '--'])
    return text.split('\n').filter(Boolean).map((l) => l.slice(rev.length + 1))
  } catch (e) {
    if (e.code === 1 && !e.stderr.trim()) return [] // nothing found
    throw e
  }
}

/** The subjects of the first-parent commits after `from` up to `to`, newest first. */
export const subjects = async (dir, from, to) =>
  (await git(dir, ['log', '--first-parent', '--format=%s', from ? `${from}..${to}` : to])).split('\n').filter(Boolean)

/**
 * A commit on `parent` with `files` (path → text) changed and nothing else, made in a temporary index
 * so the checkout, its index and its branches never move. Answers the commit, which is on no branch
 * until pushed. The author is the person's own name and address from git config, as for any commit.
 */
export async function commitFiles(dir, parent, files, message) {
  const tmp = await mkdtemp(join(tmpdir(), 'centralu-release-'))
  const env = { GIT_INDEX_FILE: join(tmp, 'index') }
  try {
    await git(dir, ['read-tree', parent], { env })
    for (const [path, text] of Object.entries(files)) {
      const mode = (await out(dir, ['ls-tree', parent, '--', path])).split(/\s+/)[0] || '100644'
      const blob = (await git(dir, ['hash-object', '-w', '--no-filters', '--stdin'], { input: text })).trim()
      await git(dir, ['update-index', '--cacheinfo', `${mode},${blob},${path}`], { env })
    }
    const tree = (await git(dir, ['write-tree'], { env })).trim()
    return (await git(dir, ['commit-tree', tree, '-p', parent, '-F', '-'], { input: message })).trim()
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/** Pushes a commit to a new ref of the remote. Never forced: git refuses a ref that exists and is not behind it. */
export const pushRef = (dir, remote, sha, ref) => git(dir, ['push', '--quiet', remote, `${sha}:${ref}`])
