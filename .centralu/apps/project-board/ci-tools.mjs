// CI: ci_status, merge_when_green, mark_ready and read_failed_job.
import { centralu, z } from './runtime/centralu-app-runtime.mjs'
import { mergeWarning } from './batch.mjs'
import { readQueue, queueRef } from './queue-driver.mjs'
import { detailInput, itemOf, itemRef, REF_HELP, refOf, repoInput, repoOf } from './board.mjs'
import { canMerge, cleanLog, clip, decideMerge, evaluateChecks, failureLineIndex, firstFailure, matchKnownFailure, NO_PERMISSION, squashMessage, workflowCheckNames } from './ci.mjs'
import { CI, config } from './config.mjs'
import { deleteBranch, FATAL, GitHubError, markReady, mergePr, postComment, readChecks, readIssueText, readJobLog, readPr, readRepo, readRequired, readWorkflowChecks, resolveRef, sameRepo } from './github.mjs'
import { answering, serially } from './handlers.mjs'
import { answer, asError, linesAnswer, reason } from './reply.mjs'
import { publicTextProblems } from './rules.mjs'
import { forgetThread } from './threads.mjs'
import { privateWords } from './words-tools.mjs'
import { short, sleep, span } from './util.mjs'
import { now as clock } from './clock.mjs'

// --- CI: ci_status and merge_when_green -------------------------------------------------------------
// The decisions are pure functions in ci.mjs; this part reads GitHub, asks them, and says the answer
// in a few lines. The rule both tools keep (#386): green means every required check is reported and
// passed. No checks reported, or any still running, is not green.

const MAX_LOGS = 4
const KNOWN_TTL_MS = 5 * 60_000
let known = null

/** The issue listing known intermittent failures (project.json ci.knownFailuresIssue), kept 5 minutes. */
async function knownFailures() {
  if (known && clock() - known.at < KNOWN_TTL_MS) return known
  known = { at: clock(), ...(await readIssueText(config.repository, CI.knownFailures)) }
  return known
}

function rowState(r) {
  const c = r.check
  if (r.state === 'missing') return 'not reported yet'
  if (r.state === 'pending') return `pending (${c?.status ?? c?.state ?? 'waiting'})`
  if (r.state === 'failed') return c?.conclusion && c.conclusion !== 'failure' ? `failed (${c.conclusion})` : 'failed'
  return c?.conclusion && c.conclusion !== 'success' ? `passed (${c.conclusion})` : 'passed'
}

/**
 * For each failed check (required first, at most MAX_LOGS logs read): the first failing test line
 * of its job log, the error after it, and whether the known-failures issue quotes it. Whether it is
 * that flake stays the reader's call; the line says what matched.
 */
async function failureDetails(repo, checks) {
  const failed = [...checks.rows, ...checks.others].filter((r) => r.state === 'failed')
  const lines = []
  let issue = null
  let issueError = null
  for (const [i, r] of failed.entries()) {
    const job = r.check?.jobId ?? null
    const head = `${r.name}${checks.rows.includes(r) ? '' : ' (not required)'}${job ? ` (job ${job})` : ''}:`
    if (!job) {
      lines.push(`${head} not a GitHub Actions job, so no log${r.check?.url ? `; see ${r.check.url}` : ''}.`)
      continue
    }
    if (i >= MAX_LOGS) {
      lines.push(`${head} log not read (only the first ${MAX_LOGS} failures are).`)
      continue
    }
    let f
    try {
      f = firstFailure(await readJobLog(repo, job))
    } catch (e) {
      if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
      lines.push(`${head} ${reason(e)}`)
      continue
    }
    let tail = ''
    if (CI.knownFailures && sameRepo(repo, config.repository) && (f.line || f.error)) {
      if (!issue && !issueError) {
        try {
          issue = await knownFailures()
        } catch (e) {
          issueError = reason(e)
        }
      }
      const match = issue ? matchKnownFailure(f, issue.text) : null
      if (match) tail = ` | known intermittent failure? #${CI.knownFailures}${issue.state === 'CLOSED' ? ' (closed)' : ''} quotes "${match}"`
      else if (issueError) tail = ` | #${CI.knownFailures} could not be read: ${clip(issueError, 120)}`
    }
    lines.push(`${head} ${f.line ?? 'no failing test line found'}${f.error ? ` | ${f.error}` : ''}${tail}`)
  }
  return lines
}

