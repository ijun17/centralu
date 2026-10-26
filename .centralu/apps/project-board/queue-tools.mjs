// The merge queue (#956): queue_merge, merge_queue and unqueue. The queue lives in the app's data
// folder (queue-driver.mjs) and is driven by this server while it runs and by the watch command a
// session runs in the background; the decisions are queue.mjs's. Its news is posted into the queuing
// session (`tellSessions`, #1161 item 1); the watch command still reads it for an older Centralu.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { centralu, z } from './runtime/centralu-app-runtime.mjs'
import { now as clock } from './system.mjs'
import { itemOf, itemRef, REF_HELP } from './board.mjs'
import { canMerge, NO_PERMISSION } from './ci.mjs'
import { APP_DIR, CI, config, QUEUE } from './config.mjs'
import { openPr } from './contribute-tools.mjs'
import { GitHubError, markDraft, prsWithHead, readPr, readRepo } from './github.mjs'
import { answering, serially } from './handlers.mjs'
import { BATCH_ACTIVE, batchLine } from './batch.mjs'
import { ACTIVE, dequeue, enqueue, findItem, itemLine, longSubject, queueOrder, SUBJECT_MAX } from './queue.mjs'
import { becauseLines, judgeBranch, labelTier, notAutoText, recordVerified } from './queue-integrate.mjs'
import { STEP_ON_READ, queueBusy, queueRef, readLease, readQueue, startDriver, updateQueue } from './queue-driver.mjs'
import { answer, asError, linesAnswer } from './reply.mjs'
import { plural, shellQuote } from './util.mjs'
import { acknowledge, dueReposts, markReposted, noticeText, unacked } from './notice-acks.mjs'

const dataDir = () => centralu.dataDir
const WATCH = join(APP_DIR, 'bin', 'merge-queue.mjs')
const quote = shellQuote

/** The command a session runs in the background to hear about its items (bin/merge-queue.mjs). */
export function watchCommand({ owner, after }) {
  return ['node', quote(WATCH), 'watch', '--data', quote(dataDir()), ...(owner ? ['--owner', quote(owner)] : []), '--after', String(after)].join(' ')
}

/**
 * Holds this app's process while the queue has work, and lets it go once it has none (#1236): Centralu would
 * otherwise stop it after 5 minutes with no screen and no call, and the queue with it. After every tick (either
 * driver may have changed the queue) and every change a tool makes. A file that does not read changes nothing.
 */
function holdWhileWork() {
  let q
  try {
    q = readQueue(dataDir())
  } catch {
    return
  }
  void centralu.busy(queueBusy(q) ?? false)
}

/** A message posted this many times without Centralu taking it is given up on (`told: 'failed'`); `watch` still has it */
const TELL_TRIES = 6
/** Between tries of one message: Centralu may be restarting (a swap takes seconds to a minute) */
const TELL_RETRY_MS = Number(process.env.PROJECT_BOARD_QUEUE_TELL_RETRY_MS) || 30_000
const tellTries = new Map()
/** The same for posting a message again (#1351) */
const repostTries = new Map()

/**
 * Posts one message into its session, counting tries in `tries`: answers whether it was posted, false once given
 * up on after TELL_TRIES, or null to try again later (not taken yet, or tried too recently).
 */
async function post(tries, e, text, now) {
  const tried = tries.get(e.seq)
  if (tried && now < tried.at + TELL_RETRY_MS) return null
  const ok = await centralu.notify(e.to, text)
  const n = (tried?.n ?? 0) + 1
  if (!ok && n < TELL_TRIES) {
    tries.set(e.seq, { n, at: now })
    return null
  }
  tries.delete(e.seq)
  return ok
}
let telling = false

/**
 * Posts the queue's messages into the sessions they are for (#1161 item 1): each `notify` event that carries the
 * queuing session's notice address (`to`, queue.mjs pushEvent) and is not yet `told`, as a report arrives there, so
 * the session hears without a watch command. Whichever driver wrote the event (this server or a watch command), this
 * server posts it, after every tick. One at a time, in order; one Centralu did not take is tried again a few times
 * (a restart), then marked failed. A session on an older Centralu gets no address, and its watch command still works.
 */
