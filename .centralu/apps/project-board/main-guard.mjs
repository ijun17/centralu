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
import { createBranch, deleteBranch, dispatchWorkflow, GitHubError, FATAL, jobNotes, readJobLog, readRepo, rerunRun, runJobSteps, workflowRuns } from './github.mjs'
import { failingStepText } from './ci.mjs'
import { CI, config, QUEUE } from './config.mjs'
import { fetchRefs, git, GitError, remoteFor, topLevel } from './git.mjs'
import { short } from './util.mjs'
import { pathMatches } from './versions.mjs'
import { commitWithout, prOfSubject } from './main-revert.mjs'
import { CAUSE_TEXT, classifyRun, jobFailure, looksLikeNetworkError } from './run-failure.mjs'

export const GUARD_MS = Number(process.env.PROJECT_BOARD_QUEUE_GUARD_MS) || 2 * 60_000
/** A bisect probe whose run has not finished after this long ends the hunt (no runner, a stuck run): an issue says so */
export const PROBE_MAX_MS = Number(process.env.PROJECT_BOARD_QUEUE_PROBE_MS) || 2 * 3600_000
/** A rerun of main's run that GitHub has not started after this long is given up on: the failure is reported, not waited for */
export const RERUN_STUCK_MS = Number(process.env.PROJECT_BOARD_QUEUE_RERUN_STUCK_MS) || 10 * 60_000
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
  // The red commit carries a known culprit: first the last candidate, without it (red: the bisect's end; green: this red is the known one's)
  if (bad === null) return { probe: commits[commits.length - 1], index: commits.length - 1, end: true }
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

/**
 * Why a failed run of main failed (#1435), read as the queue reads a pull request's run (run-failure.mjs): the failed
 * jobs' names, the job to quote (the first that failed for real, else the first that did not), and `kind`:
 * `infrastructure` when every failed job failed in a step that sets the job up, hit its timeout or lost its runner
 * (nothing of the commit ran, or the runner went away), else `test`. A failed install step is a setup failure only when
 * its log names the network or a package source, so the log's first failure is read for it.
 */
export async function diagnose(repo, run, { failingLine, flaky = QUEUE.flakyJobs } = {}) {
  const jobs = await runJobSteps(repo, run.id)
  let failed = jobs.filter((j) => j.conclusion && !['success', 'skipped', 'neutral', 'cancelled'].includes(j.conclusion))
  // A job that ran out of time ends 'cancelled', with GitHub's word for it only in its annotation (#1503: three e2e shards,
  // `playwright install` still running, no failing line). Read those annotations as the queue does, but only when no job
  // failed: CI cancels the rest of a run when `verify` fails (fail fast), and each of those would cost a call to say nothing.
  const cancelled = failed.length ? [] : jobs.filter((j) => j.conclusion === 'cancelled')
  for (const j of [...failed, ...cancelled]) {
    j.notes = j.id != null ? await jobNotes(repo, j.id) : []
    const step = j.steps.find((s) => s.conclusion === 'failure')
    if (step && /^Run (?:pnpm|npm|yarn) /i.test(step.name) && failingLine && j.id != null) j.log = await failingLine(repo, j)
  }
  // Named with the failed jobs: a cancelled job that has a cause (the time limit, a lost runner), not one cancelled with no reason
  failed = [...failed, ...cancelled.filter((j) => jobFailure(j, { flaky })?.cause !== 'cancelled')]
  const why = classifyRun(run, jobs, { flaky })
  const first = (why.job && failed.find((j) => String(j.id) === why.job.id)) ?? failed[0] ?? null
  return { names: failed.map((j) => j.name), first, kind: why.real ? 'test' : 'infrastructure', cause: why.cause, step: why.step, inSetup: why.inSetup, shutdown: why.shutdown }
}

/** How many runs' reruns the guard remembers: a run is rerun once, and the newest are the only ones that can come up again */
const RERUNS_KEPT = 30

