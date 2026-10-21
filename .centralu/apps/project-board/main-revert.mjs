// What the main guard does about a red main (#1259 step 1, main-guard.mjs finds the culprit): reverts it in
// a pull request queued at the front of the merge queue, through the fast tier like any change; tells the
// session that queued it; and files an issue with the failure. A release bump is never reverted. The
// decisions are pure here; `actOnRed` does what they say.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIssue, createPr, prsWithHead, readRepo } from './github.mjs'
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

/**
 * What kind of failure the guard found (#1435), in words a reader takes in at once: `infrastructure` (a step that sets the
 * job up, a timeout or a lost runner failed, so nothing of the commit ran) or `test` (a step of the job's own work
 * failed). Empty for a hunt recorded before the guard told them apart.
 */
export const kindText = (red) =>
  red?.kind === 'infrastructure' ? 'infrastructure failure' : red?.kind === 'setup' ? 'setup failure, after a rerun' : red?.kind === 'test' ? 'test failure' : ''

/** What failed, in one line: the jobs, the kind of failure and the first failing line */
export const failureLine = (red) => {
  const kind = kindText(red)
  return `${red.jobs?.length ? red.jobs.join(', ') : 'CI'} failed at ${short(red.red)}${kind ? ` (${kind})` : ''}${red.line ? `: ${red.line}` : ''}`
}

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
 * A commit on `base` with the changes of `shas` taken out (each one's reverse applied, newest first), made in a
 * temporary index from the checkout (its branches, index and work are not touched) and pushed to `branch` on GitHub's
 * remote: a revert on main's tip, or a bisect probe without the known culprits a commit carries. Answers `{ sha, base }`,
 * or `{ error }` when a reverse does not apply any more (later commits changed the same lines). A branch already there
 * (an earlier try that stopped half way) is used as it is: answered `{ sha, base, reused: true }`.
 */
export async function commitWithout({ dir, repo, base, shas, branch, message }) {
  const root = await topLevel(dir)
  const remote = await remoteFor(root, repo)
  if (!remote) return { error: `the checkout at ${root} has no remote for github.com/${repo}` }
  const there = (await git(root, ['ls-remote', remote, `refs/heads/${branch}`])).trim().split(/\s+/)[0]
  if (there) {
    await fetchRefs(root, remote, [`refs/heads/${branch}`], REF_SPACE)
    return { sha: there, base: (await git(root, ['rev-parse', `${there}^`])).trim(), reused: true }
  }
  const tmp = await mkdtemp(join(tmpdir(), 'centralu-revert-'))
  const env = { GIT_INDEX_FILE: join(tmp, 'index') }
  try {
    await git(root, ['read-tree', base], { env })
    for (const sha of [...shas].reverse()) {
      const patch = await git(root, ['diff', '--binary', '--no-renames', sha, `${sha}^`])
      try {
        await git(root, ['apply', '--cached', '--whitespace=nowarn'], { env, input: patch })
      } catch (e) {
        if (!(e instanceof GitError)) throw e
        return { error: `the reverse of ${short(sha)} does not apply to ${short(base)} (${e.message})` }
      }
    }
    const tree = (await git(root, ['write-tree'], { env })).trim()
    const commit = (await git(root, ['commit-tree', tree, '-p', base, '-F', '-'], { input: message })).trim()
    await git(root, ['push', '--quiet', remote, `${commit}:refs/heads/${branch}`])
    return { sha: commit, base }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/** A revert of `sha` on the default branch's tip, pushed to `branch` (`commitWithout`): `{ sha, tip }` or `{ error }` */
export async function revertCommit({ dir, repo, defaultBranch, sha, branch, message }) {
  const root = await topLevel(dir)
  const remote = await remoteFor(root, repo)
  if (!remote) return { error: `the checkout at ${root} has no remote for github.com/${repo}` }
  const [tip] = await fetchRefs(root, remote, [`refs/heads/${defaultBranch}`], REF_SPACE)
  const made = await commitWithout({ dir, repo, base: tip, shas: [sha], branch, message })
  if (made.error) return { error: made.error.replace(`to ${short(tip)}`, `to ${defaultBranch} at ${short(tip)}`) }
  return { sha: made.sha, tip: made.base, reused: made.reused === true }
}

/** The issue a red main files: title and body */
export function redIssue({ red, culprit, how, why, did, ref }) {
  const pr = culprit ? prOfSubject(culprit.subject) : null
  const infra = !culprit && red.kind === 'infrastructure'
  const title = infra
    ? `Main is red at ${short(red.red)}: an infrastructure failure, not reverted`
    : culprit ? `Main is red since ${pr ? `${ref(config.repository, pr)} ` : `${short(culprit.sha)} `}${culprit.subject.replace(PR_SUFFIX, '')}`.slice(0, 120) : `Main is red at ${short(red.red)}; the culprit was not found`
  const body = [
    `## What failed`,
    '',
    `The full tier on main failed at ${red.red}${red.url ? ` (${red.url})` : ''}: ${red.jobs?.length ? red.jobs.join(', ') : 'see the run'}.`,
    ...(kindText(red) ? ['', `Kind of failure: **${kindText(red)}**${red.kind === 'infrastructure' ? ' (the runner or its setup, not a commit)' : red.kind === 'setup' ? ` (a step that sets the job up failed on both attempts, and a commit since the last green one changed what it installs${red.touched?.length ? `: ${red.touched.join(', ')}` : ''})` : ' (a step of the job ran and failed)'}.${red.step ? ` The step that failed first: "${red.step}".` : ''}`] : []),
    ...(red.line ? ['', '```', red.line, '```'] : []),
    '',
    `## The culprit`,
    '',
    culprit ? `${culprit.sha} "${culprit.subject}": ${how}.` : infra ? `None: ${why}` : `Not found: ${why}`,
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
      // Idempotent: a revert pull request an earlier try opened from this branch is the one, not a failure
      const open = (await prsWithHead(repo, branch)).find((p) => p.state === 'OPEN')
      const opened = open ?? (await createPr(repo, { title: revertTitle(culprit.subject), head: branch, base: defaultBranch, body: revertBody({ red, culprit, how, name, defaultBranch, tip: made.tip }) }))
      revert = { pr: opened.number, branch, sha: made.sha }
      did = `Reverted it in ${ref(repo, opened.number)}, queued at the front of the merge queue; it lands after the fast tier.`
    }
  }
  // Idempotent: an issue an earlier try filed for this red (kept as `acting`, until the hunt records it) is the one
  let acting = null
  update((q) => (acting = q.guard?.acting?.red === red.red ? q.guard.acting : null))
  const issue = acting?.issue ? { number: acting.issue } : await createIssue(repo, redIssue({ red, culprit, how, why, did, ref }))
  update((q) => (q.guard = { ...(q.guard ?? {}), acting: { red: red.red, issue: issue.number } }))
  const at = new Date(now).toISOString()
  update((q) => {
    const item = culprit ? landedItem(q, culprit.sha, culprit.subject) : null
    // The revert goes in at the front, for the session that queued what it reverts (it hears when it lands)
    if (revert) {
      const owner = item?.owner ?? null
      const out = enqueue(q, { repo, pr: revert.pr, lowers: [], owner, author: item?.author ?? owner, notice: item?.notice ?? null, deleteBranch: true, title: revertTitle(culprit.subject), at }, ref)
      if (out.item) out.item.front = out.item.front ?? at
    }
    const text = culprit
      ? `Merge queue: main went red after ${name} (${culprit.subject}) landed: ${failureLine(red)}. Found as ${how}. ${did} ${ref(repo, issue.number)} has the failure; fix it on a new branch and queue it again.`
      : red.kind === 'infrastructure'
        ? `Merge queue: main went red at ${short(red.red)}, an infrastructure failure, not a commit's (${failureLine(red)}): ${why} ${ref(repo, issue.number)} has the failure.`
        : `Merge queue: main went red at ${short(red.red)} (${failureLine(red)}), and its culprit was not found: ${why} ${ref(repo, issue.number)} has the failure.`
    pushEvent(q, item ?? { repo, pr: pr ?? null, owner: null }, { kind: 'main-red', text, notify: true, at, data: { issue: issue.number, ...(revert ? { revert: revert.pr } : {}) } })
    if (q.guard) delete q.guard.acting
  })
  return { outcome: revert ? 'reverting' : 'reported', issue: issue.number, ...(revert ? { revert } : {}) }
}
