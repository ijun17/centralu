// open_pr's mechanical checks (#1181): the repository's `pnpm pre-pr` (scripts/pre-pr.mjs), run on the
// pull request's commits before it opens. The board refuses with what it found; `skipPrePr` with a
// reason opens anyway and writes the reason into the description, where a reviewer reads it.
//
// The branches are fetched under refs of this app's own and removed again afterwards (as fetchRefs
// in git.mjs does): no branch or remote-tracking ref of the person's moves. The script itself works
// in temporary worktrees, so the checkout is not touched either.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { git, remoteFor, topLevel } from './git.mjs'

const SPACE = 'refs/centralu-pre-pr'
// Each call fetches under a name of its own: two open_pr calls run pre-pr side by side (outside the
// write line), and one's clean-up must not delete a ref the other is about to read
let calls = 0
// A stack of three builds three heads, then runs the changed tests twice: minutes, not seconds
const LIMIT_MS = 30 * 60_000
const BEAT_MS = 60_000

/** The last line of the script's stdout that is a JSON object: its answer. */
export function answerOf(stdout) {
  const lines = String(stdout ?? '').trim().split('\n').reverse()
  for (const line of lines) {
    try {
      const v = JSON.parse(line)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch {
      // progress or a stray line: the answer is the last JSON line
    }
  }
  return null
}

/**
 * Runs the repository's pre-PR script in the checkout at `dir` on `head` (with `lowers`, the branches
 * of the pull requests under it, oldest first). Answers { ran: false, why } when it cannot run here,
 * or { ran: true, ok, findings, notes, head } from the script. `beat` is called while it runs.
 */
export async function runPrePr({ dir, repo, head, base, main, lowers = [], script = 'scripts/pre-pr.mjs', beat = () => {} }) {
  const root = await topLevel(dir)
  const path = join(root, script)
  if (!existsSync(path)) return { ran: false, why: `the checkout at ${root} has no ${script}` }
  const remote = await remoteFor(root, repo)
  if (!remote) return { ran: false, why: `the checkout at ${root} has no remote for github.com/${repo}` }
  const branches = [...new Set([head, base, main, ...lowers])]
  const space = `${SPACE}/${process.pid}-${++calls}`
  const ref = (b) => `${space}/${b}`
  try {
    await git(root, ['fetch', '--no-tags', '--quiet', remote, ...branches.map((b) => `+refs/heads/${b}:${ref(b)}`)], { timeoutMs: 5 * 60_000 })
    const args = [path, '--json', '--no-fetch', '--remote', remote, '--head', ref(head), '--base', ref(base), '--main', ref(main), ...lowers.flatMap((b) => ['--stack', ref(b)])]
    const started = Date.now()
    const timer = setInterval(() => beat(Math.round((Date.now() - started) / 1000)), BEAT_MS)
    let result
    try {
      result = await new Promise((resolve) => {
        execFile(process.execPath, args, { cwd: root, timeout: LIMIT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
      })
    } finally {
      clearInterval(timer)
    }
    const a = answerOf(result.stdout)
    if (!a || a.error || !Array.isArray(a.findings)) {
      const why = a?.error ?? (result.error?.killed ? `it did not finish within ${LIMIT_MS / 60_000} minutes` : String(result.stderr ?? '').trim().split('\n').slice(-5).join(' ') || 'it gave no answer')
      return { ran: false, why: `${script} could not check: ${why}` }
    }
    return { ran: true, ok: a.ok === true && a.findings.length === 0, findings: a.findings, notes: a.notes ?? [], head: a.head ?? null, heads: a.heads ?? [] }
  } finally {
    // One after the other: each takes git's lock on the ref store (see fetchRefs)
    for (const b of branches) await git(root, ['update-ref', '-d', ref(b)]).catch(() => {})
  }
}
