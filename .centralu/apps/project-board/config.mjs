// The board app's settings: project.json, read once at start (which project, the cache, CI, the rules
// and the release layout), and the checkout this app is committed in.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const config = await readFile(new URL('./project.json', import.meta.url), 'utf8')
  .then((t) => JSON.parse(t))
  .catch((e) => {
    console.error(`project.json could not be read: ${e.message}`)
    process.exit(1)
  })
for (const key of ['owner', 'number', 'repository', 'fields', 'decisionStatus']) {
  if (config[key] === undefined) {
    console.error(`project.json is missing "${key}"`)
    process.exit(1)
  }
}
/** A list of non-empty names, or null when it is not one (then landing after the fast tier refuses to start) */
function quickChecksOf(v) {
  if (v === undefined || v === null) return []
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim()) ? v.map((x) => x.trim()) : null
}

function fullTierOf(v) {
  return typeof v === 'string' && v ? v : null
}

/**
 * A batch that changes the screen runs the heavy jobs before it lands (#1538): `{ judge, checks, steps, inputs }`, null when it
 * is not set, `false` when it is set wrongly (then landing after the fast tier refuses to start).
 */
function screenOf(v) {
  if (v === undefined || v === null) return null
  const names = Array.isArray(v.checks) && v.checks.length > 0 && v.checks.every((x) => typeof x === 'string' && x.trim()) ? v.checks.map((x) => x.trim()) : null
  const judge = typeof v.judge === 'string' && v.judge.trim() ? v.judge.trim() : null
  const steps = Array.isArray(v.steps) && v.steps.length > 0 && v.steps.every((x) => typeof x === 'string' && x.trim()) ? v.steps.map((x) => x.trim()) : null
  const given = v.inputs === undefined ? { tier: 'full' } : v.inputs
  const inputs = given && typeof given === 'object' && !Array.isArray(given) ? Object.fromEntries(Object.entries(given).map(([k, x]) => [k, String(x)])) : null
  return names && judge && steps && inputs ? { judge, checks: names, steps, inputs } : false
}
export const CACHE_MS = Math.max(0, Number(config.cacheSeconds ?? 30)) * 1000
// CI (ci_status, merge_when_green): which workflows hold the required checks, the issue that lists
// known intermittent failures.
export const CI = {
  workflows: config.ci?.workflows ?? ['.github/workflows/build.yml'],
  knownFailures: config.ci?.knownFailuresIssue ?? null,
  // Two tiers (2026-10-18): the name of the check that passes only on a full run (build.yml's `full
  // tier` job). Set, nothing lands on a run where it did not pass: the merge queue lands such a pull
  // request through a batch, merge_when_green refuses it, and a release bump's PR is no evidence.
  // PROJECT_BOARD_CI_FULL_TIER: for the tests only, which run the queue without tiers too (empty: none)
  fullTier: fullTierOf(process.env.PROJECT_BOARD_CI_FULL_TIER ?? config.ci?.fullTier),
  // What a change lands after, with two tiers (#1259, the owner's decision of 2026-10-19): `quick`, its own quick
  // run and its batch's run of the quick tier (the full tier runs on main after it lands, and the main guard reverts
  // what breaks it); `full` (the default), nothing lands without a full run on what lands.
  // PROJECT_BOARD_CI_LAND_TIER: for the tests only
  landTier: (process.env.PROJECT_BOARD_CI_LAND_TIER ?? config.ci?.landTier) === 'quick' ? 'quick' : 'full',
  // The quick tier, named (#1259 review): with `landTier` "quick", a batch lands only when each of these checks was
  // reported and succeeded on its run (a name, or `*` for any run of characters: "windows tests (vitest *)"). Not
  // whatever the run happened to report: a renamed job, or one a broken `changes` switched off, reports nothing, and
  // that must not land. PROJECT_BOARD_CI_QUICK_CHECKS (the list as JSON): for the tests only
  quickChecks: quickChecksOf(process.env.PROJECT_BOARD_CI_QUICK_CHECKS ? JSON.parse(process.env.PROJECT_BOARD_CI_QUICK_CHECKS) : config.ci?.quickChecks),
  // A batch that holds a pull request changing the screen runs the heavy jobs before it lands (the owner, 2026-10-26,
  // #1538); the other batches land after the fast tier as above. `judge`: the script on the default branch that says which
  // files change the screen (the one definition, .github/scripts/ci-changes.mjs `--screen`: this app keeps no path list of
  // its own); `checks`: the heavy jobs, each of which must have been reported and succeeded (names as quickChecks); `inputs`:
  // what the workflow is started with for such a batch (the full tier, the files leaving out what they cannot affect);
  // `steps`: the step each of those jobs runs the scenarios in, which must have succeeded in the job itself (the job of a
  // left-out shard reports a check of the same name, a stand-in that only echoes: a name alone cannot tell the two apart).
  // Only with `landTier` "quick" (with "full" every batch runs the full tier). PROJECT_BOARD_CI_SCREEN ("off", or the
  // object as JSON): for the tests only
  screen: screenOf(process.env.PROJECT_BOARD_CI_SCREEN ? (process.env.PROJECT_BOARD_CI_SCREEN === 'off' ? null : JSON.parse(process.env.PROJECT_BOARD_CI_SCREEN)) : config.ci?.screen),
}
if (CI.screen === false) {
  console.error('project.json: ci.screen needs "judge" (a script on the default branch), "checks" (a non-empty list of check names), "steps" (a non-empty list of step names) and, if given, "inputs" (an object).')
  process.exit(1)
}
// Landing after the fast tier with no quick check named would land whatever ran: an error, not "anything goes"
if (CI.landTier === 'quick' && CI.fullTier && !CI.quickChecks?.length) {
  console.error('project.json: ci.landTier is "quick", so ci.quickChecks must name the quick tier\'s checks (a non-empty list of names; `*` for any run of characters).')
  process.exit(1)
}

