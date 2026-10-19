// The merge queue's batches (#962), on GitHub: builds a batch branch, runs CI on it, and lands its
// members in order. The rules are batch.mjs's; queue-driver.mjs's tick calls this before any item,
// under the same lease, and one batch runs at a time.
//
// Every write goes after renew() (still the driver?), and what was done is written down at once: a
// driver stopped in the middle leaves a batch the next one ends cleanly (a branch that exists
// already ends it; a member found merged with the batch's tree after it counts as landed).
import {
  activeBatch,
  batchCandidates,
  batchEvent,
  decideLanding,
  endBatch,
  formBatch,
  gathering,
  markBatchless,
  NOT_STARTED,
  releaseMembers,
  splitBatch,
  STATUS_CONTEXT,
} from './batch.mjs'
import { canMerge, evaluateChecks, ranTier, squashMessage, workflowCheckNames } from './ci.mjs'
import { CI, QUEUE } from './config.mjs'
import {
  cancelWorkflowRun,
  createBranch,
  deleteBranch,
  dispatchWorkflow,
  FATAL,
  GitHubError,
  mergeInto,
  postStatus,
  QUEUE_PR_FIELDS,
  readChecks,
  readCommit,
  readPr,
  readRequired,
  readWorkflowChecks,
  rerunRun,
  setPrBase,
} from './github.mjs'
import { ACTIVE, attentionText, BATCH_ACTIVE, decideRun, ERROR_LIMIT, findItem, noticeKey, pushEvent, SUBJECT_MAX } from './queue.mjs'
import { afterMerge, batchable, failingLine, land, latestRuns, permissionsOf, pollMs, runFailures, takeLease, updateQueue } from './queue-driver.mjs'
import { short } from './util.mjs'

/** A dispatch GitHub refused (no workflow_dispatch trigger, a permission): no new batch for this long. */
export const BATCH_OFF_MS = 60 * 60_000
const RED = new Set(['failed', 'failing'])
const TIERS = CI.fullTier !== null
/**
 * Fewer than this left after a split, a conflict or a change, and there is no batch (QUEUE.batch.min
 * is for starting one). With two tiers a batch of one is a batch, whatever `min`: every pull request
 * lands through one, and a red batch is split down to single pull requests (bisect), each half that
 * passes landing.
 */
const KEEP_MIN = TIERS ? 1 : 2
const workflowFile = (path) => path.split('/').pop()
const list = (b, prs, ref) => prs.map((p) => ref(b.repo, p)).join(', ')

/** What a tick does for batches: `{ batch }` (the running one is due), `{ form }` (a new one), or null. */
export function batchWork(q, now) {
  if (!QUEUE.batch) return null
  const b = activeBatch(q)
  if (b) return Date.parse(b.nextAt ?? 0) <= now ? { batch: b } : null
  if (q.batchOff && Date.parse(q.batchOff.until) > now) return null
  const items = batchCandidates(q, { max: QUEUE.batch.max, tiers: TIERS })
  if (items.length < QUEUE.batch.min) return null
  // One queued a moment ago and not read yet joins this batch rather than wait for the next
  if (gathering(q, { repo: items[0].repo, now, size: items.length, max: QUEUE.batch.max })) return null
  return { form: true }
}

/** Forms the batch batchWork saw, on the queue as it is now (inside updateQueue). */
export function formDue(q, now, ref) {
  if (activeBatch(q)) return
  const items = batchCandidates(q, { max: QUEUE.batch.max, tiers: TIERS })
  if (items.length >= QUEUE.batch.min) formBatch(q, items, { at: new Date(now).toISOString(), ref })
}

/**
 * One tick for the running batch `b` (read from `q`). Answers what it did, as tick does: `batch`,
 * `busy` (another driver took the lease) or `error`.
 */
