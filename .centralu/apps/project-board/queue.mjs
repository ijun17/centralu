// The merge queue's decisions and records (#956), as pure functions: no gh, no files, no clock of its
// own. queue-driver.mjs reads GitHub and the queue file and asks these what to do; queue-tools.mjs
// answers the tools from the same records.
//
// One item is one pull request, or a stack: `pr` is its top and `lowers` the pull requests under it,
// which land with it as one squash commit through the top (retargeted to the default branch first)
// and are then closed with "Landed in #N". The rules it carries are merge_when_green's: maintain or
// admin only, never a draft, never anything not green, squash with --match-head-commit, the subject
// "Title (#N)" within 72 characters, no attribution lines, never force anything.
import { canMerge, NO_PERMISSION, squashMessage } from './ci.mjs'
import { short } from './util.mjs'

/** What an item can be in. The first three are active (the driver polls them); the last two are done. */
export const STATES = ['waiting', 'ci', 'attention', 'merged', 'closed']
export const ACTIVE = new Set(['waiting', 'ci', 'attention'])
/** The squash subject's limit, in characters (docs/commit-conventions.md). */
export const SUBJECT_MAX = 72
/** How long after a poll the item is read again, by what it is waiting on. */
export const POLL_MS = { waiting: 15_000, ci: 90_000, acted: 60_000, attention: 120_000, error: 60_000 }
/** No run started on a head for this long: CI did not start, which is the session's to look at. */
export const NO_CI_MS = 15 * 60_000
/** A rerun asked for that GitHub has not started after this long. */
export const RERUN_STUCK_MS = 10 * 60_000
/** A required check not reported while nothing else runs (a renamed job, a path-filtered workflow). */
export const MISSING_MS = 20 * 60_000
/** Green, but GitHub has not said CLEAN for this long (UNSTABLE, HAS_HOOKS, UNKNOWN). */
export const UNCLEAN_MS = 30 * 60_000
/** Failures in a row on one item, other than an outage, before the session hears about it. */
export const ERROR_LIMIT = 3
export const MAX_EVENTS = 200
export const MAX_DONE = 40
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])
// An unattended queue is strict: CLEAN only. UNSTABLE (a check outside the required set failed) and
// HAS_HOOKS wait, and say so after UNCLEAN_MS.
const MERGEABLE_STATES = new Set(['CLEAN'])

export const emptyQueue = () => ({ version: 1, seq: 0, pause: null, items: [], events: [], batches: [], batchSeq: 0, batchOff: null })
/** A batch's states that are still running; one at a time is driven (batch.mjs has the batch rules). */
export const BATCH_ACTIVE = new Set(['building', 'ci', 'landing'])

/** A queue read from the file, with every field present (an older or hand-edited file still reads). */
export function normalize(q) {
  const base = emptyQueue()
  if (!q || typeof q !== 'object') return base
  const batches = Array.isArray(q.batches) ? q.batches.filter((b) => b && Number.isInteger(b.id) && typeof b.repo === 'string' && Array.isArray(b.members)).map((b) => ({ steps: [], cancelled: [], reruns: {}, landed: 0, ...b })) : []
  const running = new Set(batches.filter((b) => BATCH_ACTIVE.has(b.state)).map((b) => b.id))
  return {
    ...base,
    ...q,
    seq: Number.isFinite(q.seq) ? q.seq : 0,
    batchSeq: Number.isInteger(q.batchSeq) ? q.batchSeq : Math.max(0, ...batches.map((b) => b.id)),
    batches,
    items: Array.isArray(q.items)
      ? q.items
          .filter((i) => i && Number.isInteger(i.pr) && typeof i.repo === 'string')
          .map((i) => {
            const it = { ...i, lowers: Array.isArray(i.lowers) ? i.lowers.filter(Number.isInteger) : [], reruns: i.reruns && typeof i.reruns === 'object' ? i.reruns : {} }
            // In a batch that is no longer running (an older file, a batch dropped by hand): its own again
            if (it.batch != null && !running.has(it.batch)) delete it.batch
            return it
          })
      : [],
    events: Array.isArray(q.events) ? q.events : [],
  }
}

