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

// The checkout rebase_stack works from by default: the one this app is committed in
export const APP_DIR = fileURLToPath(new URL('.', import.meta.url))