export async function tellSessions(now = clock()) {
  if (telling) return
  telling = true
  try {
    const q = readQueue(dataDir())
    for (const e of q.events.filter((x) => x.notify && x.to && !x.told)) {
      // One that needs attention says how to acknowledge it, or it stays listed (#1351)
      const ok = await post(tellTries, e, noticeText(e), now)
      if (ok === null) continue
      updateQueue(dataDir(), (fresh) => {
        const ev = fresh.events.find((x) => x.seq === e.seq)
        if (!ev) return
        ev.told = ok ? true : 'failed'
        // When, for posting it again if it stays unacknowledged (#1351)
        if (ok) ev.toldAt = new Date(now).toISOString()
      })
    }
    // A message that needs attention and is still unacknowledged after 30 minutes is posted again, once (#1351)
    // A post Centralu does not take is tried again, as a first post is, and only then given up on
    for (const e of dueReposts(readQueue(dataDir()), now).filter((x) => x.to)) {
      const ok = await post(repostTries, e, `Merge queue: still not acknowledged after ${Math.round((now - Date.parse(e.toldAt)) / 60_000)} minutes: ${noticeText(e)}`, now)
      if (ok === null) continue
      updateQueue(dataDir(), (fresh) => markReposted(fresh, e.seq, new Date(now).toISOString(), ok))
    }
  } catch (err) {
    console.error(`[project-board] merge queue: telling a session failed: ${err?.message ?? err}`)
  } finally {
    telling = false
  }
}

/** This server's driver, once started: `merge_queue` steps it when STEP_ON_READ */
let serverDriver = null

/** Starts this server's driver; called once from server.mjs. */
export function startQueue() {
  const holder = `server:${process.pid}`
  holdWhileWork()
  const driver = startDriver(dataDir(), {
    holder,
    manual: STEP_ON_READ,
    // Stepped (tests), a tick ends once its messages are posted, so the read after it sees them told
    onTick: (_r, at) => {
      holdWhileWork()
      const telling = tellSessions(at)
      return STEP_ON_READ ? telling : undefined
    },
  })
  serverDriver = driver
  // Stopped (Centralu closes its input, and the runtime exits): the lease goes with it, so the next
  // driver need not wait for it to run out
  process.once('exit', () => driver.stopNow())
  return driver
}

/** Who drives the queue now, in words: this server, a watch command, or nobody. */
function driverLine(q, now = Date.now()) {
  const lease = readLease(dataDir())
  const active = q.items.some((i) => ACTIVE.has(i.state))
  const pause = q.pause && Date.parse(q.pause.until) > now ? ` Paused until ${q.pause.until.slice(11, 19)} UTC: ${q.pause.reason}` : ''
  const held = QUEUE.guard && (q.guard?.unfinished ?? 0) > QUEUE.guard.maxMainRuns ? ` Landing held: ${q.guard.unfinished} of main's full runs unfinished (at most ${QUEUE.guard.maxMainRuns}, #1259).` : ''
  if (!active) return `Nothing queued.${pause}${held}`
  if (lease && Date.parse(lease.until) > now) return `Driven by ${String(lease.holder).startsWith('server:') ? 'the board app' : 'a watch command'}.${pause}${held}`
  return `Driven by the board app, which keeps running while the queue has work, and by a watch command while one runs.${pause}${held}`
}

const COUNTS = [
  ['attention', 'need attention'],
  ['ci', 'in CI'],
  ['waiting', 'waiting'],
  ['merged', 'merged'],
  ['closed', 'closed'],
]

/**
 * The queue for agents and the screen: one line per item, attention first. Within a state the items waiting or acting
 * are in the queue's order (those fixed after a conflict first, then as they were queued: queueOrder), which a poll does not change (it sets `updatedAt` on every read, so by that the
 * order followed whichever was read last); those ended come newest first.
 */
