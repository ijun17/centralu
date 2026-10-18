// Batches of the merge queue (#962), as pure functions: which queued items share one CI run, and what
// to do at each step of landing them. queue-batch.mjs reads GitHub for these and does what they say.
//
// Why: the free plan runs about one CI build at a time, so several pull requests queued together
// each wait for their own run in one line. A batch tests them together instead: a temporary branch
// `queue/batch-<n>` from the default branch, each pull request's head merged into it in order (on
// GitHub, `POST /merges`), and one run of the CI workflows on it (workflow_dispatch). Their own runs
// that had not started yet are cancelled. Green → each lands as its own squash, in that order, and
// only while the default branch's tree is the one the batch had at that point; the last one leaves
// it exactly the tree CI tested. Red → split in halves and tried again; one left alone goes back to
// its own CI, which says what is wrong with it.
//
// The required-checks rule (decided in #962): the queue's own rule, no branch protection change. A
// batched pull request's required checks count as passed when the batch's run passed every required
// check (the same workflow file, the same job names, read the same way as for a pull request) on a
// commit whose tree is what the default branch becomes when it lands. GitHub is not asked to accept
// a status in place of a check: the repository has no protection rule, and if one is added that
// requires checks on the head, GitHub answers BLOCKED and the pull request goes back to its own CI.
// The queue posts a `merge-queue` success status on each head it lands from a batch, naming the
// batch run, so the pull request says why it merged with its own run cancelled.
//
// Two tiers of CI (project.json `ci.fullTier`, 2026-10-18): a pull request's own run is the quick tier,
// and a batch's (a manual run) the full one. Every item lands through a batch then, a batch of one
// included: the batch also takes items whose quick tier passed, one sent back from a batch goes alone,
// and one whose batch of one ended without landing it is not batched again on that head (`alone`):
// the queue tells its session why (queue.mjs decideCi).
import { ACTIVE, BATCH_ACTIVE, findItem, pushEvent, queueOrder } from './queue.mjs'
import { short } from './util.mjs'

export const BRANCH_PREFIX = 'queue/batch-'
export const STATUS_CONTEXT = 'merge-queue'
export { BATCH_ACTIVE }
export const MAX_BATCHES_KEPT = 20
/** A run GitHub has not started: cancelling it throws away no work. */
export const NOT_STARTED = new Set(['queued', 'waiting', 'requested', 'pending'])
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])
/** Green, but the pull request has not been CLEAN (or UNSTABLE from runs the batch cancelled) for this long. */
export const LANDING_WAIT_MS = 30 * 60_000

export const activeBatch = (q) => (q.batches ?? []).find((b) => BATCH_ACTIVE.has(b.state)) ?? null
export const batchName = (b) => b.branch
const refList = (b, prs, ref) => prs.map((p) => ref(b.repo, p)).join(', ')

/**
 * The items one batch would take now: active, in CI, not in a batch, not a fork's or a release
 * bump (`ci.batchable`, from the item's poll), their own CI read on the head they have and not finished (pending or nothing yet), with every run of it not started, and not
 * sent back from a batch on this head. The oldest first, at most `max`, in one repository (the
 * oldest item's).
 *
 * With two tiers (`tiers`), also the items whose own quick tier passed (`ci.verdict` `quick`), since
 * they land only through a batch; one sent back from a batch on this head is taken alone, when it is
 * the oldest, and one whose batch of one ended without landing it (`alone`) not on this head.
 */
export function batchCandidates(q, { max, tiers = false }) {
  const waiting = (i) => (i.ci.verdict === 'pending' || i.ci.verdict === 'none') && i.ci.runs?.length > 0 && i.ci.runs.every((r) => NOT_STARTED.has(r.status))
  const ok = q.items.filter(
    (i) =>
      i.state === 'ci' &&
      !i.batch &&
      i.head &&
      (tiers ? i.alone?.head !== i.head : i.batchless !== i.head) &&
      i.ci?.head === i.head &&
      i.ci.batchable !== false &&
      (waiting(i) || (tiers && i.ci.verdict === 'quick')),
  )
  // The oldest first, after those fixed after a conflict (queueOrder)
  ok.sort(queueOrder)
  const repo = ok[0]?.repo
  const same = ok.filter((i) => String(i.repo).toLowerCase() === String(repo).toLowerCase())
  if (!tiers) return same.slice(0, max)
  if (same[0] && same[0].batchless === same[0].head) return [same[0]]
  return same.filter((i) => i.batchless !== i.head).slice(0, max)
}