export const keyOf = (repo, pr) => `${String(repo).toLowerCase()}#${pr}`
export const itemKey = (item) => keyOf(item.repo, item.pr)
export const findItem = (q, repo, pr) => q.items.find((i) => itemKey(i) === keyOf(repo, pr) && ACTIVE.has(i.state)) ?? null
const refIn = (defaultRepo) => (repo, n) => (String(repo).toLowerCase() === String(defaultRepo).toLowerCase() ? `#${n}` : `${repo}#${n}`)

/** Adds an event; `notify` ones are what the queuing session hears about. Keeps the last MAX_EVENTS. */
export function pushEvent(q, item, { kind, text, notify = false, at }) {
  q.seq += 1
  q.events.push({ seq: q.seq, at, repo: item.repo, pr: item.pr, owner: item.owner ?? null, kind, notify, text })
  if (q.events.length > MAX_EVENTS) q.events.splice(0, q.events.length - MAX_EVENTS)
  return q.seq
}

/**
 * Queues a pull request (or a stack through its top). Queuing one already queued replaces its lowers,
 * owner and branch setting. A pull request may be in one active item only, as a top or a lower.
 * Answers `{ item, replaced }`, or `{ error }` and changes nothing.
 */
export function enqueue(q, { repo, pr, lowers = [], owner = null, deleteBranch = true, title = null, at }, ref = refIn(repo)) {
  const mine = findItem(q, repo, pr)
  for (const other of q.items.filter((i) => ACTIVE.has(i.state) && i !== mine && String(i.repo).toLowerCase() === String(repo).toLowerCase())) {
    if (other.lowers.includes(pr)) return { error: `${ref(repo, pr)} is already queued under ${ref(other.repo, other.pr)}.` }
    const both = lowers.filter((l) => l === other.pr || other.lowers.includes(l))
    if (both.length) return { error: `${both.map((n) => ref(repo, n)).join(', ')} ${both.length === 1 ? 'is' : 'are'} already queued with ${ref(other.repo, other.pr)}.` }
  }
  if (mine) {
    // Queued again (what an attention message may ask for): it is looked at afresh, so its clocks
    // and failure count start again and a merge GitHub refused is tried again; reruns already spent
    // on this head stay spent. Queued again without an owner, it stays the first session's
    Object.assign(mine, {
      lowers,
      owner: owner ?? mine.owner,
      deleteBranch,
      state: 'waiting',
      reason: null,
      noticeKey: null,
      noCiSince: null,
      missingSince: null,
      uncleanSince: null,
      errors: 0,
      updatedAt: at,
      nextAt: at,
    })
    // Out of any batch it was in (the batch sees it gone and carries on without it)
    delete mine.batch
    delete mine.batchless
    pushEvent(q, mine, { kind: 'queued', text: `${ref(repo, pr)} queued again${lowers.length ? ` with ${lowers.map((n) => ref(repo, n)).join(', ')}` : ''}.`, at })
    return { item: mine, replaced: true }
  }
  const item = {
    repo,
    pr,
    lowers,
    owner,
    deleteBranch,
    title,
    state: 'waiting',
    queuedAt: at,
    updatedAt: at,
    nextAt: at,
    head: null,
    reason: null,
    noticeKey: null,
    noCiSince: null,
    reruns: {},
    required: null,
    lastError: null,
  }
  q.items.push(item)
  pushEvent(q, item, { kind: 'queued', text: `${ref(repo, pr)} queued${lowers.length ? ` with ${lowers.map((n) => ref(repo, n)).join(', ')}` : ''}.`, at })
  // Finished items are history: keep the latest few
  const done = q.items.filter((i) => !ACTIVE.has(i.state))
  if (done.length > MAX_DONE) {
    const drop = new Set(done.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(0, done.length - MAX_DONE))
    q.items = q.items.filter((i) => !drop.has(i))
  }
  return { item, replaced: false }
}

/** Takes an active item out of the queue. Answers the item, or null when it was not queued. */
export function dequeue(q, { repo, pr, at }, ref = refIn(repo)) {
  const item = findItem(q, repo, pr)
  if (!item) return null
  q.items = q.items.filter((i) => i !== item)
  pushEvent(q, item, { kind: 'removed', text: `${ref(repo, pr)} taken out of the queue.`, at })
  return item
}

