// The merge queue's driver (#956): the queue file in the app's data folder, the lease that lets one
// process drive at a time, and one poll per tick. The decisions are queue.mjs's; this reads GitHub
// for them and does what they say.
//
// Who drives: the board app's server while it runs (Centralu stops an app with no open screen and no
// call for 5 minutes, docs/apps.md §4), and the watch command (bin/merge-queue.mjs) a session runs in
// the background. Both take the same lease (`merge-queue.lease.json`), so one of them polls at a
// time, and both read and write the same file, so the queue carries on in whichever is alive, and
// after either restarts.
//
// Gentle on GitHub: one item per tick (a few seconds), each item again only after its own wait
// (queue.mjs POLL_MS: 90 s while CI runs), the required checks read once per head, and a rate limit
// or an outage pauses the whole queue with a growing wait.
import { readFileSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateChecks, firstFailure, squashMessage, workflowCheckNames } from './ci.mjs'
import { CI, config, QUEUE } from './config.mjs'
import {
  closePr,
  containsCommit,
  deleteBranch,
  FATAL,
  GitHubError,
  mergePr,
  openPrsOnBase,
  QUEUE_PR_FIELDS,
  readChecks,
  readJobLog,
  readPr,
  readRepo,
  readRequired,
  readWorkflowChecks,
  rerunRun,
  sameRepo,
  setPrBase,
} from './github.mjs'
import {
  ACTIVE,
  attentionText,
  cannotMergeBase,
  decideBefore,
  decideCi,
  dueItem,
  emptyQueue,
  ERROR_LIMIT,
  errorReason,
  handoffReason,
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
import { mergeMain, statLine } from './queue-conflict.mjs'
import { activeBatch } from './batch.mjs'
import { batchTick, batchWork, formDue } from './queue-batch.mjs'
import { listSome, short, span } from './util.mjs'

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
      const until = Date.now() + 25
      while (Date.now() < until) {
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
export function takeLease(dir, holder, now = Date.now()) {
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

/** The first failing test line of a failed job, for the attention message; best effort. */
async function failingLine(repo, job) {
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
 * branch of this repository and starts CI there, with this repository's secrets), not a release bump
 * (its CI is the release's evidence, docs/releasing.md, and it lands alone).
 */
export function batchable(pr) {
  if (pr.isCrossRepository) return false
  const prefix = config.release?.branchPrefix
  if (prefix && String(pr.headRefName ?? '').startsWith(prefix)) return false
  return !/^chore\(release\)!?:/.test(String(pr.title ?? ''))
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
export async function land(item, pr, ref, renew, defaultBranch, { provedAt = null } = {}) {
  const repo = item.repo
  const n = ref(repo, item.pr)
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
  const msg = squashMessage({ number: pr.number, title: pr.title, description: pr.body })
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
async function onConflict(item, pr, { now, ref, renew, defaultBranch }) {
  const n = ref(item.repo, item.pr)
  const head = pr.headRefOid
  const at = new Date(now).toISOString()
  const done = item.conflict?.head === head ? item.conflict : null
  // Pushed, or the author pushed first: GitHub still shows the head before it, for a moment
  if (done?.outcome === 'pushed' || done?.outcome === 'superseded') return { decision: { state: 'waiting' }, events: [] }
  // Handed off on this head already: the same reason, so no second message
  if (done?.outcome === 'handoff' && done.reason) return { decision: { state: 'attention', reason: done.reason }, events: [] }
  const since = item.conflict?.at ?? at
  const hand = (why, files, steps = []) => {
    const d = handoffReason({ item, pr, files, why, ref })
    const to = d.reason.relay.to
    return {
      decision: d,
      patch: { conflict: { head, at: since, outcome: 'handoff', files, reason: d.reason } },
      events: [
        ...steps,
        conflictEvent(`${n}: conflict handed to ${to ? `its author session ${to}` : 'a session on its branch (no author session recorded)'}${files.length ? `; conflicted files: ${listSome(files, 8)}` : ''}.`, {
          step: 'handoff',
          ms: Date.now() - now,
          files,
          by: 'session',
          relay: d.reason.relay,
        }),
      ],
    }
  }
  const not = cannotMergeBase(pr, defaultBranch)
  if (not) return hand(not, [])
  // Regenerating can take minutes: hold the lease meanwhile (every write still asks renew first)
  const keep = setInterval(() => renew(), Math.max(1_000, LEASE_MS / 6))
  keep.unref?.()
  let r
  try {
    r = await mergeMain({ repo: item.repo, pr, defaultBranch, dir: QUEUE.conflicts.checkout, conflicts: QUEUE.conflicts, renew })
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
            `${n}: regenerated ${listSome(st.files, 8)} with ${st.commands.join(', ')} in ${span(st.ms)}; against ${defaultBranch}: ${st.stat.length ? st.stat.map(statLine).join(', ') : 'no change'}.`,
            { step: 'regenerate', ms: st.ms, files: st.files, commands: st.commands, stat: st.stat },
          )
        : st.step === 'superseded'
          ? conflictEvent(`${n}: ${pr.headRefName} moved to ${short(st.tip)} while the queue merged ${defaultBranch} in (its author pushed first), so git refused the queue's ${short(st.sha)}; the queue takes the new head.`, {
              step: 'superseded',
              ms: st.ms,
              sha: st.sha,
              tip: st.tip,
            })
          : conflictEvent(`${n}: pushed ${short(st.sha)} to ${pr.headRefName} in ${span(st.ms)}; CI runs on the new head before it lands.`, { step: 'push', ms: st.ms, sha: st.sha, by: 'queue' }),
  )
  if (r.outcome === 'pushed') return { decision: { state: 'waiting' }, patch: { conflict: { head, at: since, outcome: 'pushed', sha: r.sha, files: r.files } }, events: steps }
  // Quietly: the author's own push is the fix, or the next conflict, which the next poll reads
  if (r.outcome === 'superseded') return { decision: { state: 'waiting' }, patch: { conflict: { head, at: since, outcome: 'superseded', tip: r.tip, files: r.files } }, events: steps }
  return hand(r.why, r.files, steps)
}

/**
 * Reads one item's pull request and CI, decides, and acts. Answers what to write back: the new state
 * and fields, the events, and when to read it again. Throws only what stops every item (rate limit,
 * no network, no login).
 */
async function pollItem(item, { now, ref, renew, save }) {
  const repo = item.repo
  const at = new Date(now).toISOString()
  const { permissions, defaultBranch } = await permissionsOf(repo, now)
  const pr = await readPr(repo, item.pr, QUEUE_PR_FIELDS)
  const base = { title: pr.title, ...resetFor(item, pr.headRefOid) }
  const view = { ...item, ...base }
  const events = []
  if (item.head && item.head !== pr.headRefOid) events.push({ kind: 'head', text: `${ref(repo, item.pr)}: head moved from ${short(item.head)} to ${short(pr.headRefOid)}; starting again on it.` })

  let d = decideBefore({ item: view, permissions, pr, defaultBranch, ref })
  if (d?.reason?.kind === 'dirty') {
    if (!renew()) return { yielded: true }
    const c = await onConflict(view, pr, { now, ref, renew, defaultBranch })
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
    const canBatch = QUEUE.batch !== null && batchable(pr)
    // What a batch looks at (batch.mjs batchCandidates): its own CI on this head, and whether it has started
    base.ci = { head: pr.headRefOid, verdict: checks.verdict, runs: runs.map((r) => ({ id: r.id, status: r.status })), batchable: batchable(pr) }
    let lowerBranches = []
    if (checks.verdict === 'green' && pr.baseRefName !== defaultBranch && item.lowers?.length)
      lowerBranches = (await Promise.all(item.lowers.map((l) => readPr(repo, l).catch(() => null)))).filter(Boolean).map((l) => l.headRefName)
    // UNSTABLE on a green head: is it only a cancelled duplicate, or an older run (#1015)? Every check on it says
    let supersededOnly = false
    if (checks.verdict === 'green' && pr.mergeStateStatus === 'UNSTABLE') supersededOnly = onlySupersededFailures(await readChecks(repo, pr.headRefOid), scoped.runs)
    d = decideCi({ item: view, pr, checks, runs, defaultBranch, lowerBranches, supersededOnly, now, ref, fullTier: CI.fullTier, canBatch })
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
      Object.assign(patch, { reason, noticeKey: key })
      events.push({ kind: 'attention', text: attentionText({ ...item, title: pr.title }, reason, ref), notify: true, data: reason.relay ? { relay: reason.relay } : null })
    } else patch.reason = item.reason ?? d.reason
  } else Object.assign(patch, { reason: null, noticeKey: null })

  return { state: d.state, patch, events, wait }
}

/**
 * One tick: when the queue has an item due and no other driver holds the lease, polls that one item
 * and writes back what changed. Answers what it did: `idle`, `paused`, `busy` (another driver),
 * `polled` (with the item's key) or `error`.
 */
export async function tick(dir, { holder, now = Date.now(), ref = queueRef }) {
  let q = readQueue(dir)
  const active = q.items.filter((i) => ACTIVE.has(i.state))
  // A batch whose last member landed still has its end to do (its branch, the tree check)
  if (!active.length && !activeBatch(q)) {
    releaseLease(dir, holder)
    return { did: 'idle' }
  }
  if (q.pause && Date.parse(q.pause.until) > now) return { did: 'paused', until: q.pause.until }
  if (!takeLease(dir, holder, now)) return { did: 'busy', holder: readLease(dir)?.holder ?? null }
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
  const renew = () => takeLease(dir, holder, Date.now())
  const save = (p) =>
    updateQueue(dir, (fresh) => {
      const it = fresh.items.find((i) => itemKey(i) === key && ACTIVE.has(i.state))
      if (it) Object.assign(it, p)
    })
  let r
  try {
    r = await pollItem(item, { now, ref, renew, save })
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
    for (const ev of r.events) pushEvent(fresh, target, { kind: ev.kind, text: ev.text, notify: ev.notify === true, at, data: ev.data ?? null })
  })
  return { did: 'polled', key, state: r.state }
}

/**
 * Drives the queue every `tickMs` until stopped: the server calls it at start, the watch command while
 * it waits. The timer does not keep the process alive.
 */
export function startDriver(dir, { holder, ref = queueRef, tickMs = TICK_MS, onTick } = {}) {
  let timer = null
  let stopped = false
  let running = Promise.resolve()
  // A tick that throws (the queue file does not read) says so once, then waits longer each time
  let failures = 0
  let said = null
  const loop = async () => {
    if (stopped) return
    let done
    running = new Promise((resolve) => (done = resolve))
    try {
      const r = await tick(dir, { holder, ref })
      failures = 0
      said = null
      onTick?.(r)
    } catch (e) {
      failures += 1
      const message = String(e?.message ?? e)
      if (message !== said) console.error(`[project-board] merge queue: ${message}`)
      said = message
    } finally {
      done()
    }
    if (!stopped) {
      timer = setTimeout(loop, failures ? Math.min(BACKOFF_MAX_MS, tickMs * 2 ** failures) : tickMs)
      timer.unref?.()
    }
  }
  timer = setTimeout(loop, 0)
  timer.unref?.()
  return {
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
