// The merge queue's driver (#956): the queue file in the app's data folder, the lease that lets one
// process drive at a time, and one poll per tick. The decisions are queue.mjs's; this reads GitHub
// for them and does what they say.
//
// Who drives: the board app's server while it runs, and the watch command (bin/merge-queue.mjs) a
// session runs in the background. Centralu stops an app with no open screen and no call for 5 minutes
// unless it says it is busy (docs/apps.md §4): the server holds busy while the queue has work
// (`queueBusy`, #1236), so the queue carries on overnight with nothing open. Both take the same lease (`merge-queue.lease.json`), so one of them polls at a
// time, and both read and write the same file, so the queue carries on in whichever is alive, and
// after either restarts.
//
// Gentle on GitHub: one item per tick (a few seconds), each item again only after its own wait
// (queue.mjs POLL_MS: 90 s while CI runs), the required checks read once per head, and a rate limit
// or an outage pauses the whole queue with a growing wait.
import { readFileSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { advanceClock, now as clock, systemNow } from './clock.mjs'
import { canMerge, evaluateChecks, firstFailure, squashMessage, workflowCheckNames } from './ci.mjs'
import { CI, config, QUEUE } from './config.mjs'
import {
  closePr,
  containsCommit,
  deleteBranch,
  dispatchWorkflow,
  FATAL,
  GitHubError,
  markDraft,
  markReady,
  mergePr,
  openPrsOnBase,
  prsWithHead,
  QUEUE_PR_FIELDS,
  readChecks,
  readJobLog,
  readPr,
  readRepo,
  readRequired,
  readWorkflowChecks,
  rerunRun,
  runJobSteps,
  jobNotes,
  sameRepo,
  setPrBase,
} from './github.mjs'
import {
  ACTIVE,
  attentionText,
  authorRoute,
  cannotMergeBase,
  decideBefore,
  decideCi,
  dueItem,
  emptyQueue,
  ERROR_LIMIT,
  errorReason,
  handoffReason,
  holdsApp,
  itemKey,
  lowerFailureCounts,
  normalize,
  noticeKey,
  onlySupersededFailures,
  POLL_MS,
  pushEvent,
  rerunRefused,
  resetFor,
} from './queue.mjs'
import { GitError, isNetworkFailure } from './git.mjs'
import { noteReadied, openedBy, readOpened } from './opened.mjs'
import { mergeMain, statLine } from './queue-conflict.mjs'
import { judgeHead, labelReason } from './queue-integrate.mjs'
import { classifyRun } from './run-failure.mjs'
import { rebaseStack, StackRefusal } from './stack.mjs'
import { activeBatch } from './batch.mjs'
import { batchTick, batchWork, formDue } from './queue-batch.mjs'
import { listSome, plural, short, span } from './util.mjs'
import { GUARD_MS, guardTick } from './main-guard.mjs'
import { actOnRed } from './main-revert.mjs'

export const QUEUE_FILE = 'merge-queue.json'
export const LEASE_FILE = 'merge-queue.lease.json'
/** A driver that stops renewing for this long (killed, asleep) hands the queue to the next one. */
export const LEASE_MS = 3 * 60_000
const PAUSE_MIN_MS = 60_000
const PAUSE_MAX_MS = 15 * 60_000
const PERMISSIONS_MS = 10 * 60_000
const BACKOFF_MAX_MS = 5 * 60_000

// PROJECT_BOARD_QUEUE_POLL_MS: for the tests only, which cannot wait 90 s between polls
const pollOverride = Number(process.env.PROJECT_BOARD_QUEUE_POLL_MS) || 0
export const pollMs = (kind) => pollOverride || POLL_MS[kind]
export const TICK_MS = Number(process.env.PROJECT_BOARD_QUEUE_TICK_MS) || 5_000
/**
 * PROJECT_BOARD_QUEUE_STEP=read: for the tests only. The server's driver ticks once at the start of each `merge_queue`
 * read, and never on a timer, so a test moves the queue one poll at a time and waits for nothing by the clock: what a
 * poll does is done when the read answers (docs/plans/os-layer.md §2.4).
 */
export const STEP_ON_READ = process.env.PROJECT_BOARD_QUEUE_STEP === 'read'
/** How much later each step is on the queue's clock (system.mjs `now`): every wait the tests shorten is due within a few */
const STEP_MS = Number(process.env.PROJECT_BOARD_QUEUE_STEP_MS) || 100
/** `#8` in this project's repository, `owner/repo#8` elsewhere (board.mjs's refOf, without the runtime). */
export const queueRef = (repo, n) => (sameRepo(repo, config.repository) ? `#${n}` : `${repo}#${n}`)

// --- The file ----------------------------------------------------------------------------------------

/** The queue as stored; a missing file is an empty queue. A file that does not read stops the driver. */
export function readQueue(dir) {
  let text
  try {
    text = readFileSync(join(dir, QUEUE_FILE), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return emptyQueue()
    throw e
  }
  try {
    return normalize(JSON.parse(text))
  } catch (e) {
    throw new GitHubError('internal', `The merge queue file ${join(dir, QUEUE_FILE)} is not valid JSON (${e.message}); fix or remove it.`)
  }
}

function writeAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  // Windows refuses a rename onto a file another process has open for a moment: try again shortly
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path)
      return
    } catch (e) {
      if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e
      const until = systemNow() + 25
      while (systemNow() < until) {
        // a short spin: the read-change-write below stays synchronous, so no other change interleaves
      }
    }
  }
}

/**
 * Reads the queue, lets `fn` change it, and writes it back, synchronously: inside one process nothing
 * runs in between, and between the two drivers the window is a file read and write. Answers what
 * `fn` answers.
 */
export function updateQueue(dir, fn) {
  mkdirSync(dir, { recursive: true })
  const q = readQueue(dir)
  const out = fn(q)
  writeAtomic(join(dir, QUEUE_FILE), q)
  return out
}

/**
 * What the server tells Centralu it is busy with (#1236), or null when the queue has no work of its own: an item
 * waiting or in CI, or a batch with its end still to do. An item needing attention is not: it waits on a session, and
 * one forgotten would keep the app running and polling for good. It is still polled while the app runs for any other
 * reason (a view, a call, other work), and queued again it is work again. The row reads "Running: merge queue, 2 items".
 */