/** The item due first (its `nextAt` passed), or null. An item in a batch is the batch's to read. */
export function dueItem(q, now) {
  return q.items.filter((i) => ACTIVE.has(i.state) && i.batch == null && Date.parse(i.nextAt ?? 0) <= now).sort((a, b) => Date.parse(a.nextAt ?? 0) - Date.parse(b.nextAt ?? 0))[0] ?? null
}

// --- The decision for one poll -------------------------------------------------------------------

const attention = (kind, text, extra = {}) => ({ state: 'attention', reason: { kind, text, ...extra } })

/**
 * What GitHub says before CI matters: who is asking, whether it is still open, a draft, or conflicting.
 * Answers a decision, or null to go on to the checks. `head` is the pull request's head now; a head
 * other than the one the item knew resets what was done for the old one (`reset`).
 */
export function decideBefore({ item, permissions, pr, defaultBranch, ref }) {
  const n = ref(item.repo, item.pr)
  if (!canMerge(permissions)) return attention('permission', `${NO_PERMISSION.reason} The queue merges nothing for this account; unqueue ${n}.`)
  // Landed only into the default branch: merged into a lower's branch, its lowers are not landed
  if (pr.state === 'MERGED') return { state: 'merged', landed: pr.baseRefName === defaultBranch }
  if (pr.state !== 'OPEN') return { state: 'closed' }
  if (pr.isDraft) return attention('draft', `${n} is a draft, and the queue never merges a draft. Mark it ready for review; the queue carries on by itself.`)
  if (pr.mergeStateStatus === 'DIRTY' || pr.mergeable === 'CONFLICTING')
    return attention(
      'dirty',
      `${n} conflicts with ${pr.baseRefName} (GitHub: DIRTY) at ${short(pr.headRefOid)}. Rebase it onto ${pr.baseRefName} and push (rebase_stack if the PR under it merged); the queue takes the new head by itself.`,
    )
  return null
}

/** The fields that start again when the head moved: reruns, the no-CI clock, the required set. */
export function resetFor(item, head) {
  if (item.head === head) return {}
  return { head, reruns: {}, noCiSince: null, missingSince: null, uncleanSince: null, required: null }
}

/**
 * What CI says about one commit, for an item's head or a batch's (`subject`: anything with `head`,
 * `reruns`, `noCiSince` and `missingSince`). `checks` is evaluateChecks' answer for `head`; `runs`
 * the latest run of each CI workflow on it. Answers `{ state: 'green' }`, or a decision as decideCi's
 * (`ci` with a rerun to ask for, or attention); `n` names the subject in the texts.
 */
