// What the ledger reads of GitHub, through the person's own `gh` (no token kept here, nothing asked of Centralu). It only
// reads: the ledger never writes labels, closes issues or sets a board's Status (docs/plans/task-ledger.md §2).
import { execFile } from 'node:child_process'

const TIMEOUT_MS = 60_000
/** Numbers read one by one when the list did not hold them, at most this many in a sweep */
const SINGLE_READS = 20
/** A decision is one `issue view` each: the rest wait for the next sweep */
const DECISION_READS = 10
const ISSUE_LIST = 300
const PR_LIST = 200

/** A reason a person reads: `gh` missing, not logged in, or what GitHub said in one line */
export class GhError extends Error {}

/** Runs `gh` with arguments (never a shell) in `cwd` and answers stdout */
export function ghRunner({ cwd } = {}) {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        'gh',
        args,
        {
          cwd,
          timeout: TIMEOUT_MS,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: '' },
        },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout)
          if (error.code === 'ENOENT') return reject(new GhError('The GitHub CLI (gh) is not installed on this machine.'))
          if (error.killed) return reject(new GhError('gh did not answer in time.'))
          const first = String(stderr || stdout || error.message).split('\n').find((l) => l.trim()) ?? 'no message'
          reject(new GhError(/auth|log ?in|credentials/i.test(first) ? 'gh is not logged in to GitHub (run `gh auth login`).' : `GitHub said: ${first.replace(/^gh:\s*/, '').slice(0, 200)}`))
        },
      )
    })
}

/**
 * A comment that records a decision: it starts "Decision (owner" and its author is the repository's owner or a login the
 * person listed (`github.deciders`, for an organisation's maintainers). Anyone can write that text on a public repository,
 * and what a decision unblocks may be acted on: so who wrote it decides, not the words. An issue being closed does not
 * decide anything either (its author can close it).
 */
export function isDecision(comment, deciders) {
  if (!String(comment?.body ?? '').trimStart().startsWith('Decision (owner')) return false
  if (comment?.authorAssociation === 'OWNER') return true
  const login = String(comment?.author?.login ?? '').toLowerCase()
  return login !== '' && deciders.some((d) => String(d).toLowerCase() === login)
}

const lower = (s) => String(s ?? '').toLowerCase()
const withRepo = (args, repo) => (repo ? [...args, '-R', repo] : args)

/**
 * Reads what the ledger needs: the state of the issues and pull requests it refers to, whether each decision has been
 * made, and (when asked) the open issues. At most `3 + decisions` calls in a sweep, plus the numbers a list missed.
 *
 * Answers `{ ok: true, facts, open }`, or `{ ok: false, error }` when the first call failed (nothing is retried in the
 * same sweep: a missing or logged-out `gh` would only fail again).
 */
export async function readFacts({ run, repo, issues, prs, decisions, wantOpen, deciders = [] }) {
  const facts = { issues: new Map(), prs: new Map(), decisions: new Map() }
  let open = []
  if (!issues.size && !prs.size && !decisions.size && !wantOpen) return { ok: true, facts, open }
  const json = async (args) => JSON.parse(await run(withRepo(args, repo)))
  try {
    if (issues.size || wantOpen) {
      const list = await json(['issue', 'list', '--state', 'all', '--limit', String(ISSUE_LIST), '--json', 'number,title,state'])
      for (const i of list) facts.issues.set(i.number, { title: String(i.title ?? ''), state: lower(i.state) })
      open = list.filter((i) => lower(i.state) === 'open').map((i) => ({ number: i.number, title: String(i.title ?? '') }))
    }
    if (prs.size) {
      for (const p of await json(['pr', 'list', '--state', 'all', '--limit', String(PR_LIST), '--json', 'number,state'])) facts.prs.set(p.number, { state: lower(p.state) })
    }
    let singles = SINGLE_READS
    for (const n of issues) {
      if (facts.issues.has(n) || singles-- <= 0) continue
      const i = await json(['issue', 'view', String(n), '--json', 'number,title,state'])
      facts.issues.set(n, { title: String(i.title ?? ''), state: lower(i.state) })
    }
    for (const n of prs) {
      if (facts.prs.has(n) || singles-- <= 0) continue
      const p = await json(['pr', 'view', String(n), '--json', 'number,state'])
      facts.prs.set(n, { state: lower(p.state) })
    }
    for (const n of [...decisions].slice(0, DECISION_READS)) {
      const d = await json(['issue', 'view', String(n), '--json', 'comments'])
      facts.decisions.set(n, (d.comments ?? []).some((c) => isDecision(c, deciders)))
    }
    return { ok: true, facts, open }
  } catch (e) {
    return { ok: false, error: e instanceof GhError ? e.message : `GitHub could not be read: ${String(e?.message ?? e).slice(0, 200)}` }
  }
}
