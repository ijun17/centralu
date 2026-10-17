// The merge queue (#956): queue_merge, merge_queue and unqueue. The queue lives in the app's data
// folder (queue-driver.mjs) and is driven by this server while it runs and by the watch command a
// session runs in the background; the decisions are queue.mjs's.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { centralu, z } from './runtime/centralu-app-runtime.mjs'
import { itemOf, itemRef, REF_HELP } from './board.mjs'
import { canMerge, NO_PERMISSION } from './ci.mjs'
import { APP_DIR } from './config.mjs'
import { GitHubError, readPr, readRepo } from './github.mjs'
import { answering, serially } from './handlers.mjs'
import { ACTIVE, dequeue, enqueue, itemLine } from './queue.mjs'
import { queueRef, readLease, readQueue, startDriver, updateQueue } from './queue-driver.mjs'
import { answer, asError, linesAnswer } from './reply.mjs'
import { plural } from './util.mjs'

const dataDir = () => centralu.dataDir
const WATCH = join(APP_DIR, 'bin', 'merge-queue.mjs')
// Quoted for the shell the session runs it in: a POSIX shell, or on Windows PowerShell or cmd
const quote = (s) => (/^[\w./:@-]+$/.test(s) ? s : process.platform === 'win32' ? `"${s}"` : `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`)

/** The command a session runs in the background to hear about its items (bin/merge-queue.mjs). */
export function watchCommand({ owner, after }) {
  return ['node', quote(WATCH), 'watch', '--data', quote(dataDir()), ...(owner ? ['--owner', quote(owner)] : []), '--after', String(after)].join(' ')
}

/** Starts this server's driver; called once from server.mjs. */
export function startQueue() {
  const holder = `server:${process.pid}`
  const driver = startDriver(dataDir(), { holder })
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
  if (!active) return `Nothing queued.${pause}`
  if (lease && Date.parse(lease.until) > now) return `Driven by ${String(lease.holder).startsWith('server:') ? 'the board app' : 'a watch command'}.${pause}`
  return `Driven by the board app while it runs, and by a watch command while one runs.${pause}`
}

const COUNTS = [
  ['attention', 'need attention'],
  ['ci', 'in CI'],
  ['waiting', 'waiting'],
  ['merged', 'merged'],
  ['closed', 'closed'],
]

/** The queue for agents and the screen: one line per item, attention first. */
export function queueView({ all = false } = {}) {
  const q = readQueue(dataDir())
  const order = ['attention', 'ci', 'waiting', 'merged', 'closed']
  const items = q.items
    .filter((i) => all || ACTIVE.has(i.state) || Date.now() - Date.parse(i.updatedAt) < 24 * 3600_000)
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
  const counts = Object.fromEntries(COUNTS.map(([s]) => [s, items.filter((i) => i.state === s).length]))
  const parts = COUNTS.filter(([s]) => counts[s]).map(([s, words]) => `${counts[s]} ${words}`)
  const summary = `Merge queue: ${parts.length ? parts.join(', ') : 'empty'}. ${driverLine(q)}`
  return {
    summary,
    lines: items.map((i) => itemLine(i, queueRef)),
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
      state: i.state,
      reason: i.reason,
      head: i.head,
      commit: i.commit ?? null,
      queuedAt: i.queuedAt,
      updatedAt: i.updatedAt,
      lastError: i.lastError ?? null,
    })),
    events: q.events.filter((e) => e.notify).slice(-10),
  }
}