export const WORKING = new Set(['waiting', 'ci'])
export function queueBusy(q, now = clock()) {
  // Also an item in attention `subject`, for SUBJECT_HOLD_MS (queue.mjs holdsApp): it waits on a title edit, which only a poll sees (#1593)
  const active = q.items.filter((i) => WORKING.has(i.state) || holdsApp(i, now)).length
  if (active) return `merge queue, ${plural(active, 'item')}`
  if (activeBatch(q)) return 'merge queue, a batch finishing'
  // The main guard (#1259): main's full run after a landing not judged yet, or a culprit being looked for
  if (q.guard?.hunt && !q.guard.hunt.outcome) return 'main guard, finding what broke main'
  return q.guard?.pending ? "main guard, waiting for main's full run" : null
}

/**
 * One step of the main guard (#1259, main-guard.mjs), at most once per its interval, by the driver holding the
 * lease: whichever driver runs, one guards. A step that fails is said once and waits the interval.
 */
export async function runGuard(dir, { holder, now = clock(), ref = queueRef, act = actOnRed } = {}) {
  if (!QUEUE.guard) return { did: 'off' }
  const q = readQueue(dir)
  // It watches what the queue landed: a queue that never landed anything has nothing on main to answer for
  if (!q.items.some((i) => i.state === 'merged') && !q.guard) return { did: 'off' }
  if (q.guard?.nextAt && Date.parse(q.guard.nextAt) > now) return { did: 'wait' }
  // The lease is between processes, on the system's clock (a stepped test moves only the queue's)
  if (!takeLease(dir, holder, systemNow())) return { did: 'busy' }
  try {
    return await guardTick({
      q,
      now,
      update: (fn) => updateQueue(dir, fn),
      renew: () => takeLease(dir, holder, systemNow()),
      act: (found) => act(QUEUE.conflicts.checkout, found, { now, ref, update: (fn) => updateQueue(dir, fn), renew: () => takeLease(dir, holder, systemNow()) }),
      failingLine,
    })
  } finally {
    const after = readQueue(dir)
    if (!after.items.some((i) => ACTIVE.has(i.state)) && !activeBatch(after)) releaseLease(dir, holder)
  }
}

// --- The lease ---------------------------------------------------------------------------------------

export function readLease(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, LEASE_FILE), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Whether the process that wrote a lease still runs (the data folder is this computer's, so its pid is
 * too). A driver killed before it could let go (SIGKILL after Centralu's grace) holds nothing.
 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // it runs, as another user
  }
}

/** Takes or renews the lease for `holder`. False when another driver, still running, holds a fresh one. */
export function takeLease(dir, holder, now = systemNow()) {
  const cur = readLease(dir)
  if (cur && cur.holder !== holder && Date.parse(cur.until) > now && alive(cur.pid)) return false
  mkdirSync(dir, { recursive: true })
  writeAtomic(join(dir, LEASE_FILE), { holder, pid: process.pid, until: new Date(now + LEASE_MS).toISOString() })
  // Two drivers that found it stale at once: the last write wins, and the other sees it here
  return readLease(dir)?.holder === holder
}

export function releaseLease(dir, holder) {
  if (readLease(dir)?.holder !== holder) return
  try {
    unlinkSync(join(dir, LEASE_FILE))
  } catch {
    // gone already
  }
}

// --- One poll ----------------------------------------------------------------------------------------

const permissionsSeen = new Map()
export async function permissionsOf(repo, now) {
  const hit = permissionsSeen.get(repo)
  if (hit && now - hit.at < PERMISSIONS_MS) return hit
  const r = await readRepo(repo)
  const v = { at: now, permissions: r.permissions, defaultBranch: r.defaultBranch }
  permissionsSeen.set(repo, v)
  return v
}

/**
 * The latest run of each CI workflow on the head, from readWorkflowChecks' runs: the pull_request run
 * of the PR's own branch first when a push run shares the commit, then the newest.
 */
export function latestRuns(runs, pr) {
  const by = new Map()
  const rank = (r) => [r.event === 'pull_request' && r.head_branch === pr.headRefName ? 1 : 0, String(r.created_at ?? ''), r.run_attempt ?? 1]
  const better = (a, b) => {
    const [x, y] = [rank(a), rank(b)]
    return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2]
  }
  for (const r of runs ?? []) {
    const key = r.workflow_id ?? r.path ?? r.name ?? 'ci'
    const cur = by.get(key)
    if (!cur || better(r, cur)) by.set(key, r)
  }
  return [...by.values()].map((r) => ({ id: r.id, attempt: r.run_attempt ?? 1, status: r.status, conclusion: r.conclusion ?? null, event: r.event ?? null, suite: r.check_suite_id ?? null, url: r.html_url ?? null, createdAt: r.created_at ?? null }))
}

const OK_RUN = new Set(['success', 'neutral', 'skipped'])

/**
 * Why each finished run of `runs` that did not pass failed (run-failure.mjs classifyRun), by run id:
 * its jobs and their steps, and the notes GitHub wrote on each job that did not pass (a timeout, a
 * lost runner). `known` holds what an earlier poll read, kept for a run until its attempt moves, so
 * an item waiting in attention does not read the same jobs every poll. Only once every run finished:
 * before that, nothing is rerun or decided.
 */
export async function runFailures(repo, runs, known = {}) {
  const out = {}
  if (!runs.length || runs.some((r) => r.status !== 'completed')) return out
  for (const run of runs.filter((r) => !OK_RUN.has(r.conclusion))) {
    const had = known?.[run.id]
    if (had && (had.attempt ?? 1) === (run.attempt ?? 1)) {
      out[run.id] = had
      continue
    }
    const jobs = await runJobSteps(repo, run.id)
    for (const j of jobs) j.notes = j.conclusion && !OK_RUN.has(j.conclusion) && j.id != null ? await jobNotes(repo, j.id) : []
    out[run.id] = classifyRun(run, jobs, { flaky: QUEUE.flakyJobs })
  }
  return out
}

/** The first failing test line of a failed job, for the attention message; best effort. */
export async function failingLine(repo, job) {
  if (!job?.id) return ''
  try {
    const f = firstFailure(await readJobLog(repo, job.id))
    const line = f.line ?? f.error
    return line ? ` First failure: ${line.length > 200 ? `${line.slice(0, 199)}…` : line}` : ''
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    return ''
  }
}