/** The reruns by run id with `id` added, the oldest dropped past RERUNS_KEPT (keys keep their insertion order: run ids are too large to be array indexes, which JavaScript would sort) */
export const boundedReruns = (reruns, id, record) => Object.fromEntries(Object.entries({ ...(reruns ?? {}), [id]: record }).slice(-RERUNS_KEPT))

/** The text of the step that failed first in a failed job's log; empty when the log cannot be read */
async function failingStep(repo, job) {
  if (job?.id == null) return ''
  try {
    return failingStepText(await readJobLog(repo, job.id))
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    return ''
  }
}

/** What an infrastructure failure was, in words: `"Install WebKit" in e2e (webkit 4/5): a failure in a setup step` */
const infraText = (names, step, cause) => `${step ? `step "${step}" in ` : ''}${names.length ? names.join(', ') : 'the run'}: ${CAUSE_TEXT[cause] ?? cause}`

/**
 * The culprits already found and the reverts made of them (`q.guard.known`: `{ sha, subject, pr }`, `pr` the revert's
 * pull request, or null when it was not reverted). Neither a known culprit nor a revert of one is ever a candidate
 * again (#1259 review), and a commit that still carries a known culprit (landed after it, before its revert) is
 * probed **without** it: the full tier on that commit with the culprit's change taken out, so an older failure does
 * not hide or fake a newer one.
 */
export function sortCommits(all, known) {
  const isRevert = (c) => known.some((k) => k.pr && prOfSubject(c.subject) === k.pr)
  const isKnown = (c) => known.some((k) => k.sha === c.sha)
  const listed = all.map((c, pos) => ({ ...c, pos }))
  return { all: listed, commits: listed.filter((c) => !isRevert(c) && !isKnown(c)) }
}

/** The known culprits a commit at `pos` of `all` still carries: landed before it, and not reverted by then */
export function carried(all, known, pos) {
  return known
    .map((k) => ({ k, at: all.findIndex((c) => c.sha === k.sha), revertAt: k.pr ? all.findIndex((c) => prOfSubject(c.subject) === k.pr) : -1 }))
    .filter(({ at, revertAt }) => at >= 0 && at < pos && (revertAt < 0 || revertAt > pos))
    .map(({ k }) => k.sha)
}

/**
 * One guard step. `update(fn)` changes the queue file (the driver's `updateQueue`); `act(found)` is called
 * once with the culprit (`{ red, culprit, how }`), or with `{ red, culprit: null, why }` when it cannot be
 * found, and answers what to record (`outcome` and anything else), or null when another driver holds the
 * lease. `probeCommit` makes a commit without known culprits for a probe. Answers what it did.
 */
