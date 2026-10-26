// The merge queue's decisions and records (#956), as pure functions: no gh, no files, no clock of its
// own. queue-driver.mjs reads GitHub and the queue file and asks these what to do; queue-tools.mjs
// answers the tools from the same records.
//
// One item is one pull request, or a stack: `pr` is its top and `lowers` the pull requests under it,
// which land with it as one squash commit through the top (retargeted to the default branch first)
// and are then closed with "Landed in #N". The rules it carries are merge_when_green's: maintain or
// admin only, never a draft, never anything not green, squash with --match-head-commit, the subject
// "Title (#N)" within 72 characters, no attribution lines, never force anything.
//
// Two tiers of CI (project.json `ci.fullTier`, 2026-10-18): a pull request's own run is the quick tier,
// which lands nothing. An item lands from a run on what lands (the full tier, or the fast tier under `ci.landTier` quick, and the
// heavy jobs too when its batch changes the screen, #1538): a batch (queue-batch.mjs), a batch
// of one included, or its own head's full run (a release bump's, or one a person started on its
// branch). An item whose quick tier passed waits for a batch; one that cannot be batched, or whose
// batch of one ended without landing it, needs its session.
import { canMerge, NO_PERMISSION, quickTierReason, ranTier, squashMessage } from './ci.mjs'
import { CAUSE_TEXT, onFlakyList } from './run-failure.mjs'
import { isAcked } from './notice-acks.mjs'
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
/** How long the full tier the queue started on a branch it cannot batch may take to report before it says so (#1509 item 4) */
export const FULL_START_MS = 15 * 60_000
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
// An unattended queue is strict: CLEAN, and UNSTABLE only where the queue can prove why (runs a
// successful one made moot, #1015; runs a batch cancelled, batch.mjs). Any other UNSTABLE and
// HAS_HOOKS wait, and say so after UNCLEAN_MS.
const MERGEABLE_STATES = new Set(['CLEAN'])

export const emptyQueue = () => ({ version: 1, seq: 0, acksFrom: 0, pause: null, items: [], events: [], batches: [], batchSeq: 0, batchOff: null })
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
    // A file from before acknowledging (#1351, notice-acks.mjs): what it already said counts as acknowledged
    acksFrom: Number.isInteger(q.acksFrom) ? q.acksFrom : Number.isFinite(q.seq) ? q.seq : 0,
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

/**
 * The queue's order (#1182): items fixed after a conflict first (`front`, when they were fixed, the
 * earliest first), then the rest as they were queued. Without it a pull request fixed after a
 * conflict waited again behind everything queued since.
 */
export const queueOrder = (a, b) => (a.front ? 0 : 1) - (b.front ? 0 : 1) || String(a.front ?? a.queuedAt).localeCompare(String(b.front ?? b.queuedAt))

export const keyOf = (repo, pr) => `${String(repo).toLowerCase()}#${pr}`
export const itemKey = (item) => keyOf(item.repo, item.pr)
export const findItem = (q, repo, pr) => q.items.find((i) => itemKey(i) === keyOf(repo, pr) && ACTIVE.has(i.state)) ?? null
const refIn = (defaultRepo) => (repo, n) => (String(repo).toLowerCase() === String(defaultRepo).toLowerCase() ? `#${n}` : `${repo}#${n}`)

/**
 * Adds an event; `notify` ones are what the queuing session hears about. Keeps the last MAX_EVENTS.
 * `data` adds fields of its own: a conflict's `step` and `ms` (how long it took), a hand-off's `relay`.
 * A message for the session whose item has a notice address (#1161 item 1) carries it as `to`: the server posts it
 * into that session (queue-tools.mjs `tellSessions`) and marks it `told`.
 */
export function pushEvent(q, item, { kind, text, notify = false, at, data = null, to: addressed = null }) {
  q.seq += 1
  // A message for another session than the item's owner is not the owner's news: `watch` for the owner never prints it
  const owner = addressed ? null : (item.owner ?? null)
  // `addressed`: a session other than the item's owner, with its own notice address (the author of a conflicting pull request)
  const address = addressed ?? item.notice
  const to = notify && address ? { to: address } : {}
  q.events.push({ seq: q.seq, at, repo: item.repo, pr: item.pr, owner, kind, notify, text, ...(data ?? {}), ...to })
  if (q.events.length > MAX_EVENTS) q.events.splice(0, q.events.length - MAX_EVENTS)
  return q.seq
}