export function queueView({ all = false } = {}) {
  const q = readQueue(dataDir())
  const order = ['attention', 'ci', 'waiting', 'merged', 'closed']
  const items = q.items
    .filter((i) => all || ACTIVE.has(i.state) || clock() - Date.parse(i.updatedAt) < 24 * 3600_000)
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || (ACTIVE.has(a.state) ? queueOrder(a, b) : String(b.updatedAt).localeCompare(String(a.updatedAt))))
  const counts = Object.fromEntries(COUNTS.map(([s]) => [s, items.filter((i) => i.state === s).length]))
  const parts = COUNTS.filter(([s]) => counts[s]).map(([s, words]) => `${counts[s]} ${words}`)
  const summary = `Merge queue: ${parts.length ? parts.join(', ') : 'empty'}. ${driverLine(q)}`
  // Batches (#962): the running ones, and those ended in the last day (or all, with `all`)
  const batches = (q.batches ?? []).filter((b) => all || BATCH_ACTIVE.has(b.state) || clock() - Date.parse(b.updatedAt) < 24 * 3600_000)
  const byId = new Map((q.batches ?? []).map((b) => [b.id, b]))
  return {
    summary,
    lines: [...batches.filter((b) => BATCH_ACTIVE.has(b.state)).map((b) => batchLine(b, queueRef)), ...items.map((i) => itemLine(i, queueRef))],
    batches: batches.map((b) => ({
      id: b.id,
      branch: b.branch,
      state: b.state,
      prs: (b.steps?.length ? b.steps : b.members).map((m) => m.pr),
      landed: b.landed ?? 0,
      tier: b.tier ?? null,
      tierWhy: b.tierWhy ?? null,
      head: b.head ?? null,
      run: b.run ?? null,
      line: batchLine(b, queueRef),
      updatedAt: b.updatedAt,
    })),
    counts,
    pause: q.pause,
    seq: q.seq,
    queue: items.map((i) => ({
      repo: i.repo,
      pr: i.pr,
      ref: queueRef(i.repo, i.pr),
      title: i.title,
      lowers: i.lowers,
      owner: i.owner,
      author: i.author ?? null,
      state: i.state,
      reason: i.reason,
      head: i.head,
      commit: i.commit ?? null,
      queuedAt: i.queuedAt,
      front: i.front ?? null,
      updatedAt: i.updatedAt,
      lastError: i.lastError ?? null,
      batch: i.batch != null && byId.has(i.batch) ? { id: i.batch, branch: byId.get(i.batch).branch, state: byId.get(i.batch).state } : null,
    })),
    // Without the notice address: a session's, for this app only, and nothing a reader needs
    events: q.events
      .filter((e) => e.notify)
      .slice(-10)
      .map(({ to: _to, ...e }) => e),
  }
}

async function queueMerge({ pr, lowers = [], owner, author, deleteBranch = true }) {
  const top = itemOf(pr)
  const under = lowers.map((l) => itemOf(l))
  const other = under.find((l) => l.repo.toLowerCase() !== top.repo.toLowerCase())
  if (other) throw new GitHubError('input', `Not queued: ${other.ref} is in another repository than ${top.ref}; a stack lands in one.`)
  if (under.some((l) => l.number === top.number)) throw new GitHubError('input', `Not queued: ${top.ref} cannot be its own lower.`)
  // Who is asking comes first, as for merge_when_green: a contributor's agent queues nothing
  const { permissions, defaultBranch } = await readRepo(top.repo)
  if (!canMerge(permissions)) return asError(answer(`Not queued: ${NO_PERMISSION.reason}`, { queued: false, kind: 'permission' }))
  const p = await readPr(top.repo, top.number)
  const problems = []
  if (p.state !== 'OPEN') problems.push(`${top.ref} is ${String(p.state).toLowerCase()}, not open.`)
  if (p.isDraft) problems.push(`${top.ref} is a draft; mark it ready for review first.`)
  const lowerPrs = []
  for (const l of under) {
    const lp = await readPr(l.repo, l.number)
    if (lp.state !== 'OPEN') problems.push(`${l.ref} is ${String(lp.state).toLowerCase()}, not open.`)
    lowerPrs.push(lp)
  }
  if (p.baseRefName !== defaultBranch && !lowerPrs.some((lp) => lp.headRefName === p.baseRefName))
    problems.push(`${top.ref} is based on ${p.baseRefName}, not ${defaultBranch}: give the PRs under it as lowers, so the stack lands through ${top.ref}.`)
  // The squash subject is "Title (#N)" and must fit (#1593: before any batch, as integrate does, #1222); a stack lands through its top
  const long = longSubject(p)
  if (long) problems.push(`the squash subject "${long.subject}" is ${long.length} characters, over ${SUBJECT_MAX}. Shorten the title.`)
  // `kind` is 'subject' only when that is the one reason; with others it is 'refused', and `subject` says the title is among them
  if (problems.length) return asError(answer(`Not queued: ${problems.join(' ')}`, { queued: false, kind: long && problems.length === 1 ? 'subject' : 'refused', subject: Boolean(long) }))

  const r = enqueueFor({ repo: top.repo, number: top.number, lowers: under.map((l) => l.number), owner, author, deleteBranch, title: p.title })
  if (r.error) return asError(answer(`Not queued: ${r.error}`, { queued: false, kind: 'conflict' }))
  const stack = under.length ? ` with ${under.map((l) => l.ref).join(', ')} under it (one squash through ${top.ref}; they close as landed)` : ''
  const by = r.item.author ? ` Author session: ${r.item.author}.` : ' No author session recorded (give author to name it).'
  const summary = `${r.replaced ? 'Queued again' : 'Queued'} ${top.ref} ${p.title}${stack}, for ${r.item.owner}.${by} ${plural(r.active, 'item')} in the queue. It merges once green; reruns a cancelled run, or failed jobs, once per head.`
  return queuedAnswer(summary, r)
}