export async function guardTick({ q, update, now = Date.now(), renew, act, dir = QUEUE.conflicts.checkout, failingLine, probeCommit = commitWithout }) {
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
  const hunted = g.hunted ?? []
  const known = g.known ?? []
  const ctx = { save, now, renew, act, repo, dir, defaultBranch, probeCommit, known, hunted }

  // Green: remembered as the last fully green commit. A hunt is over: the red was not main's for long (a flake), or what it did fixed it
  if (!red) {
    if (hunt?.probe?.branch && !hunt.endedAt) await deleteBranch(repo, hunt.probe.branch).catch(() => {})
    save({ green: green ?? g.green ?? null, hunt: null })
    return { did: 'green', green }
  }
  // A hunt under way goes on. A newer red waits for it and is not dropped: once the hunt ends, the newest red not yet
  // looked into starts the next one, over the commits since the last green one without what is known already
  if (hunt && !hunt.endedAt) return await stepHunt({ hunt, ...ctx })
  if (hunted.includes(red.headSha)) {
    save({})
    return { did: 'acted', outcome: hunt?.outcome ?? null }
  }
  const greenSha = green ?? g.green ?? null
  const jobs = await diagnose(repo, red, { failingLine })
  const line = jobs.first && failingLine ? await failingLine(repo, jobs.first) : ''
  const base = { red: red.headSha, run: red.id, url: red.url ?? null, jobs: jobs.names, line, kind: jobs.kind, cause: jobs.cause, step: jobs.step ?? null, at: new Date(now).toISOString() }
  const stop = async (why) => {
    const record = await act({ red: base, culprit: null, why })
    if (!record) return { did: 'yielded' }
    save({ hunt: { ...base, ...record, endedAt: new Date(now).toISOString() }, hunted: [...hunted, base.red].slice(-50) })
    return { did: 'unknown', why }
  }
  // A failure in the runner's setup is not the commit's (#1435, 2026-10-21: a package source answered 403 to the browser
  // install and the queue opened a revert of reviewed work): the job is rerun once, and a commit is looked for only if the
  // rerun fails inside the test steps. A second infrastructure failure is reported, never reverted.
  let listed = null
  if (jobs.kind === 'infrastructure') {
    const what = infraText(jobs.names, jobs.step, jobs.cause)
    // One record per run (`guard.reruns`, by run id), not one for the newest: while a rerun of one red run is going, `mainVerdict`
    // shows the older red run, and a single slot would have each rerun the other for ever
    const rerun = g.reruns?.[red.id] ?? (g.rerun?.run === red.id ? g.rerun : null)
    if (!rerun) {
      if (renew && !renew()) return { did: 'yielded' }
      // Written down before it is asked for, as the queue does: a rerun asked for twice would spend the one it is allowed
      save({ reruns: boundedReruns(g.reruns, red.id, { attempt: red.attempt ?? 1, at: base.at, what, shutdown: jobs.shutdown === true, jobs: jobs.names }) })
      try {
        await rerunRun(repo, red.id, { failedOnly: true })
      } catch (e) {
        if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
        return stop(`it is an infrastructure failure (${what}), and GitHub refused to rerun the job: ${e.message} Nothing was reverted.`)
      }
      return { did: 'rerun', run: red.id }
    }
    // Asked for, and GitHub has not started it yet
    if ((red.attempt ?? 1) <= rerun.attempt) {
      if (now - Date.parse(rerun.at) <= RERUN_STUCK_MS) {
        save({})
        return { did: 'waiting', run: red.id }
      }
      return stop(`it is an infrastructure failure (${what}), and the rerun asked for at ${rerun.at.slice(11, 16)} UTC has not started. Nothing was reverted.`)
    }
    // A timeout, or a job on the flaky list, that fails again after a rerun may be the commit's (it hangs, it breaks that job
    // only), so it is looked for as a test failure. A timeout inside a step that sets the job up (#1503: three e2e shards
    // ran out of time in `playwright install`, a slow package mirror) is the setup's, like a failure there: nothing of the
    // commit's tests ran, so it is the runner's unless a commit since the last green one changed what the setup installs.
    //
    // A runner shutdown (#1507) that hits the same job again on the rerun is not a blip: a commit can exhaust the runner's
    // memory or disk, and GitHub then says only that the runner was shut down. It is looked for as a test failure, and
    // reverted if the hunt finds it. The first time, and a different job's, are still the runner's: rerun, and reported.
    const again = jobs.shutdown === true && rerun.shutdown === true && jobs.names.some((name) => (rerun.jobs ?? []).includes(name))
    if (again || (jobs.cause !== 'setup' && jobs.cause !== 'runner' && !jobs.inSetup)) base.kind = 'test'
    else {
      // Failed in setup (or lost its runner) again. Setup runs on the runner, but what it installs is a commit's to change:
      // the browser's version comes from the lockfile, the system libraries from build.yml, and none of that runs on a pull
      // request (only main's full tier), so a bad bump lands green and fails here on every attempt (#1450 review). When a
      // commit since the last green one changed such an input, it is hunted; else the runner's, and reported.
      let touched = []
      let unlisted = ''
      if (jobs.cause === 'setup' || jobs.inSetup) {
        if (!greenSha || !dir) unlisted = ' The commits since the last green one could not be listed to see whether one changed what the setup installs.'
        else {
          try {
            ;({ commits: listed } = await commitsBetween(dir, repo, defaultBranch, greenSha, red.headSha))
            touched = listed.filter((c) => c.files.some((f) => QUEUE.guard.setupInputs.some((p) => pathMatches(p, f))))
          } catch (e) {
            if (!(e instanceof GitError)) throw e
            unlisted = ` The commits since the last green one could not be listed to see whether one changed what the setup installs: ${e.message}`
          }
        }
      }
      // The failing step names the network or a package source (a 403, a gateway error, a timeout, a mirror out of step) on any of
      // its lines, not only the first error one (a real outage prints "could not connect" as warnings and then "Unable to locate
      // package"): an outage that lasted through the rerun, whatever the commits touched. Hunting would blame one of them for the
      // runner's failure (#1429's harm). Leaning to "network" costs an issue while main stays red; the other way blames a commit.
      if (touched.length && looksLikeNetworkError(`${base.line}\n${await failingStep(repo, jobs.first)}`))
        return stop(
          `it is an infrastructure failure (${what}), and it failed the same way again after one rerun. Its failing step names the network or a package source, so none of the ${touched.length} commit${touched.length === 1 ? '' : 's'} that changed what the setup installs (${touched.map((c) => short(c.sha)).join(', ')}) is blamed. Nothing was reverted: rerun the job by hand, or look at the runner.`,
        )
      if (!touched.length)
        return stop(
          `it is an infrastructure failure (${what}), and it failed the same way again after one rerun.${
            listed ? ` None of the ${listed.length} commit${listed.length === 1 ? '' : 's'} since the last green one changed what the setup installs (queue.guard.setupInputs), so none is blamed.` : unlisted || ''
          } Nothing was reverted: rerun the job by hand, or look at the runner.`,
        )
      base.kind = 'setup'
      base.touched = touched.map((c) => short(c.sha))
    }
  }
  if (!greenSha) return stop(`no fully green commit of main is known in its last ${runs.length} runs, so the commits to look at are not known.`)
  if (!dir) return stop('the queue has no checkout to list the commits since the last green one in.')
  try {
    if (!listed) ({ commits: listed } = await commitsBetween(dir, repo, defaultBranch, greenSha, red.headSha))
  } catch (e) {
    if (!(e instanceof GitError)) throw e
    return stop(`listing the commits since the last green one, ${short(greenSha)}, failed: ${e.message}`)
  }
  if (!listed.length) return stop(`no commit is on main between the last green one, ${short(greenSha)}, and ${short(red.headSha)}.`)
  const { all, commits } = sortCommits(listed, known)
  // The red commit still carries a known culprit: it may be red only for that one, so its own run proves nothing
  const endCarries = carried(all, known, all.length).length > 0
  const fresh = { ...base, green: greenSha, all, commits, good: -1, bad: endCarries ? null : commits.length - 1, probe: null }
  // Nothing left but known culprits and their reverts: this red is theirs, already reported
  if (!commits.length) {
    save({ hunt: { ...fresh, outcome: 'explained', endedAt: new Date(now).toISOString() }, hunted: [...hunted, base.red].slice(-50) })
    return { did: 'explained' }
  }
  if (commits.length === 1 && !endCarries) return finish({ hunt: fresh, culprit: commits[0], how: 'the only commit since the last green one', ...ctx })
  // A suspect by the failed jobs' paths is confirmed with the full tier around it before anything is done about it
  const byPaths = endCarries ? null : attributeByPaths(commits, jobs.names, QUEUE.guard.jobPaths)
  const confirm = byPaths ? { index: commits.findIndex((c) => c.sha === byPaths), how: `the only commit since the last green one that touches the paths of ${jobs.names.join(', ')}` } : null
  return await stepHunt({ hunt: { ...fresh, confirm }, ...ctx })
}