/**
 * Whether a pull request may share a batch (#962): not a fork's (the queue merges its head into a
 * branch of this repository and starts CI there, with this repository's secrets).
 */
export function batchable(pr) {
  if (pr.isCrossRepository) return false
  return true
}

/**
 * Lands an item that is green and mergeable: checks every open lower is inside the top's head (so
 * the green CI, read on that head, ran on all of them) and that no lower's own latest run on its head
 * failed after the top was proved (`provedAt`: when the run that proved it, its own or its batch's,
 * was created; `lowerFailureCounts`), then squash-merges the top on the head that was read. Answers
 * the outcome; `afterMerge` does the rest.
 *
 * Every red lower stopped the stack before (#1066): on 2026-10-18 that stopped #1040 and #1026 on an
 * old failure their tops' newer runs had outlived. But a lower failing after the top's green run is
 * evidence (#1072 under #1075, a runner-dependent bug the top failed on too), so that one still stops it.
 */
export async function land(item, pr, ref, renew, defaultBranch, { provedAt = null, beforeMerge = null } = {}) {
  const repo = item.repo
  const n = ref(repo, item.pr)
  // Handed over with integrate (#1259 step 3): judged once more right before the squash, against main as it is now
  // (its rules may have moved since the poll judged this head); `tierAt` keeps the judgment, so polls do not land it again
  if (item.auto) {
    const labelled = labelReason(n, pr.labels)
    if (labelled) return { state: 'attention', reason: labelled }
    const t = await judgeHead({ dir: QUEUE.conflicts.checkout, repo, n, pr, defaultBranch })
    if (t.tier !== 'auto') return { state: 'attention', reason: t.reason, tierAt: t }
  }
  for (const l of item.lowers ?? []) {
    const lp = await readPr(repo, l)
    if (lp.state !== 'OPEN') continue
    if (!(await containsCommit(repo, lp.headRefOid, pr.headRefOid)))
      return {
        state: 'attention',
        reason: {
          kind: 'stack',
          text: `${n} does not contain the head ${short(lp.headRefOid)} of ${ref(repo, l)}, which would be closed as landed. Restack ${n} onto it and push, or queue ${n} again without ${ref(repo, l)}.`,
        },
      }
    // Cheap: the runs' conclusions and times only. Cancelled, older than the top's proof, or no run at all is fine
    const own = latestRuns((await readWorkflowChecks(repo, lp.headRefOid, { workflows: CI.workflows })).runs, lp)
    const red = own.find((r) => lowerFailureCounts(r, provedAt))
    if (red)
      return {
        state: 'attention',
        reason: {
          kind: 'lower-failed',
          text: `${ref(repo, l)}, under ${n}, has a CI run ${red.id} on its head ${short(lp.headRefOid)} that failed after the run that proved ${n}${provedAt ? ` (started ${provedAt.slice(0, 16).replace('T', ' ')} UTC)` : ''}: a failure the top's run may have missed (a flaky or runner-dependent test). Fix ${ref(repo, l)} (or rerun it if it was a flake) and restack ${n}, or queue ${n} again without it.`,
        },
      }
  }
  if (!renew()) return { yielded: true }
  // What the caller does once every check here passed (a batch's status on the head), right before the merge
  await beforeMerge?.()
  const msg = squashMessage({ number: pr.number, title: pr.title, description: pr.body })
  // An integrated record is a draft until this moment (#1259 step 3): readied and squashed in one step by the lease
  // holder, and a draft again when the squash does not happen, so no other path lands it unjudged
  const record = item.auto && pr.isDraft
  const redraft = () => (record ? markDraft(repo, pr.number).catch((e) => console.error(`[project-board] merge queue: ${n} could not be turned back into a draft: ${e?.message ?? e}`)) : null)
  if (!record) return squash(item, pr, n, msg, defaultBranch)
  // Whatever happens between readying and the squash (GitHub refusing it, a rate limit, no network), it is a draft again
  let out
  try {
    await markReady(repo, pr.number)
    out = await squash(item, pr, n, msg, defaultBranch)
  } catch (e) {
    await redraft()
    throw e
  }
  if (out.state !== 'merged') {
    await redraft()
    // Turned back into a draft, a squash GitHub held (its own merge queue, auto-merge) is not coming
    if (out.reason?.kind === 'not-merged')
      out.reason = { kind: 'not-merged', text: `gh pr merge answered for ${n} at ${short(pr.headRefOid)}, but GitHub does not show it merged (a merge queue or auto-merge on GitHub may hold it). Handed over with integrate, it was turned back into a draft, which also stops what GitHub held: integrate it again once that is sorted out.` }
  }
  return out
}

/** The squash itself, on the head that was read, and GitHub's word that it merged. */
async function squash(item, pr, n, msg, defaultBranch) {
  const repo = item.repo
  const why = await mergePr(repo, pr.number, pr.headRefOid, msg.subject, msg.body)
  if (why) return { state: 'attention', reason: { kind: 'refused', text: `GitHub refused to merge ${n} at ${short(pr.headRefOid)}: ${why}. Look at the PR; the queue tries again on a new head.` } }
  // gh can exit 0 without a merge (GitHub's own merge queue, auto-merge): only GitHub's word counts
  let merged = null
  try {
    merged = await readPr(repo, pr.number)
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
  }
  if (merged?.state !== 'MERGED')
    return {
      state: 'attention',
      reason: {
        kind: 'not-merged',
        text: `gh pr merge answered for ${n} at ${short(pr.headRefOid)}, but GitHub does not show it merged (a merge queue or auto-merge on GitHub may hold it). The queue does not ask again on this head, and lands the stack once GitHub shows it merged.`,
      },
    }
  return { state: 'merged', merged, subject: msg.subject, landed: merged.baseRefName === defaultBranch }
}

/**
 * After the top merged (here, or found merged: a driver stopped between the merge and writing it
 * down, or someone merged it by hand): deletes its branch, closes the open lowers its head contains
 * with "Landed in #N" and deletes their branches, unless another open pull request is based on one.
 * A lower the top does not contain stays open and is named. Answers the message for the session.
 */