export function decideRun({ subject, head, checks, runs = [], now, n }) {
  const at = new Date(now).toISOString()
  const reruns = subject.head === head ? (subject.reruns ?? {}) : {}
  const verdict = checks.verdict
  const failedJobs = checks.rows.filter((r) => r.state === 'failed')
  const job = failedJobs[0] ? { name: failedJobs[0].name, id: failedJobs[0].check?.jobId ?? null } : null
  const jobText = (j) => (j ? `"${j.name}"${j.id ? ` (job ${j.id})` : ''}` : 'a required check')

  if (verdict === 'failing') {
    if (runs.some((r) => r.status !== 'completed')) return { state: 'ci' } // a rerun starts only on a finished run
    const bad = runs.find((r) => !OK_CONCLUSIONS.has(r.conclusion))
    if (!bad)
      return attention('failing', `${n}: required check ${jobText(job)} failed at ${short(head)}, outside a run the queue can rerun. Look with ci_status; fix and push, and the queue takes the new head.`, { job })
    const kind = bad.conclusion === 'cancelled' ? 'cancelled' : 'failed'
    const done = reruns[kind]
    // GitHub refused the rerun (a run too old, a permission): asking again would only fail again
    if (done?.error && done.run === bad.id && bad.attempt <= done.attempt) return rerunRefused(n, bad.id, done.error)
    if (done && done.run === bad.id && bad.attempt <= done.attempt) {
      // Asked for already, and GitHub has not started it yet
      if (now - Date.parse(done.at) > RERUN_STUCK_MS) return attention('rerun-stuck', `${n}: the rerun of run ${bad.id} asked for at ${done.at.slice(11, 16)} UTC has not started. Look at the run on GitHub, or push again.`)
      return { state: 'ci' }
    }
    if (!done) {
      const failedOnly = kind === 'failed'
      return {
        state: 'ci',
        action: { type: 'rerun', runId: bad.id, failedOnly, kind },
        patch: { reruns: { ...reruns, [kind]: { run: bad.id, attempt: bad.attempt, at } } },
        event: `${n}: run ${bad.id} ${kind === 'cancelled' ? 'was cancelled; rerunning it' : `failed (${jobText(job)}); rerunning its failed jobs`} once for ${short(head)}.`,
      }
    }
    if (kind === 'cancelled')
      return attention('cancelled', `${n}: CI run ${bad.id} was cancelled again after one rerun at ${short(head)}. Look at why on GitHub (a newer run, a timeout), then push again or rerun it yourself.`)
    return attention(
      'failed',
      `${n}: required check ${jobText(job)} failed twice at ${short(head)} (once more after rerunning the failed jobs). Read it with read_failed_job${job?.id ? ` (job ${job.id})` : ''} or ci_status; fix and push, and the queue takes the new head.`,
      { job },
    )
  }

  if (verdict === 'none' || verdict === 'pending') {
    if (verdict === 'none' && !runs.length) {
      const since = subject.head === head && subject.noCiSince ? subject.noCiSince : at
      if (now - Date.parse(since) > NO_CI_MS)
        return attention('no-ci', `${n}: no CI run has started on ${short(head)} in ${Math.round(NO_CI_MS / 60_000)} minutes. Push again, or start the build on GitHub; the queue carries on once checks report.`)
      return { state: 'ci', patch: { noCiSince: since } }
    }
    // A required check not reported while nothing runs will not report by itself
    const missing = checks.rows.filter((r) => r.state === 'missing')
    const running = checks.rows.some((r) => r.state === 'pending') || runs.some((r) => r.status !== 'completed')
    if (!missing.length || running) return { state: 'ci', patch: { noCiSince: null, missingSince: null } }
    const since = subject.head === head && subject.missingSince ? subject.missingSince : at
    if (now - Date.parse(since) > MISSING_MS)
      return attention(
        'missing-check',
        `${n}: required check${missing.length === 1 ? '' : 's'} ${missing.map((r) => `"${r.name}"`).join(', ')} never reported on ${short(head)}, and nothing else is running (a renamed job, or a workflow its paths filter skipped). Fix the workflow or the required set, then push.`,
      )
    return { state: 'ci', patch: { noCiSince: null, missingSince: since } }
  }

  if (verdict !== 'green') return attention('internal', `${n}: unknown CI verdict ${verdict}.`)
  return { state: 'green' }
}

/**
 * The decision once CI is read. `checks` is evaluateChecks' answer for the head; `runs` the latest
 * run of each CI workflow on it (only read when the checks failed or none are reported);
 * `lowerBranches` the head branches of the item's lowers (a stack's top is based on one of them).
 * Answers `{ state, action?, reason?, patch? }`; action `rerun` (a run, all jobs or the failed ones),
 * `retarget` (onto the default branch) or `merge`.
 */
