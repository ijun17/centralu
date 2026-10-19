// The main guard (#1259 step 1): with changes landing after the fast tier (project.json ci.landTier
// "quick"), the full tier runs on main after they land. When main's full run fails, the guard finds the
// commit that broke it among those since main was last fully green, and acts on it (main-revert.mjs):
//
//   one candidate      it is the culprit
//   by the job's paths  every failed job has paths in project.json queue.guard.jobPaths, and exactly one
//                       candidate touches them
//   bisect             otherwise: the full tier on candidate commits (a branch queue/bisect-<sha> at the
//                       commit and a workflow_dispatch of build.yml on it), halving the range each time
//
// Decisions are pure functions here; `guardTick` reads GitHub and the checkout for them and keeps its
// state in the queue file (`q.guard`), so it carries on in whichever driver holds the lease, and after
// either restarts. It runs in the same ticks as the queue, at most once per GUARD_MS.
import { createBranch, deleteBranch, dispatchWorkflow, GitHubError, FATAL, readRepo, runJobSteps, workflowRuns } from './github.mjs'
import { CI, config, QUEUE } from './config.mjs'
import { fetchRefs, git, GitError, remoteFor, topLevel } from './git.mjs'
import { short } from './util.mjs'

export const GUARD_MS = Number(process.env.PROJECT_BOARD_QUEUE_GUARD_MS) || 2 * 60_000
/** A bisect probe whose run has not finished after this long ends the hunt (no runner, a stuck run): an issue says so */
export const PROBE_MAX_MS = Number(process.env.PROJECT_BOARD_QUEUE_PROBE_MS) || 2 * 3600_000
const WORKFLOW = 'build.yml'
const REF_SPACE = 'refs/centralu-guard'

/**
 * Main's state from its push runs (newest first): `green`, the newest commit whose run passed; `red`, the
 * newest completed run that failed, when it is newer than that green one; `unfinished`, how many are still
 * going (the queue holds landing while too many are, `QUEUE.guard.maxMainRuns`). Runs on main are never
 * cancelled by a newer push (build.yml's concurrency, #1259), so every commit's run is seen; one cancelled by
 * hand says nothing, nor does one still running.
 */
export function mainVerdict(runs) {
  const done = runs.filter((r) => r.status === 'completed' && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped')
  const greenAt = done.findIndex((r) => r.conclusion === 'success')
  const redAt = done.findIndex((r) => r.conclusion !== 'success')
  const green = greenAt >= 0 ? done[greenAt].headSha : null
  const red = redAt >= 0 && (greenAt < 0 || redAt < greenAt) ? done[redAt] : null
  return { green, red, unfinished: runs.filter((r) => r.status !== 'completed').length }
}

/** Whether a failed job's name falls under a jobPaths key: the key is the name, or its start (a matrix job's shards) */
const jobMatches = (key, name) => name === key || name.startsWith(`${key} `) || name.startsWith(`${key}(`)

/**
 * The culprit by the failed jobs' paths, or null when that is not unambiguous: every failed job must have
 * paths, exactly one candidate (`{ sha, files }`) touches any of them, and that one touches nothing outside
 * them (a change elsewhere may be what broke it). Only a suspect: the guard confirms it with the full tier on
 * the commit before it (green) and on it (red) before it acts (`nextStep`).
 */
export function attributeByPaths(candidates, failedJobs, jobPaths = {}) {
  if (!failedJobs.length) return null
  const paths = []
  for (const job of failedJobs) {
    const key = Object.keys(jobPaths).find((k) => jobMatches(k, job))
    if (!key) return null
    paths.push(...jobPaths[key])
  }
  const within = (f) => paths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))
  const touching = candidates.filter((c) => c.files.some(within))
  if (touching.length !== 1 || !touching[0].files.every(within)) return null
  return touching[0].sha
}

/**
 * The next commit to run the full tier on, or the culprit. `commits` oldest first, the last one the red
 * commit; `good` the index of the last commit known green (-1: main's last green commit, before them all),
 * `bad` the first known red. Answers `{ culprit }` once they are next to each other, else `{ probe }`.
 */
export function bisectStep(commits, good, bad) {
  if (bad - good <= 1) return { culprit: commits[bad] }
  return { probe: commits[Math.floor((good + bad) / 2)], index: Math.floor((good + bad) / 2) }
}

/**
 * What the hunt does next: `{ culprit, how }`, or `{ probe, index }` (the full tier on that commit), or
 * `{ refuted }` when a suspect by paths (`hunt.confirm`) turned out not to be the first red commit; the hunt
 * then bisects what is left. A suspect is the culprit only once the commit before it passed and it failed.
 */