/** The CI part of an answer: a summary, then one line per check that is not passed, then failures. */
export function ciLines(what, sha, req, checks, failures = [], detail = 'compact') {
  const c = checks.counts
  const parts = [`${c.passed}/${c.total} passed`, ...(c.failed ? [`${c.failed} failed`] : []), ...(c.pending ? [`${c.pending} pending`] : []), ...(c.missing ? [`${c.missing} not reported yet`] : [])]
  const summary = `${what} at ${short(sha)}: ${checks.verdict} — ${parts.join(', ')}.`
  const lines = checks.rows.filter((r) => r.state !== 'passed').map((r) => `${r.name}: ${rowState(r)}`)
  const passed = checks.rows.filter((r) => r.state === 'passed').map((r) => r.name)
  if (detail === 'full' && passed.length) lines.push(`Passed: ${passed.join(', ')}.`)
  if (detail === 'full' || req.added > 0) lines.push(`Required: ${req.source}.`)
  if (req.unresolved.length) lines.push(`Could not name the checks of ${req.unresolved.join(', ')}, so every reported check counts as required.`)
  if (detail === 'full' && checks.others.length) lines.push(`Not required: ${checks.others.map((r) => `${r.name} ${rowState(r)}`).join(', ')}.`)
  return { summary, checks: lines, failures }
}

/** An answer whose text is the summary, the check lines and the failures, as its structured part says. */
function ciAnswer(summary, ci, extra = {}, { isError = false } = {}) {
  const text = [summary, ...ci.checks, ...(ci.failures.length ? ['Failures:', ...ci.failures] : [])]
  const a = answer(text.join('\n'), { ...extra, checks: ci.checks, ...(ci.failures.length ? { failures: ci.failures } : {}) }, summary)
  return isError ? asError(a) : a
}

async function evaluate(repo, sha, req) {
  return evaluateChecks({ required: req.names, reported: await readChecks(repo, sha), alsoReported: req.unresolved.length > 0 })
}

async function ciStatus({ pr, ref, repo, detail = 'compact' }) {
  if ((pr === undefined) === (ref === undefined)) throw new GitHubError('input', 'Give pr (a pull request) or ref (a branch, tag or commit), one of them.')
  let what, sha, base, target
  if (pr !== undefined) {
    const want = itemOf(pr)
    target = want.repo
    const p = await readPr(target, want.number)
    what = `PR ${refOf(target, p.number)}${p.state === 'OPEN' ? '' : ` (${String(p.state).toLowerCase()})`}`
    sha = p.headRefOid
    base = p.baseRefName
  } else {
    target = repo ?? config.repository
    const [r, resolved] = await Promise.all([readRepo(target), resolveRef(target, ref)])
    what = `${sameRepo(target, config.repository) ? '' : `${target} `}${ref}`
    sha = resolved
    base = r.defaultBranch
  }
  const req = await readRequired(target, base, CI.workflows, workflowCheckNames, pr !== undefined ? sha : undefined)
  const checks = pr !== undefined ? await evaluate(target, sha, req) : evaluateChecks({
    required: req.names,
    reported: (await readWorkflowChecks(target, sha, { workflows: CI.workflows })).reported,
    alsoReported: req.unresolved.length > 0,
  })
  const ci = ciLines(what, sha, req, checks, await failureDetails(target, checks), detail)
  return ciAnswer(ci.summary, ci, { verdict: checks.verdict, head: sha })
}

/**
 * Tells the caller the call is alive. Centralu ends a call after 10 minutes without progress
 * (docs/apps.md §5), and a wait for CI runs up to 40; the message shows under the session's tool card.
 */
export function progress(ctx, n, message) {
  console.error(`[project-board] ${message}`)
  const token = ctx?.mcpReq?._meta?.progressToken
  if (token === undefined || typeof ctx?.mcpReq?.notify !== 'function') return
  void ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: n, message } }).catch(() => {})
}

// GitHub works out whether a PR can be merged when asked, within seconds: a few short retries first.
const MERGEABLE_RETRIES = 3
const MERGEABLE_WAIT_MS = 2_000