async function queueMerge({ pr, lowers = [], owner, deleteBranch = true }) {
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
  if (problems.length) return asError(answer(`Not queued: ${problems.join(' ')}`, { queued: false, kind: 'refused' }))

  const who = owner?.trim() || `queue-${randomBytes(3).toString('hex')}`
  const at = new Date().toISOString()
  const r = updateQueue(dataDir(), (q) => {
    const out = enqueue(q, { repo: top.repo, pr: top.number, lowers: under.map((l) => l.number), owner: who, deleteBranch, title: p.title, at }, queueRef)
    return { ...out, seq: q.seq, active: q.items.filter((i) => ACTIVE.has(i.state)).length }
  })
  if (r.error) return asError(answer(`Not queued: ${r.error}`, { queued: false, kind: 'conflict' }))
  const watch = watchCommand({ owner: who, after: r.seq })
  const stack = under.length ? ` with ${under.map((l) => l.ref).join(', ')} under it (one squash through ${top.ref}; they close as landed)` : ''
  const summary = `${r.replaced ? 'Queued again' : 'Queued'} ${top.ref} ${p.title}${stack}, for ${who}. ${plural(r.active, 'item')} in the queue. It merges once green; reruns a cancelled run, or failed jobs, once per head.`
  const text = [
    summary,
    `To hear in this session when it needs you or lands, run in the background (it exits with the message; run it again after):`,
    watch,
  ].join('\n')
  return answer(text, { queued: true, owner: who, watch, seq: r.seq })
}

async function mergeQueue({ all = false }) {
  const v = queueView({ all })
  return linesAnswer(v.summary, [['items', '', v.lines]], { counts: v.counts, queue: v.queue, events: v.events, pause: v.pause, seq: v.seq })
}

async function unqueue({ pr }) {
  const want = itemOf(pr)
  const removed = updateQueue(dataDir(), (q) => dequeue(q, { repo: want.repo, pr: want.number, at: new Date().toISOString() }, queueRef))
  if (!removed) return asError(answer(`${want.ref} is not in the merge queue.`, { removed: false }))
  return answer(`Took ${want.ref} out of the merge queue; nothing on GitHub changed.`, { removed: true })
}

const QUEUE_DESCRIPTION =
  'Queue pull requests to merge on their own, instead of a gh loop of gh pr merge and gh run rerun: one PR, or a stack as pr (the top) plus lowers (the PRs under it), which lands as one squash through the top after moving its base to main and closes the lowers with "Landed in #N". The queue runs in this app (it survives sessions and restarts): green and mergeable → squash with --match-head-commit and delete the branch; a cancelled run is rerun once per head, failed jobs once per head; failing again, DIRTY, a draft, or anything it cannot fix → it tells the session that queued it. Maintainer only; never merges anything not green or a draft. The answer gives a watch command to run in the background: it exits with the message when an item needs you or lands.'

export const tools = {
  queue_merge: {
    config: {
      title: 'Queue a pull request (or a stack) to merge when green',
      description: QUEUE_DESCRIPTION,
      inputSchema: z.object({
        pr: itemRef.describe(`The pull request to land (a stack's top): ${REF_HELP}`),
        lowers: z.array(itemRef).max(20).optional().describe('The PRs under it in a stack, landing with it; they are closed as landed and their branches deleted'),
        owner: z.string().max(80).optional().describe("Your session's name, so messages and the watch command are yours; default a new id"),
        deleteBranch: z.boolean().optional().describe('Delete the head branches on GitHub after landing (never a fork\'s, never a local branch); default true'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ['model'] } },
    },
    handler: answering(serially(queueMerge), 'Not queued: '),
  },

  merge_queue: {
    config: {
      title: 'The merge queue',
      description:
        'The merge queue (queue_merge): each item waiting, in CI, needing attention (and why: dirty, failed twice and the job, a draft, …) or merged, who drives it now, and the latest messages. Instead of gh pr list / gh run list to follow merges.',
      inputSchema: z.object({ all: z.boolean().optional().describe('Also items finished more than a day ago') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: answering(mergeQueue),
  },

  unqueue: {
    config: {
      title: 'Take a pull request out of the merge queue',
      description: 'Take a pull request (or a stack, by its top) out of the merge queue. Nothing on GitHub changes.',
      inputSchema: z.object({ pr: itemRef.describe(`The queued pull request: ${REF_HELP}`) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler: answering(serially(unqueue)),
  },
}