// The merge queue's batches (#962, batch.mjs): off unless project.json has `queue.batch`. `min` items
// ready make a batch, `max` at most (default 4, the owner's, 2026-10-19). `min` is at least 2, or 1 with two tiers
// (`ci.fullTier`): there every pull request lands through a batch, a batch of one included.
// PROJECT_BOARD_QUEUE_BATCH_MIN: for the tests only, which queue several pull requests one call at a time
// The checkout rebase_stack and the merge queue's conflicts work from by default: the one this app is committed in
export const APP_DIR = fileURLToPath(new URL('.', import.meta.url))

const batch = config.queue?.batch
const batchMin = Number(process.env.PROJECT_BOARD_QUEUE_BATCH_MIN) || Number(batch?.min ?? 2) || 2
// The merge queue's conflicts (#1182, queue-conflict.mjs): `mechanical` lists the files a command
// regenerates (`{ files, run }`: path patterns, and the commands as argument lists, run in order
// without a shell), which the queue regenerates and pushes itself; `never` the files it never does,
// whatever `mechanical` says; `timeoutMinutes` how long one command may take. The merge is made in a
// temporary worktree of `checkout` (default the one this app is committed in).
// PROJECT_BOARD_QUEUE_CHECKOUT and PROJECT_BOARD_QUEUE_CONFLICTS (the lists as JSON): for the tests
// only, which merge in a checkout of their own and regenerate with commands of their own (empty
// checkout: none, so a conflict is handed off without a merge)
const conflicts = process.env.PROJECT_BOARD_QUEUE_CONFLICTS ? JSON.parse(process.env.PROJECT_BOARD_QUEUE_CONFLICTS) : (config.queue?.conflicts ?? {})
const checkoutEnv = process.env.PROJECT_BOARD_QUEUE_CHECKOUT
// The merge queue's rerun policy (2026-10-19, run-failure.mjs): it reruns only infrastructure failures,
// and a failed job named here (exact names, `*` for any characters) counts as one: a known-flaky job.
// PROJECT_BOARD_QUEUE_FLAKY (the list as JSON): for the tests only
// The main guard (#1259, main-guard.mjs): on where changes land after the fast tier (`ci.landTier` "quick"), unless
// `queue.guard.enabled` is false. `jobPaths` attributes a failed job to paths (a job name, or the start of a matrix
// job's, → path prefixes ending in "/" or exact paths): the culprit is then the one commit that touches them.
// PROJECT_BOARD_QUEUE_GUARD ("on" or "off"): for the tests only
const guardConf = config.queue?.guard ?? {}
const DEFAULT_SETUP_INPUTS = ['.github/**/*', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '**/package.json', '**/rust-toolchain*', '**/Cargo.lock']
const guardOn = process.env.PROJECT_BOARD_QUEUE_GUARD ? process.env.PROJECT_BOARD_QUEUE_GUARD === 'on' : guardConf.enabled !== false && CI.landTier === 'quick'
const flaky = process.env.PROJECT_BOARD_QUEUE_FLAKY ? JSON.parse(process.env.PROJECT_BOARD_QUEUE_FLAKY) : config.queue?.flakyJobs
export const QUEUE = {
  flakyJobs: Array.isArray(flaky) ? flaky.filter((x) => typeof x === 'string' && x) : [],
  batch: batch && batch.enabled !== false ? { min: Math.max(CI.fullTier ? 1 : 2, batchMin), max: Math.max(2, batchMin, Number(batch.max ?? 4) || 4) } : null,
  conflicts: {
    mechanical: Array.isArray(conflicts.mechanical) ? conflicts.mechanical.filter((e) => Array.isArray(e?.files) && Array.isArray(e?.run) && e.run.every((a) => Array.isArray(a) && a.length > 0)) : [],
    never: Array.isArray(conflicts.never) ? conflicts.never : [],
    timeoutMs: Math.max(1, Number(conflicts.timeoutMinutes ?? 30) || 30) * 60_000,
    checkout: checkoutEnv !== undefined ? checkoutEnv || null : (conflicts.checkout ?? APP_DIR),
  },
  guard: guardOn
    ? {
        // The queue lands nothing while more of main's full runs than this are unfinished (#1259): each landing adds one
        maxMainRuns: Math.max(1, Number(process.env.PROJECT_BOARD_QUEUE_MAX_MAIN_RUNS) || Number(guardConf.maxMainRuns ?? 3) || 3),
        jobPaths: Object.fromEntries(
          Object.entries(guardConf.jobPaths ?? {}).filter(([k, v]) => k && Array.isArray(v) && v.every((p) => typeof p === 'string' && p)),
        ),
        // What the steps that set a job up read (#1435): the browser install takes its version from the lockfile, the system
        // libraries come from build.yml, the toolchain from its pin. A commit that changes one of these may be what fails
        // setup, twice, so main's red is hunted when one is among the commits since the last green.
        setupInputs: (Array.isArray(guardConf.setupInputs) ? guardConf.setupInputs : DEFAULT_SETUP_INPUTS).filter((p) => typeof p === 'string' && p),
      }
    : null,
}