export async function batchTick(dir, b, { q, holder, now, ref }) {
  const at = new Date(now).toISOString()
  const renew = () => takeLease(dir, holder, Date.now())
  // Changes this batch in the queue as it is now, unless it ended meanwhile
  const save = (fn) =>
    updateQueue(dir, (fresh) => {
      const fb = fresh.batches.find((x) => x.id === b.id)
      if (fb && BATCH_ACTIVE.has(fb.state)) fn(fresh, fb)
    })
  const ctx = { q, now, at, ref, renew, save }
  let r
  try {
    r = b.state === 'building' ? await build(b, ctx) : b.state === 'ci' ? await runCi(b, ctx) : await landNext(b, ctx)
  } catch (e) {
    const fatal = e instanceof GitHubError && FATAL.has(e.kind)
    const message = e instanceof GitHubError ? e.message : `Unexpected error: ${e?.message ?? e}`
    if (!(e instanceof GitHubError)) console.error('[project-board] merge queue batch:', e)
    let ended = false
    let made = false
    updateQueue(dir, (fresh) => {
      if (fatal) {
        const ms = Math.min(15 * 60_000, Math.max(60_000, (fresh.pause?.ms ?? 0) * 2))
        fresh.pause = { since: fresh.pause?.since ?? at, until: new Date(now + ms).toISOString(), ms, kind: e.kind, reason: message }
      }
      const fb = fresh.batches.find((x) => x.id === b.id)
      if (!fb || !BATCH_ACTIVE.has(fb.state)) return
      Object.assign(fb, { lastError: message, nextAt: new Date(now + pollMs('error')).toISOString() })
      if (fatal) return
      fb.errors = (fb.errors ?? 0) + 1
      if (fb.errors < ERROR_LIMIT) return
      batchEvent(fresh, fb, `Batch ${fb.branch} could not be read or acted on ${fb.errors} times in a row (${message}); its pull requests go back to their own CI.`, at)
      // Not batched again on this head: their own runs may be cancelled (rerun on their own), and a
      // batch that failed three times would most likely fail again, batch after batch
      made = fb.branchMade === true
      endBatch(fresh, fb, 'error', { at, why: `batch ${fb.branch} could not be read or acted on ${fb.errors} times in a row (${message}).` })
      ended = true
    })
    // Only a branch the queue made (written down when it was), and only while still the driver
    if (ended && made && renew()) await deleteBranch(b.repo, b.branch).catch(() => null)
    return { did: 'error', batch: b.id, error: message, fatal }
  }
  if (r?.yielded) return { did: 'busy' }
  return { did: 'batch', batch: b.id, state: r?.state ?? b.state }
}

/** Ends the batch on GitHub's side (its branch, once made) and in the queue, with an event. */
async function drop(b, { save, at, renew }, text, { batchless = true, state = 'dropped', then, made = true, why = null } = {}) {
  // Not the driver any more: the one that is ends it
  if (!renew()) return { yielded: true }
  if (made) await deleteBranch(b.repo, b.branch)
  save((q, fb) => {
    batchEvent(q, fb, `Batch ${fb.branch}: ${text}`, at)
    endBatch(q, fb, state, { at, batchless, why: why ?? `batch ${fb.branch}: ${text}` })
    then?.(q, fb)
  })
  return { state }
}

/**
 * Building: reads its members, makes `queue/batch-<n>` at the default branch and merges each head
 * into it in order (a conflicting one goes back to its own CI), starts the CI workflows on it, then
 * cancels the members' own runs that have not started.
 */
