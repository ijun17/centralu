// Local git, for rebase_stack: run with execFile (never a shell), with no prompts and plain English
// messages. The app server runs as the person (docs/security-boundaries.md, "App servers"), so this
// is their git, their credentials and their checkout; stack.mjs works in a temporary worktree so the
// checkout itself is never touched.
import { execFile } from 'node:child_process'

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
export function git(cwd, args, { input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 256 * 1024 * 1024,
        // Nobody is at a terminal: no prompts, no editor, and messages in English to read them
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', LC_ALL: 'C', LANG: 'C' },
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
 * moves. stack.mjs runs one restack at a time, so the names never collide.
 */
export async function fetchRefs(dir, remote, refs) {
  const names = refs.map((_, i) => `refs/centralu-restack/${i}`)
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