export function decideCi({ item, pr, checks, runs = [], defaultBranch, lowerBranches = [], now, ref }) {
  const n = ref(item.repo, item.pr)
  const head = pr.headRefOid
  const at = new Date(now).toISOString()
  const run = decideRun({ subject: item, head, checks, runs, now, n })
  if (run.state !== 'green') return run

  if (pr.baseRefName !== defaultBranch) {
    if (lowerBranches.includes(pr.baseRefName)) return { state: 'waiting', action: { type: 'retarget', base: defaultBranch }, event: `${n}: green; moved its base from ${pr.baseRefName} to ${defaultBranch} to land the stack through it.` }
    return attention(
      'base',
      `${n} is based on ${pr.baseRefName}, not ${defaultBranch}, and no PR queued under it has that branch. Queue it again with the PRs under it as lowers, or rebase it onto ${defaultBranch}.`,
    )
  }
  const subject = squashMessage({ number: pr.number, title: pr.title, description: pr.body }).subject
  if ([...subject].length > SUBJECT_MAX)
    return attention('subject', `${n}: the squash subject "${subject}" is ${[...subject].length} characters, over ${SUBJECT_MAX}. Shorten the PR title; the queue carries on by itself.`)
  if (pr.mergeStateStatus === 'BEHIND') return attention('behind', `${n} is behind ${defaultBranch}, and GitHub requires it up to date. Rebase it onto ${defaultBranch} and push.`)
  if (pr.mergeStateStatus === 'BLOCKED') return attention('blocked', `${n} is green, but GitHub blocks merging it (a required review or rule). Look at the PR on GitHub.`)
  if (pr.mergeable !== 'MERGEABLE' || !MERGEABLE_STATES.has(pr.mergeStateStatus)) {
    // GitHub still working it out (UNKNOWN), or not CLEAN (UNSTABLE, HAS_HOOKS): wait, and say so in time
    const since = item.head === head && item.uncleanSince ? item.uncleanSince : at
    if (now - Date.parse(since) > UNCLEAN_MS)
      return attention(
        'not-clean',
        `${n} is green, but GitHub has said ${pr.mergeStateStatus ?? 'nothing'} (not CLEAN) for ${Math.round(UNCLEAN_MS / 60_000)} minutes, and the queue merges only CLEAN. UNSTABLE: a check outside the required set failed; rerun or fix it.`,
      )
    return { state: 'waiting', patch: { uncleanSince: since } }
  }
  return { state: 'ci', action: { type: 'merge' }, patch: { uncleanSince: null, missingSince: null } }
}

/** A rerun GitHub refused, as attention: the run, and what GitHub said. */
export function rerunRefused(n, runId, error) {
  return attention('rerun-refused', `${n}: GitHub refused to rerun run ${runId}: ${error}. Rerun it yourself, or push again; the queue takes the new head.`)
}

/** A poll that failed ERROR_LIMIT times in a row on one item (not an outage), as attention. */
export function errorReason(n, count, message) {
  return { kind: 'error', text: `${n} could not be read or acted on ${count} times in a row: ${message} Look at it on GitHub; unqueue it if it is gone.` }
}

/** The key that makes "one message per change": the same reason on the same head is not news. */
export const noticeKey = (reason, head) => `${reason.kind}:${head ?? ''}:${reason.job?.id ?? reason.job?.name ?? ''}`

/** The text the queuing session gets for an item that needs it. */
export function attentionText(item, reason, ref = refIn(item.repo)) {
  const title = item.title ? ` (${item.title})` : ''
  return `Merge queue: ${ref(item.repo, item.pr)}${title} needs attention: ${reason.kind}. ${reason.text} Or take it out with unqueue.`
}

/** One line for an item in answers and on the screen. */
export function itemLine(item, ref = refIn(item.repo)) {
  const stack = item.lowers?.length ? ` (stack over ${item.lowers.map((l) => ref(item.repo, l)).join(', ')})` : ''
  const title = item.title ? ` ${item.title}` : ''
  const what =
    item.state === 'attention'
      ? `needs attention: ${item.reason?.kind ?? '?'} — ${item.reason?.text ?? ''}`
      : item.state === 'ci' && item.batch != null
        ? `CI in batch ${item.batch}${item.head ? ` at ${short(item.head)}` : ''}`
        : item.state === 'ci'
          ? `CI${item.head ? ` at ${short(item.head)}` : ''}${item.lastError ? `; last poll failed: ${item.lastError}` : ''}`
        : item.state === 'waiting'
          ? `waiting${item.lastError ? `; last poll failed: ${item.lastError}` : ''}`
          : item.state === 'merged'
            ? `merged${item.commit ? ` as ${short(item.commit)}` : ''}`
            : 'closed without merging'
  return `${ref(item.repo, item.pr)}${title}${stack} — ${what}`
}