async function build(b, ctx) {
  const { q, now, at, ref, renew, save } = ctx
  const repo = b.repo
  const { permissions, defaultBranch } = await permissionsOf(repo, now)
  if (!canMerge(permissions)) {
    save((fq, fb) => (batchEvent(fq, fb, `Batch ${fb.branch}: no maintain or admin permission, so no batch.`, at), endBatch(fq, fb, 'dropped', { at, batchless: false })))
    return { state: 'dropped' }
  }
  const kept = []
  const gone = []
  for (const m of b.members) {
    const it = findItem(q, repo, m.pr)
    if (!it || it.batch !== b.id) {
      gone.push(m.pr)
      continue
    }
    const pr = await readPr(repo, m.pr, QUEUE_PR_FIELDS)
    if (pr.state === 'OPEN' && !pr.isDraft && pr.headRefOid === m.head && pr.mergeStateStatus !== 'DIRTY' && pr.mergeable !== 'CONFLICTING' && batchable(pr)) kept.push({ ...m, title: pr.title })
    else gone.push(m.pr)
  }
  if (kept.length < KEEP_MIN) {
    save((fq, fb) => {
      batchEvent(fq, fb, `Batch ${fb.branch}: fewer than ${KEEP_MIN} of ${list(fb, fb.members.map((m) => m.pr), ref)} are still as they were; no batch.`, at)
      endBatch(fq, fb, 'dropped', { at, batchless: false })
    })
    return { state: 'dropped' }
  }
  if (!renew()) return { yielded: true }
  const main = await readCommit(repo, defaultBranch)
  // Made by a driver that stopped while building it: ours (written down), so it goes and is made again
  if (b.branchMade) await deleteBranch(repo, b.branch)
  try {
    await createBranch(repo, b.branch, main.sha)
  } catch (e) {
    if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
    // A branch of that name the queue did not make: never ours to move or delete
    return drop(b, ctx, `${b.branch} could not be made (${e.message}); its pull requests go on with their own CI.`, { batchless: false, made: false })
  }
  save((fq, fb) => (fb.branchMade = true))
  const steps = []
  const conflicts = []
  const refused = []
  for (const m of kept) {
    if (!renew()) return { yielded: true } // the next driver finds the branch made by the queue, and makes it again
    let r
    try {
      r = await mergeInto(repo, b.branch, m.head, `Merge queue batch ${b.id}: #${m.pr} ${m.title}`)
    } catch (e) {
      if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
      // Not a conflict, but GitHub would not merge it (a head gone, a 404 or 422): as a conflict, it is left out
      refused.push(m.pr)
      continue
    }
    if (r.conflict) conflicts.push(m.pr)
    else if (r.nothing) refused.push(m.pr) // in main already: no batch of its own to give
    else steps.push({ pr: m.pr, head: m.head, sha: r.sha, tree: r.tree })
  }
  // Out of the batch: one that conflicts or that GitHub would not merge is not batched again on its
  // head (or it would fail the same way, batch after batch)
  const left = [...conflicts, ...refused]
  const back = (fq, fb) => {
    releaseMembers(fq, fb, [...left, ...gone], { at, batchless: false })
    // Alone in it, it would conflict again in a batch of its own
    markBatchless(fq, fb.repo, left, fb.members.length === 1 ? `${conflicts.length ? 'it conflicts with' : 'GitHub would not merge it into a batch on'} ${defaultBranch}.` : null)
  }
  if (steps.length < KEEP_MIN)
    return drop(b, ctx, `${conflicts.length ? `${list(b, conflicts, ref)} conflict${conflicts.length === 1 ? 's' : ''} with the others, and ` : ''}${refused.length ? `GitHub would not merge ${list(b, refused, ref)} into it, and ` : ''}fewer than ${KEEP_MIN} merged cleanly; no batch.`, {
      batchless: false,
      then: back,
    })
  if (!renew()) return { yielded: true }
  try {
    // Landing after the fast tier (#1259): the batch runs the quick tier on what lands
    for (const w of CI.workflows) await dispatchWorkflow(repo, workflowFile(w), b.branch, TIERS && CI.landTier === 'quick' ? { tier: 'quick' } : undefined)
  } catch (e) {
    if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
    // No workflow_dispatch trigger, or not allowed: no batches for a while, and say why
    return drop(b, ctx, `CI could not be started on it (${e.message}); no batches for ${Math.round(BATCH_OFF_MS / 60_000)} minutes.`, {
      batchless: false,
      then: (fq) => (fq.batchOff = { until: new Date(now + BATCH_OFF_MS).toISOString(), reason: e.message }),
    })
  }
  // Their own runs that have not started are not needed now: the batch's run tests them; with two
  // tiers, their quick runs still going are not either (the full run tests what they test, and their
  // runners are the batch's). Each is written down before it is cancelled, so a driver stopped in
  // between leaves no cancelled run the batch does not know (landing accepts UNSTABLE only from runs
  // on that list). A batch made from another (split, tested again) starts with that one's list.
  const cancelled = [...(b.cancelled ?? [])]
  const needless = (x) => (TIERS ? x.status !== 'completed' : NOT_STARTED.has(x.status))
  for (const s of steps) {
    const own = await readWorkflowChecks(repo, s.head, { workflows: CI.workflows })
    for (const run of own.runs.filter(needless)) {
      // Not the driver any more: the next one builds this batch again from the start
      if (!renew()) return { yielded: true }
      const entry = { pr: s.pr, run: run.id, suite: run.check_suite_id ?? null }
      cancelled.push(entry)
      save((fq, fb) => (fb.cancelled = [...(fb.cancelled ?? []), entry]))
      try {
        await cancelWorkflowRun(repo, run.id)
      } catch (e) {
        if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
        // Started or finished meanwhile: it runs on. Its checks are not cancelled ones, so the
        // entry lets nothing through (onlyCancelledByBatch wants conclusion cancelled)
      }
    }
  }
  const last = steps.at(-1)
  save((fq, fb) => {
    back(fq, fb)
    Object.assign(fb, {
      state: 'ci',
      base: main,
      steps,
      members: steps.map((s) => ({ pr: s.pr, head: s.head })),
      head: last.sha,
      tree: last.tree,
      cancelled,
      startedAt: at,
      updatedAt: at,
      nextAt: new Date(now + pollMs('ci')).toISOString(),
    })
    const fresh = cancelled.slice((b.cancelled ?? []).length)
    const runs = fresh.length ? ` Cancelled their own runs not started yet (${fresh.map((c) => c.run).join(', ')}).` : ''
    const off =
      (conflicts.length ? ` ${list(fb, conflicts, ref)} conflicted with the ones before, and go${conflicts.length === 1 ? 'es on with its' : ' on with their'} own CI.` : '') +
      (refused.length ? ` GitHub would not merge ${list(fb, refused, ref)} into it; ${refused.length === 1 ? 'it goes on with its' : 'they go on with their'} own CI.` : '')
    batchEvent(fq, fb, `Batch ${fb.branch}: ${list(fb, steps.map((s) => s.pr), ref)} merged onto ${defaultBranch} at ${short(main.sha)}; CI started on ${short(last.sha)}.${runs}${off}`, at)
  })
  return { state: 'ci' }
}