async function mergeWhenGreen({ pr, body, wait = false, waitMinutes, deleteBranch: del = false, intoBatch = false, detail = 'compact' }, ctx) {
  const want = itemOf(pr)
  const repo = want.repo
  const what = `PR ${want.ref}`
  // A merge outside the queue moves the default branch under a batch it is running (#1548): said in the answer. Read fresh
  // each time, since a batch may start or end while this waits; a queue file that does not read is no reason to refuse
  const queueNote = (p) => {
    try {
      return mergeWarning(readQueue(centralu.dataDir), { repo, pr: want.number, baseRefName: p.baseRefName, defaultBranch, ref: queueRef })
    } catch {
      return null
    }
  }
  const noted = (summary, p) => {
    const note = queueNote(p)
    return note ? `${summary}
${note}` : summary
  }
  const refused = (reason, ci, extra = {}) =>
    ci ? ciAnswer(`Not merged: ${reason}`, ci, { outcome: 'refused', merged: false, ...extra }, { isError: true }) : asError(answer(`Not merged: ${reason}`, { outcome: 'refused', merged: false, ...extra }))

  // Who is asking comes first: a contributor's agent gets no further (#386, merge policy).
  const { permissions, defaultBranch } = await readRepo(repo)
  if (!canMerge(permissions)) return refused(NO_PERMISSION.reason, null, { kind: 'permission' })

  let p = await readPr(repo, want.number)
  const firstHead = p.headRefOid
  const req = await readRequired(repo, p.baseRefName, CI.workflows, workflowCheckNames, p.headRefOid)
  const limitMs = Math.min(60, Math.max(0, Number(waitMinutes ?? CI.waitMinutes) || 0)) * 60_000
  const started = clock()
  const signal = ctx?.mcpReq?.signal
  let quick = 0
  let beat = 0
  for (;;) {
    const checks = await evaluate(repo, p.headRefOid, req)
    const d = decideMerge({ permissions, pr: p, checks, fullTier: CI.fullTier })
    if (d.action === 'refuse') {
      const ci = ciLines(what, p.headRefOid, req, checks, d.kind === 'failing' ? await failureDetails(repo, checks) : [], detail)
      return refused(d.reason, ci, { kind: d.kind, verdict: checks.verdict })
    }
    if (d.action === 'merge') {
      // Said before it happens, not after (the review of #1563): a merge here moves the default branch under a batch that
      // is running. Read now, at the moment of merging, since a batch may have started while this waited
      const note = queueNote(p)
      const ci = ciLines(what, p.headRefOid, req, checks, [], detail)
      if (note && !intoBatch)
        return ciAnswer(`Not merged: ${note} Call again with intoBatch: true to merge it anyway (a release bump goes through here).`, ci, { outcome: 'batch-running', merged: false, verdict: checks.verdict }, { isError: true })
      return doMerge(repo, what, p, body, del, ci, note)
    }
    // wait
    let pause = CI.pollMs
    if (d.kind === 'mergeable' && quick < MERGEABLE_RETRIES) {
      quick += 1
      pause = MERGEABLE_WAIT_MS
    } else if (!wait) {
      const ci = ciLines(what, p.headRefOid, req, checks, [], detail)
      return ciAnswer(noted(`Not merged yet: ${d.reason} Call again later, or with wait: true to wait for them.`, p), ci, { outcome: 'pending', merged: false, verdict: checks.verdict })
    } else if (clock() - started + pause > limitMs) {
      const ci = ciLines(what, p.headRefOid, req, checks, [], detail)
      return ciAnswer(noted(`Not merged: still not green after ${span(clock() - started)} of waiting (limit ${span(limitMs)}). ${d.reason}`, p), ci, {
        outcome: 'timeout',
        merged: false,
        verdict: checks.verdict,
      })
    } else {
      beat += 1
      progress(ctx, beat, `Waiting for ${what} (${span(clock() - started)} so far): ${d.reason}`)
    }
    if (!(await sleep(pause, signal))) return asError(answer('Not merged: cancelled while waiting.', { outcome: 'cancelled', merged: false }))
    p = await readPr(repo, want.number)
    if (p.headRefOid !== firstHead)
      return refused(`its head moved from ${short(firstHead)} to ${short(p.headRefOid)} while waiting, so the checks waited on are not the ones that count. Call again to wait on the new commit.`, null, { kind: 'moved' })
  }
}

