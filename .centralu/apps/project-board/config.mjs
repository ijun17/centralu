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
export const CACHE_MS = Math.max(0, Number(config.cacheSeconds ?? 30)) * 1000
// CI (ci_status, merge_when_green): which workflows hold the required checks, the issue that lists
// known intermittent failures, and how long merge_when_green may wait.
export const CI = {
  workflows: config.ci?.workflows ?? ['.github/workflows/build.yml'],
  knownFailures: config.ci?.knownFailuresIssue ?? null,
  waitMinutes: Number(config.ci?.waitMinutes ?? 40),
  // PROJECT_BOARD_CI_POLL_MS: for the tests only, which cannot wait 30 s between polls
  pollMs: Number(process.env.PROJECT_BOARD_CI_POLL_MS) || Number(config.ci?.pollSeconds ?? 30) * 1000,
}

// The merge queue's batches (#962, batch.mjs): off unless project.json has `queue.batch`. `min` items
// waiting for CI that has not started make a batch (at least 2), `max` at most (default 6).
// PROJECT_BOARD_QUEUE_BATCH_MIN: for the tests only, which queue several pull requests one call at a time
const batch = config.queue?.batch
const batchMin = Number(process.env.PROJECT_BOARD_QUEUE_BATCH_MIN) || Number(batch?.min ?? 2) || 2
export const QUEUE = {
  batch: batch && batch.enabled !== false ? { min: Math.max(2, batchMin), max: Math.max(2, batchMin, Number(batch.max ?? 6) || 6) } : null,
}

// The checkout rebase_stack works from by default: the one this app is committed in
export const APP_DIR = fileURLToPath(new URL('.', import.meta.url))
