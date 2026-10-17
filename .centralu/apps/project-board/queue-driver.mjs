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
import { CI, config } from './config.mjs'
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
  rerunRun,
  runsForHead,
  sameRepo,
  setPrBase,
} from './github.mjs'
import { ACTIVE, attentionText, decideBefore, decideCi, dueItem, itemKey, normalize, emptyQueue, noticeKey, POLL_MS, pushEvent, resetFor } from './queue.mjs'
import { short } from './util.mjs'

export const QUEUE_FILE = 'merge-queue.json'
export const LEASE_FILE = 'merge-queue.lease.json'
/** A driver that stops renewing for this long (killed, asleep) hands the queue to the next one. */
export const LEASE_MS = 3 * 60_000
const PAUSE_MIN_MS = 60_000
const PAUSE_MAX_MS = 15 * 60_000
const PERMISSIONS_MS = 10 * 60_000

// PROJECT_BOARD_QUEUE_POLL_MS: for the tests only, which cannot wait 90 s between polls
const pollOverride = Number(process.env.PROJECT_BOARD_QUEUE_POLL_MS) || 0
const pollMs = (kind) => pollOverride || POLL_MS[kind]
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

/** Takes or renews the lease for `holder`. False when another driver holds a fresh one. */
export function takeLease(dir, holder, now = Date.now()) {
  const cur = readLease(dir)
  if (cur && cur.holder !== holder && Date.parse(cur.until) > now) return false
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
async function permissionsOf(repo, now) {
  const hit = permissionsSeen.get(repo)
  if (hit && now - hit.at < PERMISSIONS_MS) return hit
  const r = await readRepo(repo)
  const v = { at: now, permissions: r.permissions, defaultBranch: r.defaultBranch }
  permissionsSeen.set(repo, v)
  return v
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
 * Lands an item that is green and mergeable: checks every open lower is inside the top's head, then
 * squash-merges the top on the head that was read. Answers the outcome; `afterMerge` does the rest.
 */
async function land(item, pr, ref, renew) {
  const repo = item.repo
  const n = ref(repo, item.pr)
  for (const l of item.lowers ?? []) {
    const lp = await readPr(repo, l)
    if (lp.state === 'OPEN' && !(await containsCommit(repo, lp.headRefOid, pr.headRefOid)))
      return {
        state: 'attention',
        reason: {
          kind: 'stack',
          text: `${n} does not contain the head ${short(lp.headRefOid)} of ${ref(repo, l)}, which would be closed as landed. Restack ${n} onto it and push, or queue ${n} again without ${ref(repo, l)}.`,
        },
      }
  }
  if (!renew()) return { yielded: true }
  const msg = squashMessage({ number: pr.number, title: pr.title, description: pr.body })
  const why = await mergePr(repo, pr.number, pr.headRefOid, msg.subject, msg.body)
  if (why) return { state: 'attention', reason: { kind: 'refused', text: `GitHub refused to merge ${n} at ${short(pr.headRefOid)}: ${why}. Look at the PR; the queue tries again on a new head.` } }
  let merged = pr
  try {
    merged = await readPr(repo, pr.number)
  } catch {
    // merged either way; the commit id is a nicety
  }
  return { state: 'merged', merged: { ...pr, mergeCommit: merged.mergeCommit ?? null }, subject: msg.subject }
}

/**
 * After the top merged (here, or found merged: a driver stopped between the merge and writing it
 * down, or someone merged it by hand): deletes its branch, closes the open lowers its head contains
 * with "Landed in #N" and deletes their branches, unless another open pull request is based on one.
 * A lower the top does not contain stays open and is named. Answers the message for the session.
 */
async function afterMerge(item, pr, ref, subject) {
  const repo = item.repo
  const n = ref(repo, item.pr)
  const commit = pr.mergeCommit?.oid ?? null
  const notes = []
  const stack = new Set([item.pr, ...(item.lowers ?? [])])
  const gone = (e) => !e || /Reference does not exist|HTTP 422|Not Found/i.test(e)
  if (item.deleteBranch !== false) {
    if (pr.isCrossRepository) notes.push(`kept ${pr.headRefName} (a fork's)`)
    else {
      const e = await deleteBranch(repo, pr.headRefName)
      if (!gone(e)) notes.push(`could not delete ${pr.headRefName}: ${e}`)
    }
  }
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
  if (item.deleteBranch !== false) {
    for (const lp of lowers.filter((x) => !x.isCrossRepository)) {
      const on = (await openPrsOnBase(repo, lp.headRefName)).filter((k) => !stack.has(k))
      if (on.length) {
        notes.push(`kept ${lp.headRefName}: ${on.map((k) => ref(repo, k)).join(', ')} ${on.length === 1 ? 'is' : 'are'} based on it`)
        continue
      }
      const e = await deleteBranch(repo, lp.headRefName)
      if (!gone(e)) notes.push(`could not delete ${lp.headRefName}: ${e}`)
    }
  }
  const how = subject ? ` as ${short(commit)}, "${subject}"` : ` as ${short(commit)} (merged before this poll, by the queue or by hand)`
  return `Merge queue: merged ${n}${item.title ? ` (${item.title})` : ''}${how}.${closed.length ? ` Closed ${closed.join(', ')} as landed in it.` : ''}${notes.length ? ` Note: ${notes.join('; ')}.` : ''}`
}

/**
 * Reads one item's pull request and CI, decides, and acts. Answers what to write back: the new state
 * and fields, the events, and when to read it again. Throws only what stops every item (rate limit,
 * no network, no login).
 */
async function pollItem(item, { now, ref, renew }) {
  const repo = item.repo
  const at = new Date(now).toISOString()
  const { permissions, defaultBranch } = await permissionsOf(repo, now)
  const pr = await readPr(repo, item.pr, QUEUE_PR_FIELDS)
  const base = { title: pr.title, ...resetFor(item, pr.headRefOid) }
  const view = { ...item, ...base }
  const events = []
  if (item.head && item.head !== pr.headRefOid) events.push({ kind: 'head', text: `${ref(repo, item.pr)}: head moved from ${short(item.head)} to ${short(pr.headRefOid)}; starting again on it.` })

  let d = decideBefore({ item: view, permissions, pr, ref })
  if (!d) {
    let required = view.required
    if (!required || required.base !== pr.baseRefName || required.head !== pr.headRefOid) {
      const r = await readRequired(repo, pr.baseRefName, CI.workflows, workflowCheckNames, pr.headRefOid)
      required = { base: pr.baseRefName, head: pr.headRefOid, names: r.names, unresolved: r.unresolved }
      base.required = required
    }
    const checks = evaluateChecks({ required: required.names, reported: await readChecks(repo, pr.headRefOid), alsoReported: required.unresolved.length > 0 })
    const runs = checks.verdict === 'failing' || checks.verdict === 'none' ? await runsForHead(repo, pr.headRefOid, CI.workflows) : []
    let lowerBranches = []
    if (checks.verdict === 'green' && pr.baseRefName !== defaultBranch && item.lowers?.length)
      lowerBranches = (await Promise.all(item.lowers.map((l) => readPr(repo, l).catch(() => null)))).filter(Boolean).map((l) => l.headRefName)
    d = decideCi({ item: view, pr, checks, runs, defaultBranch, lowerBranches, now, ref })
  }

  let wait = pollMs(d.state === 'attention' ? 'attention' : d.state === 'waiting' ? 'waiting' : 'ci')
  const patch = { ...base, ...(d.patch ?? {}) }
  if (d.event) events.push({ kind: 'action', text: d.event })
  if (d.action?.type === 'rerun') {
    if (!renew()) return { yielded: true }
    await rerunRun(repo, d.action.runId, { failedOnly: d.action.failedOnly })
    wait = pollMs('acted')
  } else if (d.action?.type === 'retarget') {
    if (!renew()) return { yielded: true }
    await setPrBase(repo, item.pr, d.action.base)
    wait = pollMs('waiting')
  } else if (d.action?.type === 'merge' && item.reason?.kind === 'refused' && item.head === pr.headRefOid) {
    // GitHub refused this head once: asking again changes nothing until the head or the PR does
    d = { state: 'attention', reason: item.reason }
  } else if (d.action?.type === 'merge') {
    const landed = await land(view, pr, ref, renew)
    if (landed.yielded) return { yielded: true }
    d = landed
  }

  if (d.state === 'merged') {
    const merged = d.merged ?? pr
    const text = await afterMerge(view, merged, ref, d.subject)
    Object.assign(patch, { mergedAt: at, commit: merged.mergeCommit?.oid ?? null })
    events.push({ kind: 'merged', text, notify: true })
  } else if (d.state === 'closed') {
    events.push({ kind: 'closed', text: `Merge queue: ${ref(repo, item.pr)}${pr.title ? ` (${pr.title})` : ''} was closed without merging; it is off the queue.`, notify: true })
  }

  if (d.state === 'attention') {
    const key = noticeKey(d.reason, pr.headRefOid)
    if (key !== item.noticeKey) {
      const extra = d.reason.kind === 'failed' || d.reason.kind === 'failing' ? await failingLine(repo, d.reason.job) : ''
      const reason = { ...d.reason, text: `${d.reason.text}${extra}` }
      Object.assign(patch, { reason, noticeKey: key })
      events.push({ kind: 'attention', text: attentionText({ ...item, title: pr.title }, reason, ref), notify: true })
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
  if (!active.length) {
    releaseLease(dir, holder)
    return { did: 'idle' }
  }
  if (q.pause && Date.parse(q.pause.until) > now) return { did: 'paused', until: q.pause.until }
  if (!takeLease(dir, holder, now)) return { did: 'busy', holder: readLease(dir)?.holder ?? null }
  q = readQueue(dir)
  const item = dueItem(q, now)
  if (!item) return { did: 'idle' }
  const key = itemKey(item)
  const at = new Date(now).toISOString()
  // Before every write to GitHub: still the driver? (A driver asleep past its lease must not act.)
  const renew = () => takeLease(dir, holder, Date.now())
  let r
  try {
    r = await pollItem(item, { now, ref, renew })
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
      if (it) Object.assign(it, { lastError: message, nextAt: new Date(now + pollMs('error')).toISOString() })
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
    for (const ev of r.events) pushEvent(fresh, target, { kind: ev.kind, text: ev.text, notify: ev.notify === true, at })
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
  const loop = async () => {
    if (stopped) return
    let done
    running = new Promise((resolve) => (done = resolve))
    try {
      const r = await tick(dir, { holder, ref })
      onTick?.(r)
    } catch (e) {
      console.error(`[project-board] merge queue: ${e?.message ?? e}`)
    } finally {
      done()
    }
    if (!stopped) {
      timer = setTimeout(loop, tickMs)
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