export async function afterMerge(item, pr, ref, subject, { landed, defaultBranch }) {
  const repo = item.repo
  const n = ref(repo, item.pr)
  const commit = pr.mergeCommit?.oid ?? null
  const title = item.title ? ` (${item.title})` : ''
  if (!landed) {
    // Merged into another branch (a lower's, by hand): the stack has not landed, so nothing is closed
    const open = (item.lowers ?? []).map((l) => ref(repo, l))
    return `Merge queue: ${n}${title} was merged into ${pr.baseRefName}, not ${defaultBranch}, so the stack has not landed: the queue ${open.length ? `left ${open.join(', ')} open and ` : ''}deleted no branch. It is off the queue.`
  }
  const notes = []
  const stack = new Set([item.pr, ...(item.lowers ?? [])])
  const gone = (e) => !e || /Reference does not exist|HTTP 422|Not Found/i.test(e)
  /** Deletes a head branch unless it is a fork's or another open pull request is based on it (deleting it would close that one). */
  const dropBranch = async (p) => {
    if (p.isCrossRepository) return notes.push(`kept ${p.headRefName} (a fork's)`)
    const on = (await openPrsOnBase(repo, p.headRefName)).filter((k) => !stack.has(k))
    if (on.length) return notes.push(`kept ${p.headRefName}: ${on.map((k) => ref(repo, k)).join(', ')} ${on.length === 1 ? 'is' : 'are'} based on it`)
    const e = await deleteBranch(repo, p.headRefName)
    if (!gone(e)) notes.push(`could not delete ${p.headRefName}: ${e}`)
  }
  if (item.deleteBranch !== false) await dropBranch(pr)
  const closed = []
  const lowers = []
  for (const l of item.lowers ?? []) {
    const lp = await readPr(repo, l)
    if (lp.state !== 'OPEN') continue
    if (!(await containsCommit(repo, lp.headRefOid, pr.headRefOid))) {
      notes.push(`left ${ref(repo, l)} open: ${n} does not contain its head ${short(lp.headRefOid)}`)
      continue
    }
    const e = await closePr(repo, l, `Landed in #${pr.number}, which merged this stack as one commit.`)
    if (e) notes.push(`could not close ${ref(repo, l)}: ${e}`)
    else (closed.push(ref(repo, l)), lowers.push(lp))
  }
  if (item.deleteBranch !== false) for (const lp of lowers) await dropBranch(lp)
  const how = subject ? ` as ${short(commit)}, "${subject}"` : ` as ${short(commit)} (merged before this poll, by the queue or by hand)`
  return `Merge queue: merged ${n}${title}${how}.${closed.length ? ` Closed ${closed.join(', ')} as landed in it.` : ''}${notes.length ? ` Note: ${notes.join('; ')}.` : ''}`
}

/** One step of a conflict as an event (#1182): `step`, `ms` and what else it carries go into the event. */
const conflictEvent = (text, data) => ({ kind: 'conflict', text, data })

/**
 * A pull request that conflicts with its base (#1182). Once per head: merges the default branch
 * into it in a temporary worktree (queue-conflict.mjs), and pushes that when every conflict is in a
 * mechanical file (regenerated), else hands it to the PR's author session. The lease is renewed
 * while it works, since regenerating can take minutes. Answers `{ decision, patch?, events }`, or
 * `{ yielded }` when another driver took the queue.
 */