async function doMerge(repo, what, p, body, del, ci, note = null) {
  const msg = squashMessage({ number: p.number, title: p.title, body, description: p.body })
  const why = await mergePr(repo, p.number, p.headRefOid, msg.subject, msg.body)
  if (why) return ciAnswer(`Not merged: GitHub refused the merge: ${why}`, ci, { outcome: 'refused', merged: false, kind: 'github' }, { isError: true })
  let commit = null
  try {
    commit = (await readPr(repo, p.number)).mergeCommit?.oid ?? null
  } catch {
    // merged either way; the commit id is a nicety
  }
  const extra = []
  if (del) {
    if (p.isCrossRepository) extra.push(`Branch ${p.headRefName} not deleted: it is in a fork.`)
    else {
      const e = await deleteBranch(repo, p.headRefName)
      extra.push(e ? `Branch ${p.headRefName} not deleted: ${e}` : `Deleted branch ${p.headRefName}.`)
    }
  }
  const summary = `Merged ${what} (squash) as ${short(commit)}: "${msg.subject}".${extra.length ? ` ${extra.join(' ')}` : ''}${note ? `
${note}` : ''}`
  return ciAnswer(summary, ci, { outcome: 'merged', merged: true, commit, subject: msg.subject })
}

/**
 * The end of a contributor's flow (#386, merge policy): merging is the maintainer's act, so a
 * contributor's agent marks the pull request ready for review instead, once nothing required has
 * failed, and the maintainer merges. With `note`, a comment for the maintainer (the public text
 * rules, checked before anything is written) ends with the CI line. Pending checks do not stop it:
 * they finish while it waits for review, and the answer says so.
 */
async function markReadyForReview({ pr, note, detail = 'compact' }) {
  const want = itemOf(pr)
  const repo = want.repo
  const what = `PR ${want.ref}`
  const text = note?.trim() ? note.trim() : null
  if (text) {
    const problems = publicTextProblems(text, await privateWords(), 'The note')
    if (problems.length) throw new GitHubError('input', problems.join(' '))
  }
  const p = await readPr(repo, want.number)
  if (p.state !== 'OPEN') return asError(answer(`Not marked ready: ${what} is ${String(p.state).toLowerCase()}, not open.`, { ready: false, kind: 'state' }))
  const req = await readRequired(repo, p.baseRefName, CI.workflows, workflowCheckNames, p.headRefOid)
  const checks = await evaluate(repo, p.headRefOid, req)
  if (checks.verdict === 'failing') {
    const ci = ciLines(what, p.headRefOid, req, checks, await failureDetails(repo, checks), detail)
    return ciAnswer(`Not marked ready: a required check failed. Fix it and push first (read_failed_job reads the job); a review goes to what can merge.`, ci, { ready: false, kind: 'failing', verdict: checks.verdict }, { isError: true })
  }
  const ci = ciLines(what, p.headRefOid, req, checks, [], detail)
  if (p.isDraft) await markReady(repo, p.number)
  let comment = null
  if (text) {
    try {
      comment = await postComment(repo, p.number, `${text}\n\n${ci.summary}`)
    } finally {
      forgetThread(repo, p.number)
    }
  }
  const state = p.isDraft ? `Marked ${what} ready for review` : `${what} was ready for review already`
  const later = checks.verdict === 'green' ? '' : ` CI is ${checks.verdict}, not green yet; it goes on meanwhile.`
  const summary = `${state}${comment ? ', and left the note' : ''}.${later} The maintainer merges it (merge_when_green or queue_merge).`
  return ciAnswer(summary, ci, { ready: true, marked: p.isDraft === true, verdict: checks.verdict, ...(comment ? { comment: comment.url } : {}) })
}

/** A failed Actions job's log around its first failure, so agents do not need to fetch a whole run. */
async function readFailedJob({ job, repo }) {
  const r = repoOf(repo)
  const log = await readJobLog(r, job)
  const lines = cleanLog(log).map((line) => line.replace(/[ \t]+/g, ' '))
  const at = failureLineIndex(lines)
  const start = Math.max(0, (at < 0 ? 0 : at) - 8)
  const excerpt = lines.slice(start, Math.min(lines.length, start + 40))
  const summary = `Job ${job}: ${at < 0 ? 'no failure marker found' : `failure near line ${at + 1}`}; ${excerpt.length} log lines shown.`
  return linesAnswer(summary, [['log', '', excerpt]], { job: Number(job), startLine: start + 1 })
}