/** CI on the batch: the same rules as an item's head (rerun once), then green → landing, red → split. */
async function runCi(b, ctx) {
  const { q, now, at, ref, renew, save } = ctx
  const repo = b.repo
  const { defaultBranch } = await permissionsOf(repo, now)
  // A member that moved on (pushed, closed, a draft, taken out, queued again): what the batch tests is not what would land
  const left = []
  for (const s of b.steps) {
    const it = findItem(q, repo, s.pr)
    if (!it || it.batch !== b.id) {
      left.push(s.pr)
      continue
    }
    const pr = await readPr(repo, s.pr, QUEUE_PR_FIELDS)
    if (pr.state !== 'OPEN' || pr.isDraft || pr.headRefOid !== s.head) left.push(s.pr)
  }
  if (left.length) {
    await cancelBatchRuns(b, renew)
    const rest = b.steps.map((s) => s.pr).filter((p) => !left.includes(p))
    return drop(b, ctx, `${list(b, left, ref)} changed while it ran; ${rest.length >= KEEP_MIN ? `${list(b, rest, ref)} are tested again without ${left.length === 1 ? 'it' : 'them'}` : 'the rest go back to their own CI'}.`, {
      then: (fq, fb) => {
        // endBatch sent them all back as batchless; the rest, tested again together, are not
        const again = rest.map((p) => findItem(fq, fb.repo, p)).filter((i) => i && !i.batch && ACTIVE.has(i.state))
        if (again.length >= KEEP_MIN) {
          for (const i of again) delete i.batchless
          formBatch(fq, again, { at, ref, cancelled: fb.cancelled })
        }
      },
    })
  }
  let required = b.required
  if (!required) {
    const r = await readRequired(repo, defaultBranch, CI.workflows, workflowCheckNames, b.head)
    required = { names: r.names, unresolved: r.unresolved }
  }
  const scoped = await readWorkflowChecks(repo, b.head, { workflows: CI.workflows, branch: b.branch })
  const checks = evaluateChecks({ required: required.names, reported: scoped.reported, alsoReported: required.unresolved.length > 0 })
  const runs = latestRuns(scoped.runs, { headRefName: b.branch })
  const n = `Batch ${b.branch}`
  // Why a finished run failed: a real failure is split at once, only an infrastructure one rerun
  const failures = checks.verdict === 'failing' ? await runFailures(repo, runs, b.failures) : {}
  const d = decideRun({ subject: b, head: b.head, checks, runs, failures, now, n })
  if (d.action?.type === 'rerun') {
    if (!renew()) return { yielded: true }
    save((fq, fb) => Object.assign(fb, { required, failures, reruns: d.patch.reruns }))
    try {
      await rerunRun(repo, d.action.runId, { failedOnly: d.action.failedOnly })
    } catch (e) {
      if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
      return drop(b, ctx, `GitHub refused to rerun run ${d.action.runId} (${e.message}); its pull requests go back to their own CI.`)
    }
    save((fq, fb) => (batchEvent(fq, fb, d.event, at), Object.assign(fb, { updatedAt: at, nextAt: new Date(now + pollMs('acted')).toISOString() })))
    return { state: 'ci' }
  }
  if (d.state === 'ci') {
    save((fq, fb) => Object.assign(fb, { required, ...(d.patch ?? {}), lastError: null, errors: 0, updatedAt: at, nextAt: new Date(now + pollMs('ci')).toISOString() }))
    return { state: 'ci' }
  }
  if (d.state === 'green' && TIERS && CI.landTier !== 'quick' && ranTier(checks, CI.fullTier) !== 'full') {
    // Green without the full tier, where nothing lands from less (`ci.landTier: full`). A check still to come waits
    if (ranTier(checks, CI.fullTier) === null && runs.some((r) => r.status !== 'completed')) {
      save((fq, fb) => Object.assign(fb, { required, lastError: null, errors: 0, updatedAt: at, nextAt: new Date(now + pollMs('ci')).toISOString() }))
      return { state: 'ci' }
    }
    return drop(b, ctx, `its run passed without running the full tier (the "${CI.fullTier}" check did not pass), and nothing lands from less. Look at the changes job of its run (.github/scripts/ci-changes.mjs).`)
  }
  if (d.state === 'green') {
    const run = runs[0] ?? null
    save((fq, fb) => {
      Object.assign(fb, { state: 'landing', required, run: run ? { id: run.id, url: run.url, createdAt: run.createdAt ?? null } : null, greenAt: at, landed: 0, lastError: null, errors: 0, updatedAt: at, nextAt: at })
      batchEvent(fq, fb, `Batch ${fb.branch} passed CI${run ? ` (run ${run.id})` : ''}; landing ${list(fb, fb.steps.map((s) => s.pr), ref)} in that order, each as its own squash.`, at)
    })
    return { state: 'landing' }
  }
  // Red alone (the end of a bisect, or a batch of one): its session hears at once, with the job and
  // its first failure line. Back on its own CI, its run (cancelled for the batch) would be rerun first
  // and say only "quick tier passed" (2026-10-19)
  if (RED.has(d.reason.kind) && b.steps.length === 1 && TIERS) {
    const s = b.steps[0]
    const line = await failingLine(repo, d.reason.job)
    const reason = {
      ...d.reason,
      kind: 'failed',
      text: `${ref(repo, s.pr)} failed alone in batch ${b.branch}, a full run of it on ${defaultBranch} at ${short(b.base?.sha ?? '')}: ${d.reason.text.replace(/^Batch \S+: /, '')}${line}`,
    }
    return drop(b, ctx, `${d.reason.text.replace(/ Read it with.*$| Look with.*$/, '')} ${ref(repo, s.pr)} failed alone; its session is told.`, {
      state: 'failed',
      why: reason.text,
      then: (fq) => {
        const it = findItem(fq, repo, s.pr)
        if (!it) return
        // Not batched again on this head, and its poll answers this same reason (queue.mjs decideCi)
        it.alone = { head: s.head, text: reason.text, reason }
        Object.assign(it, { state: 'attention', reason, noticeKey: noticeKey(reason, s.head), updatedAt: at, nextAt: new Date(now + pollMs('attention')).toISOString() })
        pushEvent(fq, it, { kind: 'attention', text: attentionText(it, reason, ref), notify: true, at })
      },
    })
  }
  // Attention for a batch is not a session's: red is split and tried again, anything else goes back
  if (RED.has(d.reason.kind) && b.steps.length >= 2) {
    if (!renew()) return { yielded: true }
    await deleteBranch(repo, b.branch)
    let made = []
    save((fq, fb) => {
      made = splitBatch(fq, fb, { at, ref, min: KEEP_MIN })
      const halves = made.map((x) => `${x.branch} (${list(fb, x.members.map((m) => m.pr), ref)})`)
      batchEvent(fq, fb, `${d.reason.text.replace(/ Read it with.*$| Look with.*$/, '')} Split: ${halves.length ? `${halves.join(' and ')} next; ` : ''}a pull request left alone goes back to its own CI.`, at)
    })
    return { state: 'failed' }
  }
  return drop(b, ctx, `${d.reason.text} Its pull requests go back to their own CI.`, { why: d.reason.text })
}