/**
 * Starts a batch of `items` (in that order): written down before anything on GitHub, built on the
 * next tick. `cancelled`: the runs a batch it comes from cancelled (a split, tested again), kept for
 * these members, so landing them still knows why GitHub calls them UNSTABLE.
 */
export function formBatch(q, items, { at, ref, cancelled = [] }) {
  q.batchSeq = (Number.isInteger(q.batchSeq) ? q.batchSeq : 0) + 1
  const id = q.batchSeq
  const b = {
    id,
    repo: items[0].repo,
    branch: `${BRANCH_PREFIX}${id}`,
    state: 'building',
    members: items.map((i) => ({ pr: i.pr, head: i.head })),
    steps: [],
    cancelled: (cancelled ?? []).filter((c) => items.some((i) => i.pr === c.pr)),
    landed: 0,
    head: null,
    reruns: {},
    createdAt: at,
    updatedAt: at,
    nextAt: at,
  }
  q.batches = [...(q.batches ?? []), b]
  for (const i of items) i.batch = id
  batchEvent(q, b, `Batch ${b.branch}: ${refList(b, b.members.map((m) => m.pr), ref)} wait for CI that has not started, so they are tested together in one run.`, at)
  return b
}

/** An event about a batch (not an item's): for the screen and merge_queue, not for a session. */
export function batchEvent(q, b, text, at) {
  return pushEvent(q, { repo: b.repo, pr: null, owner: null }, { kind: 'batch', text, at })
}

/**
 * Sends members back to their own CI: they leave the batch and are read again at once, and only
 * that read makes them batchable again (`ci` goes), so a batch that keeps failing to build cannot
 * keep the queue from polling them. `batchless` (the default) keeps them out of a new batch on the
 * same head: their own run, cancelled for the batch, is rerun by the item's poll (a cancelled run is
 * rerun once per head) and says what is wrong with them, if anything. With two tiers, a batchless
 * one is batched again alone; the one member of a batch of one is marked `alone` with `why`, and is
 * not batched again on this head.
 */
export function releaseMembers(q, b, prs, { at, batchless = true, why = null } = {}) {
  for (const pr of prs) {
    const it = findItem(q, b.repo, pr)
    if (!it || it.batch !== b.id) continue
    delete it.batch
    delete it.ci
    it.nextAt = at
    if (batchless) it.batchless = it.head
    if (batchless && b.members.length === 1) it.alone = { head: it.head, text: why ?? `batch ${b.branch} ended without landing it.` }
  }
}

/**
 * Keeps items out of any batch on the head they have (one that conflicts with the others). `alone`:
 * why the batch it was alone in could not take it, which keeps it out of a batch of one too.
 */
export function markBatchless(q, repo, prs, alone = null) {
  for (const pr of prs) {
    const it = findItem(q, repo, pr)
    if (!it) continue
    it.batchless = it.head
    if (alone) it.alone = { head: it.head, text: alone }
  }
}

/** Ends a batch: every member not landed goes back to its own CI. `why`: for a batch of one's member (releaseMembers). */
export function endBatch(q, b, state, { at, batchless = true, why = null } = {}) {
  releaseMembers(q, b, b.members.slice(b.landed ?? 0).map((m) => m.pr), { at, batchless, why })
  b.state = state
  b.updatedAt = at
  b.endedAt = at
  const done = q.batches.filter((x) => !BATCH_ACTIVE.has(x.state))
  if (done.length > MAX_BATCHES_KEPT) {
    const drop = new Set(done.slice(0, done.length - MAX_BATCHES_KEPT))
    q.batches = q.batches.filter((x) => !drop.has(x))
  }
}

/**
 * A red batch, split: halves of two or more become new batches (built in turn, from the default
 * branch as it is then), a member left alone goes back to its own CI. Answers the new batches.
 */
export function splitBatch(q, b, { at, ref, min = 2 }) {
  const prs = b.steps.map((s) => s.pr)
  const mid = Math.ceil(prs.length / 2)
  const halves = [prs.slice(0, mid), prs.slice(mid)].filter((h) => h.length)
  endBatch(q, b, 'failed', { at })
  const made = []
  for (const half of halves) {
    const items = half.map((pr) => findItem(q, b.repo, pr)).filter((i) => i && !i.batch)
    if (items.length >= min) {
      // Out of the batch it failed in, a member is not batchless: it is batched again, with fewer
      for (const i of items) delete i.batchless
      made.push(formBatch(q, items, { at, ref, cancelled: b.cancelled }))
    }
  }
  return made
}

/**
 * Whether a pull request's checks show only what the batch did to it: every check passed or
 * skipped, apart from the runs the batch cancelled (their check suites). GitHub calls such a pull
 * request UNSTABLE, and that alone does not stop a batch member from landing.
 */