async function onConflict(item, pr, { now, ref, renew, defaultBranch, landed = [], opened = null }) {
  const n = ref(item.repo, item.pr)
  const head = pr.headRefOid
  const at = new Date(now).toISOString()
  const done = item.conflict?.head === head ? item.conflict : null
  // Pushed, or the author pushed first: GitHub still shows the head before it, for a moment
  if (done?.outcome === 'pushed' || done?.outcome === 'superseded') return { decision: { state: 'waiting' }, events: [] }
  // Handed off on this head already: the same reason, so no second message
  if (done?.outcome === 'handoff' && done.reason) return { decision: { state: 'attention', reason: done.reason }, events: [] }
  const since = item.conflict?.at ?? at
  const hand = (why, files, steps = [], instruction = null) => {
    // Where the instruction goes (queue.mjs authorRoute): this session when it is the author, the author's own session when
    // it opened the pull request through open_pr, else the queuing session relays it
    const where = item.author || opened?.notice ? authorRoute(item, opened) : { route: 'relay', to: null }
    const d = handoffReason({ item, pr, files, why, ref, instruction, route: where.route })
    const to = d.reason.relay.to
    return {
      decision: d,
      patch: { conflict: { head, at: since, outcome: 'handoff', files, reason: d.reason } },
      events: [
        ...steps,
        // Posted into the author session itself, beside the owner's attention message (once per head, like it)
        ...(where.route === 'direct'
          ? [{ kind: 'handoff', notify: true, to: where.to, text: `Merge queue: ${n}${item.title ? ` (${item.title})` : ''} is your pull request and it conflicts with ${pr.baseRefName}: ${d.reason.relay.text}` }]
          : []),
        conflictEvent(`${n}: conflict handed to ${where.route === 'direct' ? 'the session that opened it, which the queue told itself' : where.route === 'self' ? 'the session that queued it, its author' : to ? `its author session ${to}` : 'a session on its branch (no author session recorded)'}${files.length ? `; conflicted files: ${listSome(files, 8)}` : ''}.`, {
          step: 'handoff',
          ms: clock() - now,
          files,
          by: 'session',
          relay: d.reason.relay,
        }),
      ],
    }
  }
  const not = cannotMergeBase(pr, defaultBranch)
  // A stack's top, based on the branch of a pull request that has merged since (#1509 item 4): restacked onto its merge
  // commit as rebase_stack does, which proves the change is the one CI tested and pushes with a lease, instead of telling a
  // session to run rebase_stack. One whose lower is not merged, was built on an older lower, or does not replay cleanly
  // is refused by the same procedure and handed to its author, as before
  if (not && !pr.isCrossRepository && pr.baseRefName !== defaultBranch && QUEUE.conflicts?.checkout) {
    const keep = setInterval(() => renew(), Math.max(1_000, LEASE_MS / 6))
    keep.unref?.()
    const began = clock()
    let restacked
    try {
      restacked = await rebaseStack({ repo: item.repo, pr: item.pr, dir: QUEUE.conflicts.checkout, push: true }, { readPr, prsWithHead, setPrBase, openPrsOnBase }, (k) => ref(item.repo, k))
    } catch (e) {
      // The remote did not answer (a fetch, or the push): not the pull request's conflict, so nothing is handed to its author.
      // A GitHubError of kind network pauses the queue and tries this item again, as any lost network does
      if (isNetworkFailure(e)) throw new GitHubError('network', `git could not reach the remote while restacking ${n}: ${e.message} The queue tries again when the network is back.`)
      if (!(e instanceof StackRefusal) && !(e instanceof GitError)) throw e
      return hand(`${not} Restacking it was tried and refused: ${e.message}`, [])
    } finally {
      clearInterval(keep)
    }
    if (restacked.pushed && !restacked.partial) {
      const ms = clock() - began
      return {
        decision: { state: 'waiting' },
        patch: { conflict: { head, at: since, outcome: 'pushed', sha: restacked.rebased, files: [] } },
        events: [conflictEvent(`${n}: restacked onto the merge commit of the pull request under it, as rebase_stack would, in ${span(ms)}: ${restacked.summary} CI runs on the new head before it lands.`, { step: 'restack', ms, sha: restacked.rebased, by: 'queue', lease: true })],
      }
    }
    // Its commits were in the lower one's merge already (it was merged, not squashed): only the base moved
    if (!restacked.partial) return { decision: { state: 'waiting' }, events: [conflictEvent(`${n}: ${restacked.summary}`, { step: 'restack', ms: clock() - began, by: 'queue' })] }
    return hand(`${not} Restacking it pushed the branch but could not move its base: ${restacked.summary}`, [])
  }
  if (not) return hand(not, [])
  // Regenerating can take minutes: hold the lease meanwhile (every write still asks renew first)
  const keep = setInterval(() => renew(), Math.max(1_000, LEASE_MS / 6))
  keep.unref?.()
  let r
  try {
    r = await mergeMain({ repo: item.repo, pr, defaultBranch, dir: QUEUE.conflicts.checkout, conflicts: QUEUE.conflicts, renew, landed })
  } finally {
    clearInterval(keep)
  }
  if (r.outcome === 'yielded') return { yielded: true }
  if (r.outcome === 'moved') return { decision: { state: 'waiting' }, events: [] }
  const steps = r.steps.map((st) =>
    st.step === 'merge'
      ? conflictEvent(`${n}: merged ${defaultBranch} into ${pr.headRefName} in a temporary worktree in ${span(st.ms)}; ${st.files.length ? `conflicts in ${listSome(st.files, 8)}` : 'no conflicts'}.`, { step: 'merge', ms: st.ms, files: st.files })
      : st.step === 'regenerate'
        ? conflictEvent(
            `${n}: regenerated ${listSome(st.files, 8)}${st.also ? ` (and ${listSome(st.also, 8)}, which did not conflict)` : ''} with ${st.commands.join(', ')} in ${span(st.ms)}${st.modules === 'linked' ? " (node_modules linked from the queue's checkout, its lockfile being main's: no install)" : ''}; against ${defaultBranch}: ${st.stat.length ? st.stat.map(statLine).join(', ') : 'no change'}.`,
            { step: 'regenerate', ms: st.ms, files: st.files, ...(st.also ? { also: st.also } : {}), commands: st.commands, stat: st.stat, modules: st.modules },
          )
        : st.step === 'rebase'
          ? conflictEvent(
              `${n}: ${pr.headRefName} still carried the original commits of #${st.dropped}, which the queue landed as a squash; rebased it onto ${defaultBranch} without them in ${span(st.ms)}${st.files.length ? `, which conflicts in ${listSome(st.files, 8)}` : ''}.`,
              { step: 'rebase', ms: st.ms, files: st.files, dropped: st.dropped },
            )
        : st.step === 'superseded'
          ? conflictEvent(`${n}: ${pr.headRefName} moved to ${short(st.tip)} while the queue merged ${defaultBranch} in (its author pushed first), so git refused the queue's ${short(st.sha)}; the queue takes the new head.`, {
              step: 'superseded',
              ms: st.ms,
              sha: st.sha,
              tip: st.tip,
            })
          : conflictEvent(`${n}: pushed ${short(st.sha)} to ${pr.headRefName}${st.lease ? ' with a lease on the head it read (--force-with-lease)' : ''} in ${span(st.ms)}; CI runs on the new head before it lands.`, { step: 'push', ms: st.ms, sha: st.sha, by: 'queue', ...(st.lease ? { lease: true } : {}) }),
  )
  if (r.outcome === 'pushed') return { decision: { state: 'waiting' }, patch: { conflict: { head, at: since, outcome: 'pushed', sha: r.sha, files: r.files } }, events: steps }
  // Quietly: the author's own push is the fix, or the next conflict, which the next poll reads
  if (r.outcome === 'superseded') return { decision: { state: 'waiting' }, patch: { conflict: { head, at: since, outcome: 'superseded', tip: r.tip, files: r.files } }, events: steps }
  return hand(r.why, r.files, steps, r.instruction ?? null)
}

/** Writes down that the item's pull request was seen ready; a file that cannot be written is a nicety lost, never a reason to stop */
function rememberReadied(dir, item) {
  try {
    noteReadied(dir, item.repo, item.pr)
  } catch (e) {
    console.error('[project-board] merge queue: could not record that', item.repo, item.pr, 'was seen ready:', e?.message ?? e)
  }
}

/**
 * Whether the session that queued this item opened its pull request through `open_pr` **as a draft** (opened.mjs), and
 * it was never seen ready since. A pull request opened ready and turned into a draft later is someone's hold (a person
 * stopping it, or `open_pr` making a stack's lower one a draft); so is one that was ready once and is a draft again, which
 * `readied` remembers (a person turned the queue's own mark back, or the session's): not undone here.
 */
const ownDraft = (item, opened) => opened?.draft === true && opened.readied !== true && Boolean(opened.notice) && opened.notice === item.notice

/**
 * Reads one item's pull request and CI, decides, and acts. Answers what to write back: the new state
 * and fields, the events, and when to read it again. Throws only what stops every item (rate limit,
 * no network, no login).
 */