/**
 * Queues one pull request (with its lowers) for the calling session, and holds the app while the queue has work.
 * `owner` and `author` as the tools take them; `mark` fields of its own on the item (the integrator's, #1259 step 3).
 * Answers enqueue's `{ item, replaced }` with the event's `seq` and how many are active, or `{ error }`.
 */
function enqueueFor({ repo, number, lowers = [], owner, author, deleteBranch = true, title, mark = null }) {
  // No owner given: a new id, unless it is queued already (queued again, it stays the session's that
  // queued it first, whose watch command still listens for that owner)
  const given = owner?.trim() || null
  // The PR's author session (#1182), which a conflict is handed to: given, else the caller's own,
  // which is the owner it names (an app server cannot tell which session called it, docs/apps.md
  // §5.1), else the one recorded when it was queued before. A generated owner id is no session.
  const authorGiven = author?.trim() || given
  // The queuing session's address, where the queue posts its news (#1161 item 1); null from a view or an older Centralu
  const notice = centralu.noticeAddress()
  const at = new Date(clock()).toISOString()
  const r = updateQueue(dataDir(), (q) => {
    const who = given ?? findItem(q, repo, number)?.owner ?? `queue-${randomBytes(3).toString('hex')}`
    const out = enqueue(q, { repo, pr: number, lowers, owner: who, author: authorGiven, notice, deleteBranch, title, at }, queueRef)
    // Queued with queue_merge, an integrated record is a pull request of its own tier again: no longer judged as auto
    if (out.item && mark) Object.assign(out.item, mark)
    else if (out.item) {
      delete out.item.auto
      delete out.item.tierAt
    }
    return { ...out, seq: q.seq, active: q.items.filter((i) => ACTIVE.has(i.state)).length, notice }
  })
  if (!r.error) holdWhileWork()
  return r
}

/** The answer for a session that queued (enqueueFor's `r`): its news comes in as messages, or through the watch command. */
function queuedAnswer(summary, r, extra = {}) {
  const watch = watchCommand({ owner: r.item.owner, after: r.seq })
  // Its news comes into this session as a message (#1161 item 1); without an address (an older Centralu, a view), the watch command
  const told = r.notice !== null && r.item.notice === r.notice
  const text = told
    ? [
        summary,
        'This session hears here when it lands or needs you: the queue posts its news into it as a message, so no watch command is needed. The watch command still works:',
        watch,
      ].join('\n')
    : [summary, `To hear in this session when it needs you or lands, run in the background (it exits with the message; run it again after):`, watch].join('\n')
  return answer(text, { queued: true, owner: r.item.owner, author: r.item.author ?? null, watch, seq: r.seq, told, ...extra })
}

// --- The integrator (#1259 step 3): an auto-tier branch lands without its session opening a pull request ----

const refused = (text, extra = {}, lines = []) => asError(linesAnswer(`Not integrated: ${text}`, [['because', 'The files that put it there:', lines]], { integrated: false, ...extra }))
/** What an auto-tier change answers for the template's kept headings: no code runs in it */
const AUTO_NA = 'n/a: an auto-tier change (docs, fixture data or UI assets), in which no code runs.'