/**
 * Queues a pull request (or a stack through its top). Queuing one already queued replaces its lowers,
 * owner, author and branch setting. A pull request may be in one active item only, as a top or a lower.
 * `owner` is the session that queued it (it hears the queue's news); `author` the session that opened
 * or owns the pull request, which a conflict is handed to (#1182), or null when none is known. `notice` is the
 * queuing session's notice address (#1161 item 1), where its news is posted; queued again without one, it keeps
 * the first.
 * Answers `{ item, replaced }`, or `{ error }` and changes nothing.
 */
export function enqueue(q, { repo, pr, lowers = [], owner = null, author = null, notice = null, deleteBranch = true, title = null, at }, ref = refIn(repo)) {
  const mine = findItem(q, repo, pr)
  for (const other of q.items.filter((i) => ACTIVE.has(i.state) && i !== mine && String(i.repo).toLowerCase() === String(repo).toLowerCase())) {
    if (other.lowers.includes(pr)) return { error: `${ref(repo, pr)} is already queued under ${ref(other.repo, other.pr)}.` }
    const both = lowers.filter((l) => l === other.pr || other.lowers.includes(l))
    if (both.length) return { error: `${both.map((n) => ref(repo, n)).join(', ')} ${both.length === 1 ? 'is' : 'are'} already queued with ${ref(other.repo, other.pr)}.` }
  }
  if (mine) {
    // Queued again (what an attention message may ask for): it is looked at afresh, so its clocks
    // and failure count start again and a merge GitHub refused is tried again; reruns already spent
    // on this head stay spent. Queued again without an owner or an author, it keeps the first ones
    Object.assign(mine, {
      lowers,
      owner: owner ?? mine.owner,
      author: author ?? mine.author ?? null,
      notice: notice ?? mine.notice ?? null,
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
    // A conflict on this head is merged again (main may have moved); when it was found stays known.
    // Queued again after a conflict, it goes to the front, not behind everything queued since
    if (mine.conflict) {
      mine.conflict = { ...mine.conflict, outcome: 'again', reason: null }
      mine.front = mine.front ?? at
    }
    // Out of any batch it was in (the batch sees it gone and carries on without it)
    delete mine.batch
    delete mine.batchless
    delete mine.alone
    delete mine.moved
    pushEvent(q, mine, { kind: 'queued', text: `${ref(repo, pr)} queued again${lowers.length ? ` with ${lowers.map((n) => ref(repo, n)).join(', ')}` : ''}.`, at })
    return { item: mine, replaced: true }
  }
  const item = {
    repo,
    pr,
    lowers,
    owner,
    author,
    notice,
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
  // A record handed over with integrate is a draft on purpose until it lands (#1259 step 3, queue-integrate.mjs)
  if (pr.isDraft && !item.auto) return attention('draft', `${n} is a draft, and the queue never merges a draft. Mark it ready for review; the queue carries on by itself.`)
  // A conflict: the driver merges the default branch in itself, or hands it to the author (#1182)
  if (pr.mergeStateStatus === 'DIRTY' || pr.mergeable === 'CONFLICTING')
    return attention(
      'dirty',
      `${n} conflicts with ${pr.baseRefName} (GitHub: DIRTY) at ${short(pr.headRefOid)}. Rebase it onto ${pr.baseRefName} and push (rebase_stack if the PR under it merged); the queue takes the new head by itself.`,
    )
  return null
}

/**
 * Why the queue does not merge the base into a conflicting pull request itself (#1182), or null when
 * it may: only into a branch of this repository (a fork's is its author's to push), and only the
 * default branch (a stack's top based on a lower's branch is restacked, rebase_stack).
 */
export function cannotMergeBase(pr, defaultBranch) {
  if (pr.isCrossRepository) return `It is a fork's branch, which the queue does not push to.`
  if (pr.baseRefName !== defaultBranch) return `It is based on ${pr.baseRefName}, not ${defaultBranch}, so the queue leaves it to its stack (rebase_stack, once the PR under it has merged).`
  return null
}

/** The instruction for the session that fixes a conflict: what to merge, and the files. */
export function conflictInstruction({ base, branch, files }) {
  return `Merge ${base} into ${branch} and push again; conflicted files: ${files.length ? files.join(', ') : 'not known (GitHub says it conflicts)'}.`
}

/**
 * Where a conflict goes (#1509 item 4): the queuing session when it is the author (`self`: the author is the owner, or
 * the session that opened the pull request through `open_pr` is the one that queued it); the session that opened it
 * through `open_pr` when that is another (`direct`, `to` its notice address, which `open_pr` noted, opened.mjs); else
 * the queuing session relays it (`relay`), as before. `opened` is `openedBy`'s record, or null.
 */
export function authorRoute(item, opened = null) {
  const opener = opened?.notice ?? null
  if (opener && item.notice && opener === item.notice) return { route: 'self', to: item.notice }
  if (opener) return { route: 'direct', to: opener }
  if (item.author && item.author === item.owner) return { route: 'self', to: item.notice ?? null }
  return { route: 'relay', to: null }
}

/**
 * A conflict the queue hands to the pull request's author session (#1182): kind `conflict`, the
 * files, and `relay` (`to`: the author session, or null when none is recorded; `text`: the exact
 * instruction). Where the instruction goes depends on `route` (`authorRoute`): `self`, the queuing session is the
 * author, so it fixes it there; `direct`, the author is another session that opened the pull request through this
 * app, and the queue posts the instruction into it itself; `relay`, the author is named but the queue has no address
 * for it, and the queuing session relays the instruction. With no author recorded, it says so and that a session
 * started on the branch needs that instruction.
 */
export function handoffReason({ item, pr, files = [], why, ref, instruction = null, route = 'relay' }) {
  const n = ref(item.repo, item.pr)
  const branch = pr.headRefName
  const text = instruction ?? conflictInstruction({ base: pr.baseRefName, branch, files })
  const author = item.author ?? null
  const where = files.length ? ` in ${files.length > 8 ? `${files.slice(0, 8).join(', ')} and ${files.length - 8} more` : files.join(', ')}` : ''
  // The text names the session the route uses, not the one `queue_merge author` named when that is another (authorRoute
  // goes by who opened the pull request): a named author the route does not use is said beside it
  const named = author ? ` (queue_merge named ${author} as its author)` : ''
  const to =
    route === 'self'
      ? `${n} is your own pull request${author && author === item.owner ? ` (author session: ${author})` : named}: fix it in this session: "${text}"`
      : route === 'direct'
        ? `Author session: the session that opened it${named}. The queue is posting this into it itself, so relay it only if it does not answer: "${text}"`
        : author
          ? `Author session: ${author}. Relay this to it (it has not called this app, so the queue has no address to post to): "${text}"`
          : `No author session is recorded for ${n} (queue_merge author). Start a session on its branch ${branch} with this instruction: "${text}"`
  // `relay.to` is who the instruction is for: the session the queue posts to, this one, or the one the queuing session relays to
  const who = route === 'direct' ? 'the session that opened it' : route === 'self' ? (item.owner ?? author ?? 'the queuing session') : author
  return {
    state: 'attention',
    reason: { kind: 'conflict', text: `${n} conflicts with ${pr.baseRefName} at ${short(pr.headRefOid)}${where}. ${why} ${to} The queue takes the new head by itself, at the front of the queue.`, files, relay: { to: who, branch, text, route } },
  }
}

/** The fields that start again when the head moved: reruns, the no-CI clock, the required set. */
export function resetFor(item, head) {
  if (item.head === head) return {}
  return { head, reruns: {}, failures: {}, noCiSince: null, missingSince: null, uncleanSince: null, required: null, fullDispatch: null }
}

/**
 * What CI says about one commit, for an item's head or a batch's (`subject`: anything with `head`,
 * `reruns`, `noCiSince` and `missingSince`). `checks` is evaluateChecks' answer for `head`; `runs`
 * the latest run of each CI workflow on it; `failures` why each finished run that did not pass
 * failed, by run id (run-failure.mjs classifyRun, which the driver reads from the run's jobs and
 * steps). Answers `{ state: 'green' }`, or a decision as decideCi's (`ci` with a rerun to ask for,
 * or attention); `n` names the subject in the texts.
 *
 * The rerun policy (the owner, 2026-10-19): a real failure (a job failed in a step: a test or a
 * build) is never rerun and needs attention at once, also in a run CI cancelled because of it (fail
 * fast). Only an infrastructure failure is rerun, once per head: a run cancelled with no failed job,
 * a job that hit its timeout, a lost runner, a job on project.json's known-flaky list.
 */
export function decideRun({ subject, head, checks, runs = [], failures = {}, now, n }) {
  const at = new Date(now).toISOString()
  const reruns = subject.head === head ? (subject.reruns ?? {}) : {}
  const verdict = checks.verdict
  const failedJobs = checks.rows.filter((r) => r.state === 'failed')
  const firstJob = failedJobs[0] ? { name: failedJobs[0].name, id: failedJobs[0].check?.jobId ?? null } : null
  const jobText = (j) => (j ? `"${j.name}"${j.id ? ` (job ${j.id})` : ''}` : 'a required check')

  if (verdict === 'failing') {
    if (runs.some((r) => r.status !== 'completed')) return { state: 'ci' } // a rerun starts only on a finished run
    const bad = runs.find((r) => !OK_CONCLUSIONS.has(r.conclusion))
    if (!bad)
      return attention('failing', `${n}: required check ${jobText(firstJob)} failed at ${short(head)}, outside a run the queue can rerun. Look with ci_status; fix and push, and the queue takes the new head.`, { job: firstJob })
    const why = runFailure(bad, failures, failedJobs)
    const job = why.job ?? firstJob
    const cause = CAUSE_TEXT[why.cause] ?? why.cause
    const kind = bad.conclusion === 'cancelled' ? 'cancelled' : 'failed'
    const done = reruns[kind]
    // GitHub refused the rerun (a run too old, a permission): asking again would only fail again
    if (done?.error && done.run === bad.id && bad.attempt <= done.attempt) return rerunRefused(n, bad.id, done.error)
    if (done && done.run === bad.id && bad.attempt <= done.attempt) {
      // Asked for already, and GitHub has not started it yet
      if (now - Date.parse(done.at) > RERUN_STUCK_MS) return attention('rerun-stuck', `${n}: the rerun of run ${bad.id} asked for at ${done.at.slice(11, 16)} UTC has not started. Look at the run on GitHub, or push again.`)
      return { state: 'ci' }
    }
    // A test or a build that failed fails again: no rerun, the session hears at once
    if (why.real)
      return attention(
        'failed',
        `${n}: ${jobText(job)} failed at ${short(head)} with ${cause}${why.step ? ` (step "${why.step}")` : ''}${kind === 'cancelled' ? `, and CI cancelled the rest of run ${bad.id} (fail fast)` : ''}. The queue reruns only infrastructure failures. Read it with read_failed_job${job?.id ? ` (job ${job.id})` : ''} or ci_status; fix and push, and the queue takes the new head.`,
        { job },
      )
    if (!done) {
      const failedOnly = kind === 'failed'
      return {
        state: 'ci',
        action: { type: 'rerun', runId: bad.id, failedOnly, kind },
        patch: { reruns: { ...reruns, [kind]: { run: bad.id, attempt: bad.attempt, at } } },
        event: `${n}: run ${bad.id} ${kind === 'cancelled' ? `was cancelled (${cause}${why.job ? `: ${jobText(why.job)}` : ''}); rerunning it` : `failed (${jobText(job)}: ${cause}); rerunning its failed jobs`} once for ${short(head)}.`,
      }
    }
    if (kind === 'cancelled')
      return attention('cancelled', `${n}: CI run ${bad.id} was cancelled again after one rerun at ${short(head)} (${cause}). Look at why on GitHub (a newer run, a timeout), then push again or rerun it yourself.`)
    return attention(
      'failed',
      `${n}: required check ${jobText(job)} failed twice at ${short(head)} (once more after rerunning the failed jobs; this time ${cause}). Read it with read_failed_job${job?.id ? ` (job ${job.id})` : ''} or ci_status; fix and push, and the queue takes the new head.`,
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
 * Why `run` failed: the driver's reading of its jobs (`failures[run.id]`, for this attempt), else what
 * the checks show: a cancelled run with a job that failed is a real failure (fail fast), one without
 * is cancelled, and any other is real (the queue reruns nothing it cannot name as infrastructure).
 */
function runFailure(run, failures, failedJobs) {
  const f = failures?.[run.id]
  if (f && (f.attempt ?? 1) === (run.attempt ?? 1)) return f
  const job = (r) => (r ? { name: r.name, id: r.check?.jobId ?? null } : null)
  const failed = failedJobs.find((r) => r.check?.conclusion === 'failure')
  if (run.conclusion === 'cancelled') return failed ? { real: true, cause: 'test', job: job(failed) } : { real: false, cause: 'cancelled', job: null }
  return { real: true, cause: 'test', job: job(failed ?? failedJobs[0]) }
}

/**
 * The decision once CI is read. `checks` is evaluateChecks' answer for the head; `runs` the latest
 * run of each CI workflow on it (only read when the checks failed or none are reported);
 * `lowerBranches` the head branches of the item's lowers (a stack's top is based on one of them);
 * `supersededOnly` that GitHub's UNSTABLE comes only from runs a successful one made moot
 * (onlySupersededFailures). Answers `{ state, action?, reason?, patch? }`; action `rerun` (a run, all jobs or the failed ones),
 * `retarget` (onto the default branch) or `merge`.
 */
export function decideCi({ item, pr, checks, runs = [], failures = {}, defaultBranch, lowerBranches = [], supersededOnly = false, now, ref, fullTier = null, canBatch = false, landTier = 'full' }) {
  const n = ref(item.repo, item.pr)
  const head = pr.headRefOid
  const at = new Date(now).toISOString()
  // It failed alone in a batch on this head (queue-batch.mjs): that full run is the answer, whatever
  // its own quick run says (cancelled for the batch, it would otherwise be rerun to say nothing new)
  if (item.alone?.head === head && item.alone.reason) return { state: 'attention', reason: item.alone.reason }
  // Handed over with integrate (#1259 step 3): a draft, whose own run is only CI's changes job, so it lands through a
  // batch alone (the quick tier on what lands), never from its own run
  if (item.auto) {
    if (!canBatch) return attention('batch', `${n} was handed over with integrate, which lands only through a batch (the quick tier on ${defaultBranch}), and the queue cannot batch it (batches are off, or two tiers of CI are not set). Take it out (unqueue), mark it ready and land it with queue_merge.`)
    const alone = item.alone?.head === head ? item.alone : null
    if (alone) return attention('full-tier', `${n}'s batch of one ${ranBatch(alone)}ended without landing it: ${alone.text} Fix it and push (the queue takes the new head), or queue it again with integrate.`)
    return { state: 'ci', quick: true, patch: { noCiSince: null, missingSince: null } }
  }
  if (quickGreen(checks, runs, fullTier)) {
    const alone = item.alone?.head === head ? item.alone : null
    if (alone)
      return attention(
        'full-tier',
        `${n} passed the quick tier of CI, and ${landsFrom(landTier)}, but its batch of one ${ranBatch(alone)}ended without landing it: ${alone.text} Fix it and push (the queue takes the new head), or queue it again to try once more.`,
      )
    if (!canBatch) {
      const why = pr.isCrossRepository ? "a fork's pull request" : 'batches are off, or it is a release bump'
      // A branch of this repository: the queue starts the full tier on it itself, once per head (#1509 item 4), as the
      // reason below would have a session do by hand. A fork's branch is not run here: its code is not trusted with this
      // repository's runners and secrets
      if (!pr.isCrossRepository) {
        const sent = item.fullDispatch?.head === head ? item.fullDispatch : null
        if (!sent)
          return {
            state: 'ci',
            action: { type: 'dispatch-full', branch: pr.headRefName },
            patch: { noCiSince: null, missingSince: null, fullDispatch: { head, at } },
            event: `${n}: its quick tier passed and the queue cannot batch it (${why}); started the full tier on ${pr.headRefName}.`,
          }
        // Started: its full run reports on this head, and the merge follows when it is green
        if (sent.refused) return attention('full-tier', `${quickTierReason(n, pr.headRefName)} GitHub refused to start the full tier on ${pr.headRefName}: ${sent.refused}`)
        if (now - Date.parse(sent.at) <= FULL_START_MS) return { state: 'ci', patch: { noCiSince: null, missingSince: null } }
        return attention('full-tier', `${quickTierReason(n, pr.headRefName)} The queue started the full tier on ${pr.headRefName} at ${sent.at.slice(11, 16)} UTC, and no full run has reported on ${short(head)} in ${Math.round(FULL_START_MS / 60_000)} minutes (a run queued behind others may still be coming: look at the runs of the build workflow on the branch before starting another).`)
      }
      return attention('full-tier', `${quickTierReason(n, pr.headRefName)} The queue cannot batch it (${why}), and lands it once its own full run is green.`)
    }
    // Waits for a batch (batch.mjs batchCandidates), which runs the full tier on it
    return { state: 'ci', quick: true, patch: { noCiSince: null, missingSince: null } }
  }
  const run = decideRun({ subject: item, head, checks, runs, failures, now, n })
  if (run.state !== 'green') return run
  // Green on a required set that does not name the full tier's check, while its run goes on: not proven full yet
  if (ranTier(checks, fullTier) !== 'full') return { state: 'ci', patch: { noCiSince: null, missingSince: null } }

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
  // UNSTABLE only from a run a successful one made moot (a cancelled duplicate, #1015): as CLEAN
  const clean = MERGEABLE_STATES.has(pr.mergeStateStatus) || (pr.mergeStateStatus === 'UNSTABLE' && supersededOnly)
  if (pr.mergeable !== 'MERGEABLE' || !clean) {
    // GitHub still working it out (UNKNOWN), or not CLEAN (UNSTABLE, HAS_HOOKS): wait, and say so in time
    const since = item.head === head && item.uncleanSince ? item.uncleanSince : at
    if (now - Date.parse(since) > UNCLEAN_MS)
      return attention(
        'not-clean',
        `${n} is green, but GitHub has said ${pr.mergeStateStatus ?? 'nothing'} (not CLEAN) for ${Math.round(UNCLEAN_MS / 60_000)} minutes, and the queue merges only CLEAN (or UNSTABLE from a cancelled duplicate or an older run of CI on this head, which this is not). UNSTABLE: a check that did not pass, outside the required set or from another run; rerun or fix it.`,
      )
    return { state: 'waiting', patch: { uncleanSince: since } }
  }
  return { state: 'ci', action: { type: 'merge' }, patch: { uncleanSince: null, missingSince: null } }
}

/** What a batch lands from, for the texts: the tier `ci.landTier` names, and the heavy jobs a change to the screen adds (#1538) */
export const landsFrom = (landTier) => (landTier === 'quick' ? "lands from its batch's run (the fast tier, or the full tier when the batch changes the screen)" : 'lands only from a full run')
/** "ran the fast tier and " for a batch of one that is known to have run it, else nothing (texts about its end) */
const ranBatch = (alone) => (alone?.tier ? `ran the ${alone.tier === 'full' ? 'full' : 'fast'} tier and ` : '')

/** A finished run whose conclusion is a failure (cancelled, skipped or still going is not). */
export const FAILED_RUN = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])

/**
 * Whether a lower's own latest run on its current head stops its stack from landing (#1066): it failed,
 * and it is at least as new as the run that proved the top (`provedAt`: the top's own green run, or
 * the batch's, when it was created). Main only moves forward, so a run started later tested at least
 * as new a main: a lower failing after the top's green run is evidence the top's run missed something,
 * a flaky or runner-dependent test (#1072 under #1075, 2026-10-18: a Windows 8.3 short-name temp path
 * that failed the top the same way). A lower that failed before it is not: the top's run tested the
 * whole tree on a newer main since (#1039 under #1040: a failure from hours before, for a test main
 * had since fixed). Not knowing when the top was proved, a failure counts.
 */
export function lowerFailureCounts(run, provedAt) {
  if (!run || run.status !== 'completed' || !FAILED_RUN.has(run.conclusion)) return false
  if (!provedAt || !run.createdAt) return true
  return Date.parse(run.createdAt) >= Date.parse(provedAt)
}

/**
 * With two tiers (`fullTier`, the full tier's check name): whether a head's own CI is a finished run
 * that did not run the full tier and passed what it ran. Every run on it completed, its full tier's
 * check did not pass (skipped, or never reported by an older workflow), and no required check it
 * reported failed or is still going; the checks a quick run leaves out are not reported at all.
 */
/**
 * Whether a batch's run lands under `ci.landTier: quick` (#1259): its quick tier passed as a pull request's own
 * does (`quickGreen`), and more strictly, since this decides a landing: the full tier's check reported, skipped (a
 * run with no such check at all is not known to be the quick tier), every run concluded well (a run that failed on a
 * check outside the required rows does not land), and **each named quick check** (`quickChecks`, project.json
 * `ci.quickChecks`, `*` for any run of characters) reported and succeeded, every check its name matches: one never
 * reported (a renamed job, one a broken `changes` switched off, a Windows shard GitHub never created) or skipped does
 * not land (#1259 review). No names, nothing lands from a quick run.
 */
export function quickLanded(checks, runs, fullTier, quickChecks = []) {
  if (!quickChecks?.length) return false
  if (!quickGreen(checks, runs, fullTier) || ranTier(checks, fullTier) !== 'quick') return false
  if (!runs.every((r) => OK_CONCLUSIONS.has(r.conclusion))) return false
  const all = [...checks.rows, ...(checks.others ?? [])]
  const succeeded = (r) => !!r.check && (r.check.kind === 'status' ? r.check.state === 'success' : r.check.status === 'completed' && r.check.conclusion === 'success')
  return quickChecks.every((pattern) => {
    const named = all.filter((r) => onFlakyList(r.name, [pattern]))
    return named.length > 0 && named.every(succeeded)
  })
}

/**
 * Whether a batch that changes the screen has run the heavy jobs (#1538): the full tier ran (its check passed), every
 * run concluded well, and **each check named in `ci.screen.checks`** (`*` for any run of characters: the e2e shards of
 * both browsers) was reported and succeeded, every check its name matches. Skipped is not a pass here, whatever it
 * counts for in the required set: a shard the files left out, or one a broken `changes` switched off, is exactly
 * what must not let a batch land after the fast tier alone. No names, nothing lands.
 */
export function screenLanded(checks, runs, fullTier, screenChecks = []) {
  if (!screenChecks?.length || !fullTier || ranTier(checks, fullTier) !== 'full') return false
  if (!runs?.length || !runs.every((r) => r.status === 'completed' && OK_CONCLUSIONS.has(r.conclusion))) return false
  const all = [...checks.rows, ...(checks.others ?? [])].filter((r) => !unexpandedSkip(r.name, r.check?.conclusion))
  const succeeded = (r) => !!r.check && (r.check.kind === 'status' ? r.check.state === 'success' : r.check.status === 'completed' && r.check.conclusion === 'success')
  return screenChecks.every((pattern) => {
    const named = all.filter((r) => onFlakyList(r.name, [pattern]))
    return named.length > 0 && named.every(succeeded) && shardsComplete(named.map((r) => r.name))
  })
}

/**
 * A matrix job GitHub skipped before it expanded the matrix: it reports its name unexpanded (`e2e (chromium ${{
 * matrix.shard }}/${{ matrix.shards }})`) and skipped. build.yml's `…-skipped` stand-in of a matrix job is one on every
 * run where the real shards run (its `if:` is the other answer), so it says nothing about the shards: it is not one of
 * them, neither a pass nor a hole (queue/batch-220, run 40247598237: all ten shards passed and the batch was dropped for
 * it). A job whose matrix was expanded and then skipped has its real name, and still counts as not run.
 */
export const unexpandedSkip = (name, conclusion) => String(name ?? '').includes('${{') && conclusion === 'skipped'

/**
 * Whether the shards a heavy check's pattern names are all of them: names that end in `N/M)` (build.yml's matrix,
 * `shard: [1..M]`, `shards: [M]`) must be 1 to M, of one M. A shard GitHub never created is a hole however the others
 * did. Names without a shard number have nothing to count.
 */
export function shardsComplete(names) {
  const nums = names.map((n) => /(\d+)\/(\d+)\)$/.exec(n))
  if (nums.every((m) => !m)) return true
  if (nums.some((m) => !m)) return false
  const of = new Set(nums.map((m) => Number(m[2])))
  if (of.size !== 1) return false
  const count = [...of][0]
  const got = new Set(nums.map((m) => Number(m[1])))
  return got.size === count && [...got].every((k) => k >= 1 && k <= count)
}

export function quickGreen(checks, runs, fullTier) {
  if (!fullTier || ranTier(checks, fullTier) === 'full') return false
  if (!runs?.length || runs.some((r) => r.status !== 'completed')) return false
  return checks.verdict !== 'none' && !checks.rows.some((r) => r.state === 'failed' || r.state === 'pending')
}

/**
 * The check suites of runs a successful run has made moot (#1015): for each CI workflow that has a
 * completed, successful run on the head, its other runs on that head that were cancelled or started
 * before the newest successful one. `runs` are the raw workflow runs on the head (readWorkflowChecks).
 * With `checks` (every check on the head, readChecks), also a duplicate run whose failed jobs all passed in its twin
 * (`twinPassedSuites`, #1346).
 */
export function supersededSuites(runs, checks = []) {
  const key = (r) => r.workflow_id ?? r.path ?? r.name ?? 'ci'
  const out = new Set()
  const byWorkflow = new Map()
  for (const r of runs ?? []) byWorkflow.set(key(r), [...(byWorkflow.get(key(r)) ?? []), r])
  for (const list of byWorkflow.values()) {
    const ok = list.filter((r) => r.status === 'completed' && OK_CONCLUSIONS.has(r.conclusion))
    if (!ok.length) continue
    const newest = ok.map((r) => String(r.created_at ?? '')).sort().at(-1)
    for (const r of list)
      if (!ok.includes(r) && r.check_suite_id != null && r.status === 'completed' && (r.conclusion === 'cancelled' || String(r.created_at ?? '') < newest)) out.add(r.check_suite_id)
  }
  for (const suite of twinPassedSuites(runs, checks)) out.add(suite)
  return out
}

/**
 * The check suites of a run whose every job that did not pass **succeeded** in a twin (#1346): another completed run
 * of the same workflow on the same head, whatever their ids, creation times or attempts (the case seen: two runs
 * created in the same second, the newer one failing a job on a flake that the other passed on a rerun). The
 * older/cancelled rule above does not see it: the failing run can be the newer one. A skipped job is no twin (a draft
 * run or a quick run skips jobs a full run fails), nor is a job still running or a commit status. Only a suite whose
 * failures all have a twin that succeeded: a job that failed in both, or failed only there, keeps the head waiting.
 */
export function twinPassedSuites(runs, checks = []) {
  const key = (r) => r.workflow_id ?? r.path ?? r.name ?? 'ci'
  const workflowOf = new Map((runs ?? []).filter((r) => r.check_suite_id != null && r.status === 'completed').map((r) => [r.check_suite_id, key(r)]))
  const passed = (c) => c.kind !== 'status' && c.status === 'completed' && OK_CONCLUSIONS.has(c.conclusion)
  // What a twin must show: the job ran and succeeded (a skip is not a pass)
  const succeeded = (c) => c.kind !== 'status' && c.status === 'completed' && c.conclusion === 'success'
  const out = new Set()
  for (const [suite, workflow] of workflowOf) {
    const mine = checks.filter((c) => c.kind !== 'status' && c.suiteId === suite)
    const bad = mine.filter((c) => !passed(c))
    if (!bad.length) continue
    const twinPassed = (c) => checks.some((t) => t.suiteId !== suite && workflowOf.get(t.suiteId) === workflow && t.name === c.name && succeeded(t))
    if (bad.every(twinPassed)) out.add(suite)
  }
  return out
}

/**
 * Whether GitHub's UNSTABLE comes only from runs a successful run made moot (#1015): every check on
 * the head passed, or belongs to such a run; every commit status succeeded. A cancelled duplicate run
 * (a second pull_request run started for the same head) otherwise kept a green pull request UNSTABLE
 * for as long as its head stayed, and the queue waits for CLEAN.
 */
export function onlySupersededFailures(checks, runs) {
  const moot = supersededSuites(runs, checks)
  return checks.every((c) =>
    c.kind === 'status' ? c.state === 'success' : (c.status === 'completed' && OK_CONCLUSIONS.has(c.conclusion)) || moot.has(c.suiteId),
  )
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

/**
 * What the watch command (bin/merge-queue.mjs) sees for `owner` (null: every owner) after `after`:
 * the messages, the items still queued, and whether a batch with one of the owner's pull requests
 * has its end still to do (the last member landed: its branch, and the check that main is the tree
 * CI tested, whose notice goes to that member's owner). Answers `{ news, left, batchPending, done }`;
 * `done` is when the command may exit: news while something is left, or nothing left at all, but
 * not while such a batch is still finishing, which would say "Nothing left queued" before its notice.
 */
export function watchState(q, { owner = null, after }) {
  const mine = (x) => !owner || x.owner === owner
  // What the owner acknowledged already, or was posted for information, is not news again (#1351, notice-acks.mjs)
  const news = q.events.filter((e) => e.seq > after && e.notify && !isAcked(e) && mine(e))
  const left = q.items.filter((i) => ACTIVE.has(i.state) && mine(i))
  const owned = new Set(q.items.filter(mine).map((i) => i.pr))
  const batchPending = (q.batches ?? []).some((b) => BATCH_ACTIVE.has(b.state) && b.members.some((m) => !owner || owned.has(m.pr)))
  const done = left.length ? news.length > 0 : !batchPending
  return { news, left, batchPending, done }
}

/** The text the queuing session gets for an item that needs it. */
export function attentionText(item, reason, ref = refIn(item.repo)) {
  const title = item.title ? ` (${item.title})` : ''
  return `Merge queue: ${ref(item.repo, item.pr)}${title} needs attention: ${reason.kind}. ${reason.text} Or take it out with unqueue.`
}

/** One line for an item in answers and on the screen. */
export function itemLine(item, ref = refIn(item.repo)) {
  const stack = item.lowers?.length ? ` (stack over ${item.lowers.map((l) => ref(item.repo, l)).join(', ')})` : ''
  const title = `${item.title ? ` ${item.title}` : ''}${item.auto ? ' (integrated)' : ''}`
  const what =
    item.state === 'attention'
      ? `needs attention: ${item.reason?.kind ?? '?'} — ${item.reason?.text ?? ''}`
      : item.state === 'ci' && item.batch != null
        ? `CI in batch ${item.batch}${item.head ? ` at ${short(item.head)}` : ''}`
        : item.state === 'ci' && item.ci?.verdict === 'quick' && item.ci.head === item.head
          ? `quick tier passed at ${short(item.head)}; waiting for a batch to test it and land it`
        : item.state === 'ci'
          ? `CI${item.head ? ` at ${short(item.head)}` : ''}${item.lastError ? `; last poll failed: ${item.lastError}` : ''}`
        : item.state === 'waiting'
          ? `waiting${item.lastError ? `; last poll failed: ${item.lastError}` : ''}`
          : item.state === 'merged'
            ? `merged${item.commit ? ` as ${short(item.commit)}` : ''}`
            : 'closed without merging'
  return `${ref(item.repo, item.pr)}${title}${stack} — ${what}`
}