async function pollItem(item, { now, ref, renew, save, landed = [], stillIntegrated = () => true, opened = null, readied = () => {} }) {
  const repo = item.repo
  const at = new Date(now).toISOString()
  const { permissions, defaultBranch } = await permissionsOf(repo, now)
  const pr = await readPr(repo, item.pr, QUEUE_PR_FIELDS)
  const base = { title: pr.title, ...resetFor(item, pr.headRefOid) }
  const view = { ...item, ...base }
  const events = []
  if (item.head && item.head !== pr.headRefOid) events.push({ kind: 'head', text: `${ref(repo, item.pr)}: head moved from ${short(item.head)} to ${short(pr.headRefOid)}; starting again on it.` })

  // A record handed over with integrate stays a draft until it lands (#1259 step 3): one found ready for review (a
  // person, mark_ready, a driver stopped between readying and squashing) is turned back, before anything reads it
  // Still queued as the integrator's (taken out meanwhile, the session may be readying it for queue_merge: not ours to undo)
  if (item.auto && pr.state === 'OPEN' && !pr.isDraft && stillIntegrated()) {
    if (!renew()) return { yielded: true }
    await markDraft(repo, item.pr)
    Object.assign(pr, { isDraft: true, mergeStateStatus: 'DRAFT' })
    events.push({ kind: 'action', text: `${ref(repo, item.pr)} was ready for review; turned back into a draft: a record handed over with integrate stays one until the queue squashes it, so nothing else (an older board, a merge by hand) can land it unjudged.` })
  }
  // A draft that the session queuing it opened itself (open_pr noted which session, opened.mjs) is ready as far as that
  // session is concerned: it queued it to land. Marked ready here, as `mark_ready` would be, instead of asking it to.
  // Not a record handed over with integrate (a draft on purpose until it lands), and not one a stack made a lower:
  // that one is not queued by the session that opened it as its top
  // Seen ready for review, by the session or a person: a draft it becomes after that is a hold, which is not undone (ownDraft)
  if (pr.state === 'OPEN' && !pr.isDraft && opened?.draft === true && opened.readied !== true) readied()
  if (pr.state === 'OPEN' && pr.isDraft && !item.auto && canMerge(permissions) && ownDraft(item, opened) && (await openPrsOnBase(repo, pr.headRefName)).length === 0) {
    if (!renew()) return { yielded: true }
    await markReady(repo, item.pr)
    readied()
    Object.assign(pr, { isDraft: false, mergeStateStatus: 'UNKNOWN' })
    events.push({ kind: 'action', text: `${ref(repo, item.pr)} was opened as a draft by the session queuing it; the queue marked it ready for review, as that session would have.` })
  }
  let d = decideBefore({ item: view, permissions, pr, defaultBranch, ref })
  if (d?.reason?.kind === 'dirty') {
    if (!renew()) return { yielded: true }
    const c = await onConflict(view, pr, { now, ref, renew, defaultBranch, landed, opened })
    if (c.yielded) return { yielded: true }
    d = c.decision
    Object.assign(base, c.patch ?? {})
    events.push(...c.events)
  } else if (item.conflict && item.conflict.head !== pr.headRefOid && !d) {
    // Fixed: a new head that no longer conflicts, pushed by the queue or by a session (#1182)
    const by = item.conflict.outcome === 'pushed' && item.conflict.sha === pr.headRefOid ? 'queue' : 'session'
    const ms = now - Date.parse(item.conflict.at)
    events.push(conflictEvent(`${ref(repo, item.pr)}: the conflict found at ${item.conflict.at.slice(11, 16)} UTC is fixed ${by === 'queue' ? 'by the queue' : 'by a push'} after ${span(ms)}; it goes to the front of the queue.`, { step: 'fixed', ms, by }))
    base.conflict = null
    // Not behind everything queued while it was fixed (#1182): batches and the list take it first
    base.front = item.front ?? at
  }
  // Handed over with integrate (#1259 step 3): judged on each new head; one that is not auto goes on to no CI or batch
  // A tier:<name> label above auto stops it on every poll, whatever the judge said of its head
  const labelled = !d && item.auto ? labelReason(ref(repo, item.pr), pr.labels) : null
  if (labelled) d = { state: 'attention', reason: labelled }
  if (!d && item.auto) {
    let t = view.tierAt?.head === pr.headRefOid ? view.tierAt : null
    if (!t) {
      // A judgment stays for its head; one that could not be made throws, and is counted as a failed poll
      t = await judgeHead({ dir: QUEUE.conflicts.checkout, repo, n: ref(repo, item.pr), pr, defaultBranch })
      base.tierAt = t
    }
    if (t.tier !== 'auto') d = { state: 'attention', reason: t.reason }
  }
  // The latest CI run of each workflow on the head, once read: what proved it, if it lands
  let runs = []
  if (!d) {
    let required = view.required
    if (!required || required.base !== pr.baseRefName || required.head !== pr.headRefOid) {
      const r = await readRequired(repo, pr.baseRefName, CI.workflows, workflowCheckNames, pr.headRefOid)
      required = { base: pr.baseRefName, head: pr.headRefOid, names: r.names, unresolved: r.unresolved }
      base.required = required
    }
    // Only the CI workflows' own checks count: a release job of the same name is not CI (#624)
    const scoped = await readWorkflowChecks(repo, pr.headRefOid, { workflows: CI.workflows })
    const checks = evaluateChecks({ required: required.names, reported: scoped.reported, alsoReported: required.unresolved.length > 0 })
    runs = latestRuns(scoped.runs, pr)
    // Why a finished run failed (its jobs and steps): only an infrastructure failure is rerun
    const failures = checks.verdict === 'failing' ? await runFailures(repo, runs, view.failures) : {}
    base.failures = failures
    const canBatch = QUEUE.batch !== null && batchable(pr)
    // What a batch looks at (batch.mjs batchCandidates): its own CI on this head, and whether it has started
    base.ci = { head: pr.headRefOid, verdict: checks.verdict, runs: runs.map((r) => ({ id: r.id, status: r.status })), batchable: batchable(pr) }
    let lowerBranches = []
    if (checks.verdict === 'green' && pr.baseRefName !== defaultBranch && item.lowers?.length)
      lowerBranches = (await Promise.all(item.lowers.map((l) => readPr(repo, l).catch(() => null)))).filter(Boolean).map((l) => l.headRefName)
    // UNSTABLE on a green head: is it only a cancelled duplicate, or an older run (#1015)? Every check on it says
    let supersededOnly = false
    if (checks.verdict === 'green' && pr.mergeStateStatus === 'UNSTABLE') supersededOnly = onlySupersededFailures(await readChecks(repo, pr.headRefOid), scoped.runs)
    d = decideCi({ item: view, pr, checks, runs, failures, defaultBranch, lowerBranches, supersededOnly, now, ref, fullTier: CI.fullTier, canBatch, landTier: CI.landTier })
    // Its quick tier passed: what a batch takes (two tiers, queue.mjs)
    if (d.quick) base.ci.verdict = 'quick'
  }

  let wait = pollMs(d.state === 'attention' ? 'attention' : d.state === 'waiting' ? 'waiting' : 'ci')
  const patch = { ...base, ...(d.patch ?? {}) }
  if (d.event) events.push({ kind: 'action', text: d.event })
  if (d.action?.type === 'rerun') {
    if (!renew()) return { yielded: true }
    // Written down before asking, so a refusal or a driver stopped mid-call is never asked again
    save({ ...base, reruns: patch.reruns })
    try {
      await rerunRun(repo, d.action.runId, { failedOnly: d.action.failedOnly })
      wait = pollMs('acted')
    } catch (e) {
      if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
      patch.reruns = { ...patch.reruns, [d.action.kind]: { ...patch.reruns[d.action.kind], error: e.message } }
      d = rerunRefused(ref(repo, item.pr), d.action.runId, e.message)
      wait = pollMs('attention')
    }
  } else if (d.action?.type === 'dispatch-full') {
    if (!renew()) return { yielded: true }
    // Written down before asking, so a refusal or a driver stopped mid-call never starts it twice
    save({ ...base, fullDispatch: patch.fullDispatch })
    try {
      // No inputs: the full tier (a manual run with no tier asked for is full, .github/scripts/ci-changes.mjs)
      for (const w of CI.workflows) await dispatchWorkflow(repo, w.split('/').pop(), d.action.branch)
      wait = pollMs('acted')
    } catch (e) {
      if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
      patch.fullDispatch = { ...patch.fullDispatch, refused: e.message }
      d = { state: 'attention', reason: { kind: 'full-tier', text: `${ref(repo, item.pr)}: its quick tier passed, the queue cannot batch it, and GitHub refused to start the full tier on ${d.action.branch}: ${e.message} Start it by hand (gh workflow run build.yml --ref ${d.action.branch}); the queue lands it once that run is green.` } }
      wait = pollMs('attention')
    }
  } else if (d.action?.type === 'retarget') {
    if (!renew()) return { yielded: true }
    await setPrBase(repo, item.pr, d.action.base)
    wait = pollMs('waiting')
  } else if (d.action?.type === 'merge' && ['refused', 'not-merged'].includes(item.reason?.kind) && item.head === pr.headRefOid) {
    // GitHub refused this head once, or holds it: asking again changes nothing until the head or the PR does
    d = { state: 'attention', reason: item.reason }
  } else if (d.action?.type === 'merge') {
    // The top's own run proved it: the newest of its CI runs on this head
    const provedAt = runs.map((r) => r.createdAt).filter(Boolean).sort().at(-1) ?? null
    const landed = await land(view, pr, ref, renew, defaultBranch, { provedAt })
    if (landed.yielded) return { yielded: true }
    if (landed.tierAt) patch.tierAt = landed.tierAt
    d = landed
  }

  if (d.state === 'merged') {
    const merged = d.merged ?? pr
    const text = await afterMerge(view, merged, ref, d.subject, { landed: d.landed, defaultBranch })
    Object.assign(patch, { mergedAt: at, commit: merged.mergeCommit?.oid ?? null })
    events.push({ kind: 'merged', text, notify: true })
  } else if (d.state === 'closed') {
    events.push({ kind: 'closed', text: `Merge queue: ${ref(repo, item.pr)}${pr.title ? ` (${pr.title})` : ''} was closed without merging; it is off the queue.`, notify: true })
  }

  patch.errors = 0
  if (d.state === 'attention') {
    const key = noticeKey(d.reason, pr.headRefOid)
    if (key !== item.noticeKey) {
      const extra = d.reason.kind === 'failed' || d.reason.kind === 'failing' ? await failingLine(repo, d.reason.job) : ''
      const reason = { ...d.reason, text: `${d.reason.text}${extra}` }
      Object.assign(patch, { reason, noticeKey: key, attentionAt: at })
      events.push({ kind: 'attention', text: attentionText({ ...item, title: pr.title }, reason, ref), notify: true, data: reason.relay ? { relay: reason.relay } : null })
    } else patch.reason = item.reason ?? d.reason
  } else Object.assign(patch, { reason: null, noticeKey: null, attentionAt: null })

  return { state: d.state, patch, events, wait }
}

