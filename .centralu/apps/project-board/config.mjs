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
function fullTierOf(v) {
  return typeof v === 'string' && v ? v : null
}
export const CACHE_MS = Math.max(0, Number(config.cacheSeconds ?? 30)) * 1000
// CI (ci_status, merge_when_green): which workflows hold the required checks, the issue that lists
// known intermittent failures, and how long merge_when_green may wait.
export const CI = {
  workflows: config.ci?.workflows ?? ['.github/workflows/build.yml'],
  knownFailures: config.ci?.knownFailuresIssue ?? null,
  waitMinutes: Number(config.ci?.waitMinutes ?? 40),
  // PROJECT_BOARD_CI_POLL_MS: for the tests only, which cannot wait 30 s between polls
  pollMs: Number(process.env.PROJECT_BOARD_CI_POLL_MS) || Number(config.ci?.pollSeconds ?? 30) * 1000,
  // Two tiers (2026-10-18): the name of the check that passes only on a full run (build.yml's `full
  // tier` job). Set, nothing lands on a run where it did not pass: the merge queue lands such a pull
  // request through a batch, merge_when_green refuses it, and a release bump's PR is no evidence.
  // PROJECT_BOARD_CI_FULL_TIER: for the tests only, which run the queue without tiers too (empty: none)
  fullTier: fullTierOf(process.env.PROJECT_BOARD_CI_FULL_TIER ?? config.ci?.fullTier),
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
}