export const tools = {
  read_failed_job: {
    config: {
      title: 'Read a failed Actions job log',
      description: 'Instead of gh run view --log-failed: read a short log excerpt around the first failure in a GitHub Actions job.',
      inputSchema: z.object({ job: z.number().int().positive().describe('GitHub Actions job id'), repo: repoInput }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: answering(readFailedJob),
  },

  ci_status: {
    config: {
      title: 'CI status of a pull request or commit',
      description:
        'Instead of gh pr checks / gh run list: the required checks of a pull request (pr) or a branch, tag or commit (ref), and whether every one is reported and passed. Verdict green, pending, failing, or none (no checks reported, which is not green). The required set comes from branch protection, else the CI workflow jobs on the base branch plus any job a pull request adds. For each failed job: the first failing test line of its log, the error after it, and whether the known intermittent failures issue quotes it.',
      inputSchema: z.object({
        pr: itemRef.optional().describe(`A pull request: ${REF_HELP}`),
        ref: z.string().optional().describe('Instead of pr: a branch, tag or commit sha'),
        repo: z.string().optional().describe('With ref: owner/name; default this project\'s repository'),
        detail: detailInput.describe('"full" lists passed and non-required checks too'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: answering(ciStatus),
  },

  mark_ready: {
    config: {
      title: 'Mark a pull request ready for review',
      description:
        "Instead of gh pr ready: the end of a contributor's flow, since merging is the maintainer's (merge_when_green and queue_merge refuse without maintain or admin). Marks a draft ready for review unless a required check failed (then it names the failure, like ci_status); pending checks do not stop it. With note, leaves a comment for the maintainer (English, no private word, no attribution line), ending with the CI line.",
      inputSchema: z.object({
        pr: itemRef.describe(`The pull request: ${REF_HELP}`),
        note: z.string().max(4000).optional().describe('A comment for the maintainer: what to look at, what was not exercised'),
        detail: detailInput.describe('"full" lists passed and non-required checks too'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: { 'centralu/risk': 'routine', ui: { visibility: ['model'] } },
    },
    handler: answering(serially(markReadyForReview), 'Not marked ready: '),
  },

  merge_when_green: {
    config: {
      title: 'Merge a pull request once CI is green',
      description:
        'Instead of gh pr merge: squash-merge one pull request (several, or a stack, unattended: queue_merge) only when the gh account has maintain or admin permission, the PR is open and not a draft, every required check is reported and passed (none reported, or any pending, is not green), and GitHub can merge it. Never auto-merge. Subject "Title (#N)"; body from `body` or the PR description\'s Why / What changed / Closes, without Co-Authored-By or "Generated with" lines; the PR author stays the author. Pending: answers at once, or with wait: true polls until green or failed (up to waitMinutes, default 40) and then merges or reports the failure like ci_status. When the merge queue has a batch running on the same branch, it merges nothing and says so first, because merging here moves main under the batch (it stops before it lands and is built again); queue_merge avoids that, and intoBatch: true merges anyway.',
      inputSchema: z.object({
        pr: itemRef.describe(`The pull request: ${REF_HELP}`),
        body: z.string().optional().describe('The squash commit body; default a summary of the PR description'),
        wait: z.boolean().optional().describe('Wait for pending checks instead of answering "pending" at once; default false'),
        waitMinutes: z.number().positive().max(60).optional().describe('With wait: how many minutes to wait at most; default 40'),
        deleteBranch: z.boolean().optional().describe('Delete the head branch on GitHub after the merge (never a fork\'s, never a local branch: a Centralu worktree may hold it); default false'),
        intoBatch: z.boolean().optional().describe('Merge although the merge queue has a batch running on the same branch, which this stops and builds again; default false: the call answers "Not merged" and says so first'),
        detail: detailInput.describe('"full" lists passed and non-required checks too'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: answering(mergeWhenGreen, 'Not merged: '),
  },
}