/**
 * One tick: when the queue has an item due and no other driver holds the lease, polls that one item
 * and writes back what changed. Answers what it did: `idle`, `paused`, `busy` (another driver),
 * `polled` (with the item's key) or `error`.
 */
export async function tick(dir, { holder, now = clock(), ref = queueRef }) {
  let q = readQueue(dir)
  const active = q.items.filter((i) => ACTIVE.has(i.state))
  // A batch whose last member landed still has its end to do (its branch, the tree check)
  if (!active.length && !activeBatch(q)) {
    releaseLease(dir, holder)
    return { did: 'idle' }
  }
  if (q.pause && Date.parse(q.pause.until) > now) return { did: 'paused', until: q.pause.until }
  // Too many of main's full runs unfinished (#1259): each landing adds one, so the queue waits for them
  if (QUEUE.guard && (q.guard?.unfinished ?? 0) > QUEUE.guard.maxMainRuns) return { did: 'held', unfinished: q.guard.unfinished }
  if (!takeLease(dir, holder, systemNow())) return { did: 'busy', holder: readLease(dir)?.holder ?? null }
  q = readQueue(dir)
  // Batches first (#962): the running one when it is due, or a new one from items waiting for CI
  const work = batchWork(q, now)
  if (work?.form) {
    updateQueue(dir, (fresh) => formDue(fresh, now, ref))
    return { did: 'batched' }
  }
  if (work?.batch) return batchTick(dir, work.batch, { q, holder, now, ref })
  const item = dueItem(q, now)
  if (!item) return { did: 'idle' }
  const key = itemKey(item)
  const at = new Date(now).toISOString()
  // Before every write to GitHub: still the driver? (A driver asleep past its lease must not act.)
  const renew = () => takeLease(dir, holder, systemNow())
  const save = (p) =>
    updateQueue(dir, (fresh) => {
      const it = fresh.items.find((i) => itemKey(i) === key && ACTIVE.has(i.state))
      if (it) Object.assign(it, p)
    })
  // What this queue landed (#1221): a pull request stacked on one of them still carries its commits
  const landed = q.items
    .filter((i) => i.state === 'merged' && i.head && i.pr !== item.pr && String(i.repo).toLowerCase() === String(item.repo).toLowerCase())
    .sort((a, b) => String(b.mergedAt ?? '').localeCompare(String(a.mergedAt ?? '')))
    .map((i) => ({ pr: i.pr, head: i.head }))
  let r
  try {
    r = await pollItem(item, { now, ref, renew, save, landed, opened: openedBy(readOpened(dir), item.repo, item.pr), readied: () => rememberReadied(dir, item), stillIntegrated: () => readQueue(dir).items.some((i) => itemKey(i) === key && ACTIVE.has(i.state) && i.auto) })
  } catch (e) {
    const fatal = e instanceof GitHubError && FATAL.has(e.kind)
    const message = e instanceof GitHubError ? e.message : `Unexpected error: ${e?.message ?? e}`
    if (!(e instanceof GitHubError)) console.error('[project-board] merge queue:', e)
    updateQueue(dir, (fresh) => {
      if (fatal) {
        const ms = Math.min(PAUSE_MAX_MS, Math.max(PAUSE_MIN_MS, (fresh.pause?.ms ?? 0) * 2))
        fresh.pause = { since: fresh.pause?.since ?? at, until: new Date(now + ms).toISOString(), ms, kind: e.kind, reason: message }
      }
      const it = fresh.items.find((i) => itemKey(i) === key && ACTIVE.has(i.state))
      if (!it) return
      Object.assign(it, { lastError: message, nextAt: new Date(now + pollMs('error')).toISOString() })
      if (fatal) return
      // The same failure on one item, poll after poll (a pull request gone, a refused write): the
      // session hears about it once it is not a blip, and once per change
      it.errors = (it.errors ?? 0) + 1
      if (it.errors < ERROR_LIMIT) return
      const reason = errorReason(ref(it.repo, it.pr), it.errors, message)
      const nk = noticeKey(reason, it.head)
      Object.assign(it, { state: 'attention', reason, nextAt: new Date(now + pollMs('attention')).toISOString() })
      if (nk === it.noticeKey) return
      it.noticeKey = nk
      pushEvent(fresh, it, { kind: 'attention', text: attentionText(it, reason, ref), notify: true, at })
    })
    return { did: 'error', key, error: message, fatal }
  }
  if (r.yielded) return { did: 'busy', holder: readLease(dir)?.holder ?? null }
  updateQueue(dir, (fresh) => {
    fresh.pause = null
    const it = fresh.items.find((i) => itemKey(i) === key && ACTIVE.has(i.state))
    // Taken out of the queue while it was being read: nothing to write back (a merge is still news)
    const target = it ?? { ...item }
    Object.assign(target, r.patch, { state: r.state, updatedAt: at, lastError: null, nextAt: new Date(now + r.wait).toISOString() })
    if (r.state !== 'attention' && target.reason) target.reason = null
    for (const ev of r.events) pushEvent(fresh, target, { kind: ev.kind, text: ev.text, notify: ev.notify === true, at, data: ev.data ?? null, to: ev.to ?? null })
  })
  return { did: 'polled', key, state: r.state }
}