/** Cancels the batch's own runs still going (it changed, or ended). Best effort. */
async function cancelBatchRuns(b, renew) {
  if (!b.head) return
  try {
    const own = await readWorkflowChecks(b.repo, b.head, { workflows: CI.workflows, branch: b.branch })
    for (const run of own.runs.filter((x) => x.status !== 'completed')) if (renew()) await cancelWorkflowRun(b.repo, run.id).catch(() => null)
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
  }
}

/**
 * Landing: one member per tick, in order. Each only while the default branch has the tree the batch
 * had before it, and so leaves the tree the batch had after it; the last one leaves the tested tree.
 */
async function landNext(b, ctx) {
  const { q, now, at, ref, renew, save } = ctx
  const repo = b.repo
  const { defaultBranch } = await permissionsOf(repo, now)
  const prs = b.steps.map((s) => s.pr)
  if (b.landed >= b.steps.length) {
    const main = await readCommit(repo, defaultBranch)
    const same = main.tree === b.tree
    if (!renew()) return { yielded: true }
    await deleteBranch(repo, b.branch)
    save((fq, fb) => {
      batchEvent(fq, fb, `Batch ${fb.branch}: landed ${list(fb, prs, ref)}; ${defaultBranch} at ${short(main.sha)} ${same ? 'is the tree CI tested' : 'is not the tree CI tested'}.`, at)
      if (!same) {
        // Something landed between two of them: worth the last one's session knowing
        const it = fq.items.find((i) => i.repo === fb.repo && i.pr === prs.at(-1)) ?? { repo: fb.repo, pr: prs.at(-1), owner: null }
        pushEvent(fq, it, { kind: 'batch', notify: true, at, text: `Merge queue: batch ${fb.branch} landed ${list(fb, prs, ref)}, but ${defaultBranch} at ${short(main.sha)} is not the tree its CI tested (something else merged in between). Look at CI on ${defaultBranch}.` })
      }
      endBatch(fq, fb, 'done', { at })
    })
    return { state: 'done' }
  }
  const k = b.landed
  const step = b.steps[k]
  const item = findItem(q, repo, step.pr)
  const mine = item && item.batch === b.id ? item : null
  const pr = await readPr(repo, step.pr, QUEUE_PR_FIELDS)
  const main = await readCommit(repo, defaultBranch)
  const prevTree = k === 0 ? b.base.tree : b.steps[k - 1].tree
  let lowerBranches = []
  if (pr.state === 'OPEN' && pr.baseRefName !== defaultBranch && mine?.lowers?.length)
    lowerBranches = (await Promise.all(mine.lowers.map((l) => readPr(repo, l).catch(() => null)))).filter(Boolean).map((l) => l.headRefName)
  const subject = squashMessage({ number: pr.number, title: pr.title, description: pr.body }).subject
  const checks = pr.state === 'OPEN' && pr.mergeStateStatus === 'UNSTABLE' ? await readChecks(repo, pr.headRefOid) : null
  const d = decideLanding({ b, step, pr, item: mine, mainTree: main.tree, prevTree, defaultBranch, lowerBranches, checks, subject, subjectMax: SUBJECT_MAX, now, ref })
  const n = ref(repo, step.pr)
  const view = mine ? { ...mine, title: pr.title } : { repo, pr: step.pr, lowers: [], title: pr.title }
  const tested = ` Tested in batch ${b.branch} with ${list(b, prs.filter((p) => p !== step.pr), ref) || 'nothing else'}.`

  if (d.do === 'stop') {
    const rest = prs.slice(k)
    return drop(b, ctx, `stopped before ${n}: ${d.text}. ${list(b, rest, ref)} go${rest.length === 1 ? 'es' : ''} back to ${rest.length === 1 ? 'its' : 'their'} own CI${k ? ` (${list(b, prs.slice(0, k), ref)} landed)` : ''}.`, { state: 'stopped' })
  }
  if (d.do === 'wait') {
    save((fq, fb) => Object.assign(fb, d.patch ?? {}, { lastError: null, errors: 0, updatedAt: at, nextAt: new Date(now + pollMs('waiting')).toISOString() }))
    return { state: 'landing' }
  }
  if (d.do === 'retarget') {
    if (!renew()) return { yielded: true }
    await setPrBase(repo, step.pr, d.base)
    save((fq, fb) => (batchEvent(fq, fb, `${n}: moved its base from ${pr.baseRefName} to ${d.base} to land the stack through it.`, at), Object.assign(fb, { updatedAt: at, nextAt: new Date(now + pollMs('waiting')).toISOString() })))
    return { state: 'landing' }
  }
  let merged = pr
  let squash = null
  if (d.do === 'merge') {
    if (!renew()) return { yielded: true }
    // On the pull request, why it merged with its own run cancelled
    await postStatus(repo, step.head, {
      state: 'success',
      context: STATUS_CONTEXT,
      description: `Passed CI in ${b.branch}${prs.length > 1 ? ` with ${list(b, prs.filter((p) => p !== step.pr), ref)}` : ''}`,
      targetUrl: b.run?.url ?? null,
    }).catch((e) => {
      if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    })
    // The batch's run proved it (an older batch file has no time: a lower's failure then counts)
    const r = await land(view, pr, ref, renew, defaultBranch, { provedAt: b.run?.createdAt ?? null })
    if (r.yielded) return { yielded: true }
    if (r.state !== 'merged') {
      const rest = prs.slice(k + 1)
      return drop(b, ctx, `${n} did not land (${r.reason.kind})${rest.length ? `; ${list(b, rest, ref)} go back to their own CI` : ''}.`, {
        state: 'stopped',
        then: (fq) => {
          const it = findItem(fq, repo, step.pr)
          if (!it) return
          Object.assign(it, { state: 'attention', reason: r.reason, noticeKey: `${r.reason.kind}:${step.head}:`, updatedAt: at, nextAt: new Date(now + pollMs('attention')).toISOString() })
          pushEvent(fq, it, { kind: 'attention', text: attentionText(it, r.reason, ref), notify: true, at })
        },
      })
    }
    merged = r.merged
    squash = r.subject
  }
  // Landed: here, or found merged with the batch's tree after it (a driver stopped before writing it down)
  const text = `${await afterMerge(view, merged, ref, squash, { landed: true, defaultBranch })}${tested}`
  save((fq, fb) => {
    const it = findItem(fq, repo, step.pr) ?? { ...view }
    Object.assign(it, { state: 'merged', mergedAt: at, commit: merged.mergeCommit?.oid ?? null, reason: null, noticeKey: null, updatedAt: at, title: pr.title })
    delete it.batch
    pushEvent(fq, it, { kind: 'merged', text, notify: true, at })
    Object.assign(fb, { landed: k + 1, uncleanSince: null, lastError: null, errors: 0, updatedAt: at, nextAt: at })
  })
  return { state: 'landing' }
}