async function finish({ hunt, culprit, how, save, now, act, known, hunted }) {
  const record = await act({ red: hunt, culprit, how })
  // Another driver holds the lease now: it acts
  if (!record) return { did: 'yielded' }
  save({
    hunt: { ...hunt, probe: null, culprit: { sha: culprit.sha, subject: culprit.subject, how }, ...record, endedAt: new Date(now).toISOString() },
    hunted: [...hunted, hunt.red].slice(-50),
    // Known from now on: never a candidate again, and taken out of the commits that still carry it when they are probed
    known: [...known, { sha: culprit.sha, subject: culprit.subject, pr: record.revert?.pr ?? null }].slice(-50),
  })
  return { did: 'culprit', culprit: culprit.sha, how }
}

/** One bisect step: start the probe's run, or read it and halve the range */
async function stepHunt(ctx) {
  const { hunt, save, now, renew, act, repo, dir, defaultBranch, probeCommit, known, hunted } = ctx
  const ended = (record) => save({ hunt: { ...hunt, probe: null, ...record, endedAt: new Date(now).toISOString() }, hunted: [...hunted, hunt.red].slice(-50) })
  const step = nextStep(hunt)
  // The suspect by paths was not the first red commit: bisect what is left, its probes' answers kept
  if (step.refuted) return await stepHunt({ ...ctx, hunt: { ...hunt, confirm: null, refuted: hunt.confirm.how } })
  if (step.culprit) return finish({ ...ctx, culprit: step.culprit, how: step.how })
  const probe = hunt.probe
  if (!probe || probe.sha !== step.probe.sha || probe.again) {
    if (renew && !renew()) return { did: 'yielded' }
    const branch = probeBranch(step.probe.sha)
    // A commit still carrying a known culprit is probed without it: that commit with the culprit's change taken out
    const without = carried(hunt.all ?? hunt.commits, known, step.probe.pos ?? step.index)
    let head = step.probe.sha
    if (without.length) {
      const made = await probeCommit({ dir, repo, defaultBranch, base: step.probe.sha, shas: without, branch, message: `Probe: ${step.probe.subject}, without ${without.map(short).join(', ')}\n` })
      if (made.error) {
        const record = await act({ red: hunt, culprit: null, why: `${short(step.probe.sha)} could not be probed without ${without.map(short).join(', ')}: ${made.error}` })
        if (!record) return { did: 'yielded' }
        ended(record)
        return { did: 'unknown' }
      }
      head = made.sha
    } else {
      try {
        await createBranch(repo, branch, step.probe.sha)
      } catch (e) {
        if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
        // Left by an earlier try: it points at the same commit, so it is used as it is
      }
    }
    await dispatchWorkflow(repo, WORKFLOW, branch, CI.fullTier ? { tier: 'full' } : undefined)
    const tries = probe?.sha === step.probe.sha ? (probe.tries ?? 1) + 1 : 1
    save({ hunt: { ...hunt, probe: { sha: step.probe.sha, head, without, index: step.index, end: step.end === true, branch, at: new Date(now).toISOString(), tries } } })
    return { did: 'probing', sha: step.probe.sha }
  }
  const runs = (await workflowRuns(repo, WORKFLOW, { branch: probe.branch, event: 'workflow_dispatch' })).filter((r) => r.headSha === (probe.head ?? probe.sha))
  // Started after this probe was: a run of an earlier try on the same commit does not answer it
  const run = runs.find((r) => !r.createdAt || Date.parse(r.createdAt) >= Date.parse(probe.at) - 60_000)
  if (!run || run.status !== 'completed') {
    // No runner, or a run that never ends: the hunt gives up rather than wait for good
    if (now - Date.parse(probe.at) > PROBE_MAX_MS) {
      await deleteBranch(repo, probe.branch).catch(() => {})
      const record = await act({ red: hunt, culprit: null, why: `the full tier's run on ${short(probe.sha)} (a bisect step) had not finished after ${Math.round(PROBE_MAX_MS / 60_000)} minutes.` })
      if (!record) return { did: 'yielded' }
      ended(record)
      return { did: 'unknown' }
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
    ended(record)
    return { did: 'unknown' }
  }
  // The red commit, without the known culprits it carries, passed: this red is theirs, already reported
  if (probe.end && run.conclusion === 'success') {
    save({ hunt: { ...hunt, probe: null, outcome: 'explained', endedAt: new Date(now).toISOString() }, hunted: [...hunted, hunt.red].slice(-50) })
    return { did: 'explained' }
  }
  const next = run.conclusion === 'success' ? { ...hunt, good: probe.index, probe: null } : { ...hunt, bad: probe.index, probe: null }
  return await stepHunt({ ...ctx, hunt: next })
}