export function onlyCancelledByBatch(checks, cancelledSuites) {
  const suites = new Set(cancelledSuites)
  return checks.every((c) =>
    c.kind === 'status'
      ? c.state === 'success'
      : (c.status === 'completed' && OK_CONCLUSIONS.has(c.conclusion)) || (c.conclusion === 'cancelled' && suites.has(c.suiteId)),
  )
}

/**
 * The next step of landing a green batch, for the member `step` (the k-th). `mainTree` is the
 * default branch's tree now and `prevTree` the tree the batch had before this member (the base's,
 * for the first); `checks` every check on the member's head (only read when GitHub says UNSTABLE).
 * Answers `{ do: 'merge' }`, `{ do: 'retarget', base }`, `{ do: 'wait', patch? }`, `{ do: 'landed' }`
 * (found merged and the default branch is the batch's tree after it: a driver stopped between the
 * merge and writing it down), or `{ do: 'stop', text }` (this one and the rest go back to their
 * own CI). `subjectMax` and `subject` the squash subject's limit and the subject.
 */
export function decideLanding({ b, step, pr, item, mainTree, prevTree, defaultBranch, lowerBranches = [], checks = null, subject, subjectMax, now, ref }) {
  const n = ref(b.repo, step.pr)
  if (!item) return { do: 'stop', text: `${n} left the queue before it landed` }
  if (pr.state === 'MERGED') return mainTree === step.tree ? { do: 'landed' } : { do: 'stop', text: `${n} was merged outside the batch` }
  if (pr.state !== 'OPEN') return { do: 'stop', text: `${n} was closed` }
  if (pr.headRefOid !== step.head) return { do: 'stop', text: `${n}'s head moved from ${short(step.head)} to ${short(pr.headRefOid)}` }
  if (pr.isDraft) return { do: 'stop', text: `${n} became a draft` }
  if (mainTree !== prevTree) return { do: 'stop', text: `${defaultBranch} is not the tree the batch had before ${n} (something else landed)` }
  if (pr.baseRefName !== defaultBranch) {
    if (lowerBranches.includes(pr.baseRefName)) return { do: 'retarget', base: defaultBranch }
    return { do: 'stop', text: `${n} is based on ${pr.baseRefName}, not ${defaultBranch} or a lower's branch` }
  }
  if ([...subject].length > subjectMax) return { do: 'stop', text: `${n}'s squash subject is over ${subjectMax} characters` }
  if (['DIRTY', 'BEHIND', 'BLOCKED'].includes(pr.mergeStateStatus) || pr.mergeable === 'CONFLICTING')
    return { do: 'stop', text: `GitHub says ${pr.mergeStateStatus === 'BLOCKED' ? 'BLOCKED (a rule asks for something the batch does not give)' : pr.mergeStateStatus} for ${n}` }
  const clean = pr.mergeable === 'MERGEABLE' && (pr.mergeStateStatus === 'CLEAN' || (pr.mergeStateStatus === 'UNSTABLE' && checks && onlyCancelledByBatch(checks, b.cancelled.map((c) => c.suite))))
  if (clean) return { do: 'merge' }
  const since = b.uncleanSince?.pr === step.pr ? b.uncleanSince.at : new Date(now).toISOString()
  if (now - Date.parse(since) > LANDING_WAIT_MS) return { do: 'stop', text: `GitHub has said ${pr.mergeStateStatus ?? 'nothing'} for ${n} for ${Math.round(LANDING_WAIT_MS / 60_000)} minutes` }
  return { do: 'wait', patch: { uncleanSince: { pr: step.pr, at: since } } }
}

/** One line for a batch in answers and on the screen. */
export function batchLine(b, ref) {
  const prs = (b.steps.length ? b.steps : b.members).map((s) => s.pr)
  const what =
    b.state === 'building'
      ? 'building'
      : b.state === 'ci'
        ? `CI${b.head ? ` at ${short(b.head)}` : ''}`
        : b.state === 'landing'
          ? `green; landed ${b.landed} of ${prs.length}`
          : b.state === 'done'
            ? `landed ${b.landed} of ${prs.length}`
            : `ended (${b.state})${b.landed ? `, landed ${b.landed} of ${prs.length}` : ''}`
  return `Batch ${b.branch}: ${refList(b, prs, ref)} — ${what}`
}

/** Members still in an active item of this batch. */
export const liveMembers = (q, b) => b.members.filter((m) => {
  const it = findItem(q, b.repo, m.pr)
  return it && it.batch === b.id && ACTIVE.has(it.state)
})