/**
 * Drives the queue every `tickMs` until stopped: the server calls it at start, the watch command while
 * it waits. The timer does not keep the process alive. With `manual`, it ticks only when `step()` is called (and
 * `step()` resolves once that tick, its guard step and `onTick` are done).
 */
export function startDriver(dir, { holder, ref = queueRef, tickMs = TICK_MS, onTick, manual = false } = {}) {
  let timer = null
  let stopped = false
  let running = Promise.resolve()
  // A tick that throws (the queue file does not read) says so once, then waits longer each time
  let failures = 0
  let said = null
  let guardSaid = null
  const once = async () => {
    let done
    const previous = running
    running = new Promise((resolve) => (done = resolve))
    await previous
    try {
      const r = await tick(dir, { holder, ref, now: clock() })
      failures = 0
      said = null
      try {
        await runGuard(dir, { holder, ref, now: clock() })
      } catch (e) {
        const message = `the main guard: ${String(e?.message ?? e)}`
        if (message !== guardSaid) console.error(`[project-board] merge queue: ${message}`)
        guardSaid = message
        updateQueue(dir, (fq) => (fq.guard = { ...(fq.guard ?? {}), lastError: message, nextAt: new Date(clock() + GUARD_MS).toISOString() }))
      }
      await onTick?.(r, clock())
    } catch (e) {
      failures += 1
      const message = String(e?.message ?? e)
      if (message !== said) console.error(`[project-board] merge queue: ${message}`)
      said = message
    } finally {
      done()
    }
  }
  const loop = async () => {
    if (stopped) return
    await once()
    if (!stopped) {
      timer = setTimeout(loop, failures ? Math.min(BACKOFF_MAX_MS, tickMs * 2 ** failures) : tickMs)
      timer.unref?.()
    }
  }
  if (!manual) {
    timer = setTimeout(loop, 0)
    timer.unref?.()
  }
  return {
    /** One tick now, after the one in flight: what `manual` drives with. Resolves once it is written down. */
    step: () => {
      if (stopped) return Promise.resolve()
      advanceClock(STEP_MS)
      return once()
    },
    /** Stops ticking; resolves once the tick in flight (a merge among it) has written what it did. */
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      return running.then(() => releaseLease(dir, holder))
    },
    /** Stops at once, for a process that is exiting: the lease goes, the tick in flight is lost. */
    stopNow() {
      stopped = true
      if (timer) clearTimeout(timer)
      releaseLease(dir, holder)
    },
  }
}