/**
 * integrate: the session's pushed branch, judged by the integrator (queue-integrate.mjs) and, when its tier is auto,
 * opened as a pull request that is the record and queued for the session, as queue_merge would. The cheap checks first
 * (who asks, the branch, the title and the description, a dry run of open_pr), then the judgment (a fetch), then the
 * writes, one at a time with the board's other writes. An open pull request from the branch (an earlier hand-over, or
 * one the session opened) is the record, not a second one.
 */
async function integrate({ branch, title, why, whatChanged, verified, notExercised, closes, owner }) {
  const repo = config.repository
  const name = String(branch ?? '').trim().replace(/^refs\/heads\//, '')
  if (!name) return refused('give the branch you pushed.', { kind: 'input' })
  if (name.includes(':')) return refused(`${name} is a fork's branch; the integrator lands only branches of ${repo}. Open a pull request from the fork (open_pr).`, { kind: 'fork' })
  const { permissions, defaultBranch } = await readRepo(repo)
  if (!canMerge(permissions)) return refused(`${NO_PERMISSION.reason} Open a pull request (open_pr) and mark it ready (mark_ready) for the maintainer.`, { kind: 'permission' })
  if (name === defaultBranch) return refused(`${name} is ${repo}'s default branch; push your change to a branch of its own, made from ${defaultBranch}.`, { kind: 'input' })
  // The squash subject is "Title (#N)" and must fit (#1222: before any batch, not after it)
  // It lands only through a batch running the quick tier on what lands: without batches or two tiers of CI, a draft record
  // would have no gate at all (its own run is CI's changes job only)
  if (!QUEUE.batch || !CI.fullTier) return refused(`this repository's merge queue does not batch with two tiers of CI (project.json queue.batch, ci.fullTier), which integrate needs. Open a pull request (open_pr) and queue it (queue_merge).`, { kind: 'setup' })
  const squash = [...String(title ?? '')].length + ' (#9999)'.length
  if (squash > SUBJECT_MAX) return refused(`the squash subject "${title} (#N)" would be about ${squash} characters, over ${SUBJECT_MAX}. Shorten the title.`, { kind: 'subject' })
  const sections = { why, whatChanged, notExercised, closes, situationsChecked: AUTO_NA, usability: AUTO_NA }
  const dry = await openPr({ title, head: name, base: defaultBranch, ...sections, verifiedNote: verified, dryRun: true })
  if (dry.isError) return refused(dry.content[0].text.replace(/^Not opened: /, ''), { kind: 'record' })

  // The integrator's own judgment, from GitHub's copy of main and the branch: never the session's word
  const j = await judgeBranch({ dir: QUEUE.conflicts.checkout, repo, branch: name, defaultBranch })
  if (j.setup) return refused(`this board cannot judge branches here: ${j.unjudged}. Open a pull request (open_pr) and queue it (queue_merge).`, { kind: 'setup' })
  if (j.retry) return refused(`GitHub's copy of ${name} or ${defaultBranch} could not be fetched to judge it (${j.unjudged}). Nothing was written; integrate again in a moment.`, { kind: 'retry' })
  if (j.missing) return refused(`the branch ${name} is not on GitHub. Push it first (git push origin ${name}).`, { kind: 'missing' })
  if (j.tier === 'auto' && !j.files) return refused(`${name} adds nothing over ${defaultBranch}; nothing to land.`, { kind: 'empty' })
  if (j.tier !== 'auto') return refused(notAutoText(j, name), { kind: 'tier', tier: j.tier, line: j.line }, becauseLines(j))
  return serially(integrateWrites)({ repo, name, defaultBranch, title, sections, verified, owner, j })
}

async function integrateWrites({ repo, name, defaultBranch, title, sections, verified, owner, j }) {
  // A fork's pull request whose branch has the same name is not this branch's
  const open = (await prsWithHead(repo, name)).find((p) => p.state === 'OPEN' && !p.isCrossRepository) ?? null
  if (open && open.baseRefName !== defaultBranch)
    return refused(`#${open.number} is open from ${name} into ${open.baseRefName}, not ${defaultBranch}; the integrator lands nothing stacked. Close it, or land it with queue_merge.`, { kind: 'stacked', pr: open.number })
  // A tier a person (or open_pr) set by label only raises it: one above auto is not the integrator's to land
  const labelled = open ? labelTier(open.labels) : null
  if (labelled && labelled !== 'auto')
    return refused(`#${open.number}, open from ${name}, is labelled tier:${labelled}, and integrate lands only auto. Land it as a pull request of that tier (its review, then queue_merge), or take the label off if it was wrong.`, { kind: 'label', pr: open.number, tier: labelled })
  let number
  let url
  let opened = false
  // The record stays a draft until the queue squashes it (#1259 review): GitHub, every version of the queue and
  // merge_when_green refuse to merge a draft, so no path but this queue's, which judges it first, can land it
  if (open) {
    number = open.number
    url = `https://github.com/${repo}/pull/${number}`
    if (!open.isDraft) await markDraft(repo, number)
  } else {
    const made = await openPr({ title, head: name, base: defaultBranch, draft: true, ...sections, verifiedNote: recordVerified(j, { branch: name, defaultBranch, owner, verified }), labels: ['tier:auto'] })
    if (made.isError) return refused(made.content[0].text.replace(/^Not opened: /, ''), { kind: 'record' })
    number = made.structuredContent.number
    url = made.structuredContent.url
    opened = true
  }
  const recordTitle = open ? (await readPr(repo, number)).title : title
  const at = new Date(clock()).toISOString()
  const r = enqueueFor({ repo, number, owner, author: owner, title: recordTitle, mark: { auto: { branch: name, head: j.head, main: j.main, line: j.line, at }, tierAt: null } })
  if (r.error) return refused(`${r.error}${opened ? ` ${queueRef(repo, number)} was opened as its record and is not queued: integrate again once that is cleared.` : ''}`, { kind: 'conflict', pr: number })
  const ref = queueRef(repo, number)
  const record = opened ? `Opened ${ref} as its record (${url})` : `${ref}, open from it already, is its record (${url})`
  const summary = `Integrated ${name}: ${j.line} ${record}, and ${r.replaced ? 'queued it again' : 'queued it'} for ${r.item.owner}. It lands after the fast gate (a batch's quick tier on ${defaultBranch}, and the heavy jobs too when the batch changes the screen) as "${recordTitle} (#${number})", and its branch is deleted. The queue judges its tier again on each new head and right before it lands: a push that is no longer auto is stopped and comes back to you. The record stays a draft until then: should a merge-queue message say it is a draft and to mark it ready, leave it (that message is an older board's), as the queue readies it itself. ${plural(r.active, 'item')} in the queue.`
  return queuedAnswer(summary, r, { integrated: true, pr: number, url, opened, tier: j.tier, line: j.line })
}

/** The messages an owner (every owner when none is given) has not acknowledged, for merge_queue and the screen (#1351) */
function unackedView(owner = null) {
  return unacked(readQueue(dataDir()), owner).map(({ seq, at, owner: o, kind, pr, text }) => ({ seq, at, owner: o, kind, pr, text }))
}

async function mergeQueue({ all = false, owner }) {
  // Tests only (STEP_ON_READ): the read moves the queue one poll first, in place of the timer
  if (STEP_ON_READ) await serverDriver?.step()
  const v = queueView({ all })
  const who = owner?.trim() || null
  const waiting = unackedView(who)
  // What its owner has not acknowledged comes first, with how to (#1351); without an owner only how many, by owner
  const owners = [...new Set(waiting.map((e) => e.owner))]
  const head = !waiting.length
    ? []
    : who
      ? [`${plural(waiting.length, 'message')} not acknowledged by ${who}; act on each, then ack({ owner, seqs }) (or upTo: ${waiting.at(-1).seq}):`, ...waiting.map((e) => `#${e.seq} ${e.text}`)]
      : [`${plural(waiting.length, 'message')} not acknowledged, for ${owners.map((o) => `${o} (${waiting.filter((e) => e.owner === o).length})`).join(', ')}; merge_queue({ owner }) lists them.`]
  return linesAnswer(v.summary, [['unacked', '', head], ['items', '', v.lines]], { counts: v.counts, queue: v.queue, batches: v.batches, events: v.events, unacked: waiting, pause: v.pause, seq: v.seq })
}

async function ack({ owner, seqs = [], upTo }) {
  const who = owner.trim()
  // A blank owner would match every owner's messages: refused
  if (!who) return asError(answer('Nothing acknowledged: give the owner you queued with.', { acked: 0 }))
  if (!seqs.length && upTo === undefined) return asError(answer('Nothing acknowledged: give seqs, or upTo.', { acked: 0 }))
  const at = new Date(clock()).toISOString()
  const n = updateQueue(dataDir(), (q) => acknowledge(q, who, { seqs, upTo: upTo ?? null, at }))
  const left = unackedView(who).length
  return answer(`Acknowledged ${plural(n, 'message')} for ${who}; ${left} still not acknowledged.`, { acked: n, left })
}

async function unqueue({ pr }) {
  const want = itemOf(pr)
  const removed = updateQueue(dataDir(), (q) => dequeue(q, { repo: want.repo, pr: want.number, at: new Date(clock()).toISOString() }, queueRef))
  if (!removed) return asError(answer(`${want.ref} is not in the merge queue.`, { removed: false }))
  holdWhileWork()
  return answer(`Took ${want.ref} out of the merge queue; nothing on GitHub changed.`, { removed: true })
}

const QUEUE_DESCRIPTION =
  'Queue pull requests to merge on their own, instead of a gh loop of gh pr merge and gh run rerun: one PR, or a stack as pr (the top) plus lowers (the PRs under it), which lands as one squash through the top after moving its base to main and closes the lowers with "Landed in #N". The queue runs in this app (it survives sessions and restarts): green and mergeable → squash with --match-head-commit and delete the branch; a cancelled run is rerun once per head, failed jobs once per head; DIRTY → it merges main into the branch itself and pushes that when only mechanical files (project.json queue.conflicts) conflict, else (a stack top whose lower one merged is restacked, as rebase_stack would) hands the conflict to the author session of the PR, posting it into that session itself when it opened the PR with open_pr; a draft that the queuing session opened with open_pr is marked ready; failing again, any other draft, or anything it cannot fix → it tells the session that queued it. Maintainer only; merges only when every required check of the CI workflow passed and GitHub says CLEAN, never a draft; UNSTABLE waits unless every check that did not pass is a cancelled duplicate or older run of CI on that head, or a run a batch cancelled. Several PRs whose own CI has not started are tested together in one run on a queue/batch-N branch and then land one by one in order, each only while main has the tree the batch had before it (their own waiting runs are cancelled; a red batch is split). With two tiers of CI (project.json ci.fullTier), the own run of a PR is the quick tier, which lands nothing: once it passes, the PR lands through a batch, a batch of one included, or from a full run on its own head (a release bump, or the full tier the queue starts on its branch itself, gh workflow run build.yml --ref <branch>). What the batch runs depends on project.json ci.landTier: with full, the full tier; with quick (this repository), the fast tier (verify and the Windows unit tests), and the heavy jobs too (the e2e shards, chromium and webkit) when the batch holds a change to the screen, as .github/scripts/ci-changes.mjs says (ci.screen); the batch line, its events and the messages say which tier it ran, and the main guard (full tier on main after a landing) stays the net for the rest. If main moves while a batch runs (a merge outside the queue), the batch stops before landing and its pull requests are batched again on the new main by themselves, at most 3 times each on a head, without a message. The queue posts its news (landed, needs attention, with what to relay) into the session that queued it, as a message; the answer also gives a watch command, for a Centralu that cannot post it: run in the background, it exits with the message when an item needs you or lands.'

export const tools = {
  queue_merge: {
    config: {
      title: 'Queue a pull request (or a stack) to merge when green',
      description: QUEUE_DESCRIPTION,
      inputSchema: z.object({
        pr: itemRef.describe(`The pull request to land (a stack's top): ${REF_HELP}`),
        lowers: z.array(itemRef).max(20).optional().describe('The PRs under it in a stack, landing with it; they are closed as landed and their branches deleted'),
        owner: z.string().max(80).optional().describe("Your session's name, so messages and the watch command are yours; default a new id"),
        author: z
          .string()
          .max(80)
          .optional()
          .describe('The session that opened or owns the PR, which the queue hands a conflict to; default owner (your own session), or the author recorded when it was queued before'),
        deleteBranch: z.boolean().optional().describe('Delete the head branches on GitHub after landing (never a fork\'s, never a local branch); default true'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: answering(serially(queueMerge), 'Not queued: '),
  },

  integrate: {
    config: {
      title: 'Land an auto-tier branch without opening a pull request',
      description:
        "Instead of open_pr and queue_merge (gh pr create, gh pr merge) for an auto-tier change (docs, fixture data, UI assets: .centralu/tiers.json, #1259): hand over a branch you pushed, made from main, and the integrator lands it. It judges the tier itself from GitHub's copy of the branch against main, with main's scripts/tier.mjs and rules, and refuses anything not auto with the files and rules that put it there (then open_pr, after the review its tier asks for, and queue_merge). Auto: it opens a pull request from the template as the record, a draft (labelled tier:auto, its Verified carrying the integrator's Tier line), or takes the one open from that branch (turned into a draft; refused when a tier:<name> label puts it above auto), and queues it for you as queue_merge does. The record stays a draft until the queue readies and squashes it in one step, so nothing else (merge_when_green, a merge by hand, an older board) can land it: it lands after the fast gate (a batch's quick tier on main) as \"Title (#N)\", a mechanical conflict regenerated, any other handed back to you, and its news (landed, or needs attention with what to do) is posted into your session. No stack, no draft, no base to move: one branch per change. Handing the same branch over again after a fix queues the same record again. Maintainer only; refused for a fork's branch, a branch with nothing over main, or a title whose squash subject would be over 72 characters.",
      inputSchema: z.object({
        branch: z.string().min(1).max(200).describe('The branch you pushed to this repository, made from main'),
        title: z.string().max(256).describe('Conventional commit form, e.g. "docs(apps): say how a view is reloaded"; it becomes the squash subject'),
        why: z.string().max(20000).describe("The record's Why: the problem, in a sentence or two, or the issue that argues it"),
        whatChanged: z.string().max(20000).optional(),
        verified: z.string().max(20000).optional().describe('What you ran; the integrator adds its Tier line'),
        notExercised: z.string().max(20000).describe('Surfaces this change touches that were not run ("Nothing" when true); required'),
        closes: z.string().max(2000).optional().describe('e.g. "Closes #386", or "Refs #N"'),
        owner: z.string().max(80).optional().describe("Your session's name: the queue's news and a conflict come back to it; default a new id"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: answering(integrate, 'Not integrated: '),
  },

  merge_queue: {
    config: {
      title: 'The merge queue',
      description:
        'The merge queue (queue_merge): each item waiting, in CI (alone or in a batch), needing attention (and why: dirty, failed twice and the job, a draft, …) or merged, the batches, who drives it now, and the latest messages. Instead of gh pr list / gh run list to follow merges.',
      inputSchema: z.object({
        all: z.boolean().optional().describe('Also items finished more than a day ago'),
        owner: z.string().max(80).optional().describe("Yours: list first the messages needing attention to you that you have not acknowledged (ack them with ack)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: answering(mergeQueue),
  },

  ack: {
    config: {
      title: 'Acknowledge merge queue messages',
      description:
        "Acknowledge the merge queue's messages that need attention, to you, once handled: by seq, or every one up to a seq. Until then merge_queue lists them first, the watch command without --after replays them, and each is posted into your session again once, 30 minutes after it was. Landings and other news need no ack.",
      inputSchema: z.object({
        owner: z.string().max(80).describe('The owner the messages are for: the name you queued with (not blank)'),
        seqs: z.array(z.number().int()).max(200).optional().describe('The messages to acknowledge, by seq'),
        upTo: z.number().int().optional().describe('Acknowledge every one of your messages up to this seq'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { 'centralu/risk': 'local', ui: { visibility: ['model'] } },
    },
    handler: answering(serially(ack)),
  },

  unqueue: {
    config: {
      title: 'Take a pull request out of the merge queue',
      description: 'Take a pull request (or a stack, by its top) out of the merge queue. Nothing on GitHub changes.',
      inputSchema: z.object({ pr: itemRef.describe(`The queued pull request: ${REF_HELP}`) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { 'centralu/risk': 'local' },
    },
    handler: answering(serially(unqueue)),
  },
}