export function nextStep(hunt) {
  const { commits, good, bad, confirm } = hunt
  if (confirm) {
    const k = confirm.index
    if (good === k - 1 && bad === k) return { culprit: commits[k], how: `${confirm.how}, confirmed: the full tier passed on the commit before it and failed on it` }
    if (good >= k || bad < k) return { refuted: true }
    const index = good < k - 1 ? k - 1 : k
    return { probe: commits[index], index }
  }
  const s = bisectStep(commits, good, bad)
  return s.culprit ? { culprit: s.culprit, how: 'bisected: the full tier passed on the commit before it and failed on it' } : s
}

/** The branch a probe runs on: one per commit, deleted once its run has spoken */
export const probeBranch = (sha) => `queue/bisect-${String(sha).slice(0, 12)}`

/**
 * The commits after `green` up to `red` on main's first-parent line, oldest first, each with its subject
 * and the files it changed. From the checkout: fetched from GitHub's remote into a ref space of the
 * guard's own, so the checkout's branches and work are never touched.
 */
export async function commitsBetween(dir, repo, defaultBranch, green, red) {
  const root = await topLevel(dir)
  const remote = await remoteFor(root, repo)
  if (!remote) throw new GitError(`the checkout at ${root} has no remote for github.com/${repo}`)
  await fetchRefs(root, remote, [`refs/heads/${defaultBranch}`], REF_SPACE)
  const shas = (await git(root, ['rev-list', '--reverse', '--first-parent', `${green}..${red}`])).split('\n').filter(Boolean)
  const out = []
  for (const sha of shas) {
    const subject = (await git(root, ['log', '-1', '--format=%s', sha])).trim()
    const files = (await git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', sha])).split('\n').filter(Boolean)
    out.push({ sha, subject, files })
  }
  return { root, remote, commits: out }
}

/** The failed jobs of a run: names, and the first one's id (for its first failing line) */
async function failedJobs(repo, runId) {
  const jobs = await runJobSteps(repo, runId)
  const failed = jobs.filter((j) => j.conclusion && !['success', 'skipped', 'neutral', 'cancelled'].includes(j.conclusion))
  return { names: failed.map((j) => j.name), first: failed[0] ?? null }
}

/**
 * One guard step. `update(fn)` changes the queue file (the driver's `updateQueue`); `act(found)` is called
 * once with the culprit (`{ red, culprit, how }`), or with `{ red, culprit: null, why }` when it cannot be
 * found, and answers what to record (`outcome` and anything else). Answers what it did.
 */
export async function guardTick({ q, update, now = Date.now(), renew, act, dir = QUEUE.conflicts.checkout, failingLine }) {
  if (!QUEUE.guard) return { did: 'off' }
  const g = q.guard ?? {}
  if (g.nextAt && Date.parse(g.nextAt) > now) return { did: 'wait' }
  const repo = config.repository
  const { defaultBranch } = await readRepo(repo)
  const runs = await workflowRuns(repo, WORKFLOW, { event: 'push', branch: defaultBranch })
  const { green, red, unfinished } = mainVerdict(runs)
  // Main's newest run still going: a landing not judged yet, which keeps the app running (queueBusy)
  const pending = runs.length > 0 && runs[0].status !== 'completed'
  const save = (patch) => update((fresh) => (fresh.guard = { ...(fresh.guard ?? {}), pending, unfinished, ...patch, nextAt: new Date(now + GUARD_MS).toISOString() }))
  const hunt = g.hunt ?? null

  // Green: remembered as the last fully green commit. A hunt is over: the red was not main's for long (a flake), or what it did fixed it
  if (!red) {
    if (hunt?.probe?.branch && !hunt.outcome) await deleteBranch(repo, hunt.probe.branch).catch(() => {})
    save({ green: green ?? g.green ?? null, hunt: null })
    return { did: 'green', green }
  }
  // A hunt in progress, or one that acted on this red (or on a red run older than its end): carry on or wait
  const settled = hunt?.outcome && hunt.endedAt
  if (hunt && (!settled || red.headSha === hunt.red || (red.createdAt && Date.parse(red.createdAt) <= Date.parse(hunt.endedAt)))) {
    if (settled) {
      save({})
      return { did: 'acted', outcome: hunt.outcome }
    }
    return await stepHunt({ hunt, save, now, renew, act, repo })
  }
  // A new red
  const greenSha = green ?? g.green ?? null
  const jobs = await failedJobs(repo, red.id)
  const line = jobs.first && failingLine ? await failingLine(repo, jobs.first) : ''
  const base = { red: red.headSha, run: red.id, url: red.url ?? null, jobs: jobs.names, line, at: new Date(now).toISOString() }
  const stop = async (why) => {
    const record = await act({ red: base, culprit: null, why })
    if (!record) return { did: 'yielded' }
    save({ hunt: { ...base, ...record, endedAt: new Date(now).toISOString() } })
    return { did: 'unknown', why }
  }
  if (!greenSha) return stop(`no fully green commit of main is known in its last ${runs.length} runs, so the commits to look at are not known.`)
  if (!dir) return stop('the queue has no checkout to list the commits since the last green one in.')
  let commits
  try {
    ;({ commits } = await commitsBetween(dir, repo, defaultBranch, greenSha, red.headSha))
  } catch (e) {
    if (!(e instanceof GitError)) throw e
    return stop(`listing the commits since the last green one, ${short(greenSha)}, failed: ${e.message}`)
  }
  if (!commits.length) return stop(`no commit is on main between the last green one, ${short(greenSha)}, and ${short(red.headSha)}.`)
  const fresh = { ...base, green: greenSha, commits, good: -1, bad: commits.length - 1, probe: null }
  if (commits.length === 1) return finish({ hunt: fresh, culprit: commits[0], how: 'the only commit since the last green one', save, now, act })
  // A suspect by the failed jobs' paths is confirmed with the full tier around it before anything is done about it
  const byPaths = attributeByPaths(commits, jobs.names, QUEUE.guard.jobPaths)
  const confirm = byPaths ? { index: commits.findIndex((c) => c.sha === byPaths), how: `the only commit since the last green one that touches the paths of ${jobs.names.join(', ')}` } : null
  return await stepHunt({ hunt: { ...fresh, confirm }, save, now, renew, act, repo })
}

async function finish({ hunt, culprit, how, save, now, act }) {
  const record = await act({ red: hunt, culprit, how })
  // Another driver holds the lease now: it acts
  if (!record) return { did: 'yielded' }
  save({ hunt: { ...hunt, probe: null, culprit: { sha: culprit.sha, subject: culprit.subject, how }, ...record, endedAt: new Date(now).toISOString() } })
  return { did: 'culprit', culprit: culprit.sha, how }
}

/** One bisect step: start the probe's run, or read it and halve the range */
async function stepHunt({ hunt, save, now, renew, act, repo }) {
  const step = nextStep(hunt)
  // The suspect by paths was not the first red commit: bisect what is left, its probes' answers kept
  if (step.refuted) return await stepHunt({ hunt: { ...hunt, confirm: null, refuted: hunt.confirm.how }, save, now, renew, act, repo })
  if (step.culprit) return finish({ hunt, culprit: step.culprit, how: step.how, save, now, act })
  const probe = hunt.probe
  if (!probe || probe.sha !== step.probe.sha || probe.again) {
    if (renew && !renew()) return { did: 'yielded' }
    const branch = probeBranch(step.probe.sha)
    try {
      await createBranch(repo, branch, step.probe.sha)
    } catch (e) {
      if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
      // Left by an earlier try: it points at the same commit, so it is used as it is
    }
    await dispatchWorkflow(repo, WORKFLOW, branch, CI.fullTier ? { tier: 'full' } : undefined)
    const tries = probe?.sha === step.probe.sha ? (probe.tries ?? 1) + 1 : 1
    save({ hunt: { ...hunt, probe: { sha: step.probe.sha, index: step.index, branch, at: new Date(now).toISOString(), tries } } })
    return { did: 'probing', sha: step.probe.sha }
  }
  const runs = (await workflowRuns(repo, WORKFLOW, { branch: probe.branch, event: 'workflow_dispatch' })).filter((r) => r.headSha === probe.sha)
  // Started after this probe was: a run of an earlier try on the same commit does not answer it
  const run = runs.find((r) => !r.createdAt || Date.parse(r.createdAt) >= Date.parse(probe.at) - 60_000)
  if (!run || run.status !== 'completed') {
    // No runner, or a run that never ends: the hunt gives up rather than wait for good
    if (now - Date.parse(probe.at) > PROBE_MAX_MS) {
      await deleteBranch(repo, probe.branch).catch(() => {})
      const why = `the full tier's run on ${short(probe.sha)} (a bisect step) had not finished after ${Math.round(PROBE_MAX_MS / 60_000)} minutes.`
      const record = await act({ red: hunt, culprit: null, why })
      save({ hunt: { ...hunt, probe: null, ...record, endedAt: new Date(now).toISOString() } })
      return { did: 'unknown', why }
    }
    save({ hunt })
    return { did: 'waiting', sha: probe.sha }
  }
  await deleteBranch(repo, probe.branch).catch(() => {})
  if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') {
    // Started again once; cancelled twice, the bisect cannot go on
    if ((probe.tries ?? 1) < 2) {
      save({ hunt: { ...hunt, probe: { ...probe, again: true } } })
      return { did: 'retry', sha: probe.sha }
    }
    const record = await act({ red: hunt, culprit: null, why: `the full tier's run on ${short(probe.sha)} (a bisect step) was cancelled twice.` })
    if (!record) return { did: 'yielded' }
    save({ hunt: { ...hunt, probe: null, ...record, endedAt: new Date(now).toISOString() } })
    return { did: 'unknown' }
  }
  const next = run.conclusion === 'success' ? { ...hunt, good: probe.index, probe: null } : { ...hunt, bad: probe.index, probe: null }
  return await stepHunt({ hunt: next, save, now, renew, act, repo })
}
