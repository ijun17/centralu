// What the main guard does about a red main (#1259 step 1, main-guard.mjs finds the culprit): reverts it in
// a pull request queued at the front of the merge queue, through the fast tier like any change; tells the
// session that queued it; and files an issue with the failure. A release bump is never reverted. The
// decisions are pure here; `actOnRed` does what they say.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIssue, createPr, readRepo } from './github.mjs'
import { config } from './config.mjs'
import { fetchRefs, git, GitError, remoteFor, topLevel } from './git.mjs'
import { enqueue, pushEvent } from './queue.mjs'
import { short } from './util.mjs'

const REF_SPACE = 'refs/centralu-guard'
const PR_SUFFIX = /\s*\(#\d+\)\s*$/

/** The pull request a squash commit's subject names, `… (#N)`, or null */
export const prOfSubject = (subject) => {
  const m = /\(#(\d+)\)\s*$/.exec(String(subject ?? ''))
  return m ? Number(m[1]) : null
}

/** The queue's item that landed `sha`: by the commit it landed as, else by the pull request its subject names */
export function landedItem(q, sha, subject) {
  const byCommit = q.items.find((i) => i.state === 'merged' && i.commit === sha)
  if (byCommit) return byCommit
  const pr = prOfSubject(subject)
  if (pr === null) return null
  return [...q.items].reverse().find((i) => i.state === 'merged' && i.pr === pr && String(i.repo).toLowerCase() === String(config.repository).toLowerCase()) ?? null
}

/** What failed, in one line: the jobs and the first failing line */
export const failureLine = (red) => `${red.jobs?.length ? red.jobs.join(', ') : 'CI'} failed at ${short(red.red)}${red.line ? `: ${red.line}` : ''}`

/**
 * A release bump (#1259: never reverted): its squash's subject is the bump's title (`chore(release): …`), or it
 * changes the file the version is declared in (project.json release.source).
 */
export function isReleaseBump(commit) {
  if (/^chore\(release\):/.test(String(commit.subject ?? ''))) return true
  const source = config.release?.source?.path
  return !!source && (commit.files ?? []).includes(source)
}

/** The branch a revert is pushed to: one per culprit */
export const revertBranch = (sha) => `revert/${String(sha).slice(0, 12)}`

/** The revert's title: `revert: <the culprit's subject, without its pull request>`, short enough for a squash subject */
export function revertTitle(subject) {
  const title = `revert: ${String(subject ?? '').replace(PR_SUFFIX, '')}`
  return title.length <= 64 ? title : `${title.slice(0, 63).trimEnd()}…`
}

/**
 * A commit on the default branch's tip that undoes `sha`, made in a temporary index from the checkout (its branches,
 * index and work are not touched) and pushed to `branch` on GitHub's remote. Answers `{ sha, tip }`, or `{ error }`
 * when the reverse of its change does not apply to the tip any more (later commits changed the same lines).
 */
export async function revertCommit({ dir, repo, defaultBranch, sha, branch, message }) {
  const root = await topLevel(dir)
  const remote = await remoteFor(root, repo)
  if (!remote) return { error: `the checkout at ${root} has no remote for github.com/${repo}` }
  const [tip] = await fetchRefs(root, remote, [`refs/heads/${defaultBranch}`], REF_SPACE)
  const tmp = await mkdtemp(join(tmpdir(), 'centralu-revert-'))
  const env = { GIT_INDEX_FILE: join(tmp, 'index') }
  try {
    await git(root, ['read-tree', tip], { env })
    const patch = await git(root, ['diff', '--binary', '--no-renames', sha, `${sha}^`])
    try {
      await git(root, ['apply', '--cached', '--whitespace=nowarn'], { env, input: patch })
    } catch (e) {
      if (!(e instanceof GitError)) throw e
      return { error: `its reverse does not apply to ${defaultBranch} at ${short(tip)} (${e.message})` }
    }
    const tree = (await git(root, ['write-tree'], { env })).trim()
    const commit = (await git(root, ['commit-tree', tree, '-p', tip, '-F', '-'], { input: message })).trim()
    await git(root, ['push', '--quiet', remote, `${commit}:refs/heads/${branch}`])
    return { sha: commit, tip }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/** The issue a red main files: title and body */
export function redIssue({ red, culprit, how, why, did, ref }) {
  const pr = culprit ? prOfSubject(culprit.subject) : null
  const title = culprit ? `Main is red since ${pr ? `${ref(config.repository, pr)} ` : `${short(culprit.sha)} `}${culprit.subject.replace(PR_SUFFIX, '')}`.slice(0, 120) : `Main is red at ${short(red.red)}; the culprit was not found`
  const body = [
    `## What failed`,
    '',
    `The full tier on main failed at ${red.red}${red.url ? ` (${red.url})` : ''}: ${red.jobs?.length ? red.jobs.join(', ') : 'see the run'}.`,
    ...(red.line ? ['', '```', red.line, '```'] : []),
    '',
    `## The culprit`,
    '',
    culprit ? `${culprit.sha} "${culprit.subject}": ${how}.` : `Not found: ${why}`,
    ...(red.commits?.length ? ['', `Commits since main was last fully green (${short(red.green)}):`, ...red.commits.map((c) => `- ${short(c.sha)} ${c.subject}`)] : []),
    '',
    `## What the merge queue did`,
    '',
    did,
    '',
    "Filed by the merge queue's main guard (#1259): changes land after the fast tier, and the full tier runs on main after they land.",
  ].join('\n')
  return { title, body }
}

/** The revert pull request's description, in the repository's template headings */
function revertBody({ red, culprit, how, name, defaultBranch, tip }) {
  return [
    '## Why',
    '',
    `Main's full tier failed after ${name} landed: ${failureLine(red)}. Found as ${how}.`,
    '',
    '## What changed',
    '',
    `Reverts ${culprit.sha} ("${culprit.subject}") on ${defaultBranch} at ${short(tip)}. Made and queued by the merge queue's main guard (#1259); it lands after the fast tier, at the front of the queue.`,
    '',
    '## Not exercised',
    '',
    'Nothing beyond what CI runs: the revert is mechanical.',
  ].join('\n')
}

/**
 * Acts on a red main: `found` is the guard's (`{ red, culprit, how }`, or `{ red, culprit: null, why }`).
 * Reverts the culprit (unless it is a release bump, or the revert does not apply) in a pull request queued at the
 * front, files the issue, tells the culprit's session through its queue item (a message event: the session hears
 * it as a notice, or through its watch command), and answers what to record on the hunt; null when it no longer
 * holds the lease (another driver acts).
 */
export async function actOnRed(dir, found, { now = Date.now(), ref, update, renew = () => true }) {
  const { red, culprit, how, why } = found
  const repo = config.repository
  const pr = culprit ? prOfSubject(culprit.subject) : null
  const name = culprit ? (pr ? ref(repo, pr) : short(culprit.sha)) : null
  let revert = null
  let did
  if (!culprit) did = 'Reported it here; nothing was reverted.'
  else if (isReleaseBump(culprit)) did = `${name} is a release bump, which the queue never reverts: fix main with a change of its own.`
  else if (!dir) did = 'The queue has no checkout to make the revert in: revert it by hand.'
  else {
    if (!renew()) return null
    const { defaultBranch } = await readRepo(repo)
    const branch = revertBranch(culprit.sha)
    const message = `Revert "${culprit.subject}"\n\nThis reverts commit ${culprit.sha}: main's full tier failed on it (${failureLine(red)}). Made by the merge queue's main guard (#1259).\n`
    let made
    try {
      made = await revertCommit({ dir, repo, defaultBranch, sha: culprit.sha, branch, message })
    } catch (e) {
      if (!(e instanceof GitError)) throw e
      made = { error: e.message }
    }
    if (made.error) did = `The queue could not revert it: ${made.error}. Revert it by hand.`
    else {
      const opened = await createPr(repo, { title: revertTitle(culprit.subject), head: branch, base: defaultBranch, body: revertBody({ red, culprit, how, name, defaultBranch, tip: made.tip }) })
      revert = { pr: opened.number, branch, sha: made.sha }
      did = `Reverted it in ${ref(repo, opened.number)}, queued at the front of the merge queue; it lands after the fast tier.`
    }
  }
  const issue = await createIssue(repo, redIssue({ red, culprit, how, why, did, ref }))
  const at = new Date(now).toISOString()
  update((q) => {
    const item = culprit ? landedItem(q, culprit.sha, culprit.subject) : null
    // The revert goes in at the front, for the session that queued what it reverts (it hears when it lands)
    if (revert) {
      const owner = item?.owner ?? null
      const out = enqueue(q, { repo, pr: revert.pr, lowers: [], owner, author: item?.author ?? owner, notice: item?.notice ?? null, deleteBranch: true, title: revertTitle(culprit.subject), at }, ref)
      if (out.item) out.item.front = at
    }
    const text = culprit
      ? `Merge queue: main went red after ${name} (${culprit.subject}) landed: ${failureLine(red)}. Found as ${how}. ${did} ${ref(repo, issue.number)} has the failure; fix it on a new branch and queue it again.`
      : `Merge queue: main went red at ${short(red.red)} (${failureLine(red)}), and its culprit was not found: ${why} ${ref(repo, issue.number)} has the failure.`
    pushEvent(q, item ?? { repo, pr: pr ?? null, owner: null }, { kind: 'main-red', text, notify: true, at, data: { issue: issue.number, ...(revert ? { revert: revert.pr } : {}) } })
  })
  return { outcome: revert ? 'reverting' : 'reported', issue: issue.number, ...(revert ? { revert } : {}) }
}
