import { dispatchWorkflow, FATAL, GitHubError, readCommit, workflowRuns } from './github.mjs'
import { sleep } from './util.mjs'

// Starting CI on a branch the queue has just moved through GitHub's API (a batch's, a bisect probe's): the queue's one way to
// do it (#2201). A workflow_dispatch names a ref, and GitHub resolves the name when it makes the run, which can be
// before the ref shows what the API just wrote: run 43113309704 of batch-537 ran on main's commit, not the batch's, and the batch
// waited 15 minutes for a run that could not come.

/**
 * What GitHub shows after a write whose answer may have been lost (gh failing on the connection with "EOF" says
 * nothing about whether GitHub carried it out): the answer of `read` (a pull request, a branch's head). Null when it
 * cannot be read now: a failure that would repeat for every call (rate limit, no network, no login) still throws.
 */
export async function readBack(read) {
  try {
    return await read()
  } catch (e) {
    if (e instanceof GitHubError && FATAL.has(e.kind)) throw e
    return null
  }
}

/** How many times, and how long apart, a branch is read before a run is started on it; `PROJECT_BOARD_QUEUE_SEEN_MS` is for tests only */
export const SEEN_TRIES = 6
const SEEN_WAIT_MS = Number(process.env.PROJECT_BOARD_QUEUE_SEEN_MS) || 1_000

/** Reads the branch until it shows `sha`, at most `SEEN_TRIES` times. False when it never did (or could not be read). */
export async function branchShows(repo, branch, sha) {
  for (let i = 0; i < SEEN_TRIES; i++) {
    if (i) await sleep(SEEN_WAIT_MS)
    if ((await readBack(() => readCommit(repo, branch)))?.sha === sha) return true
  }
  return false
}

/**
 * Starts each of `workflows` (file names) on `branch`, once the branch shows `sha`. A branch that never does is
 * dispatched all the same: `strayRun` finds the run that came of it, and it is started once more.
 */
export async function dispatchOn(repo, workflows, branch, sha, inputs) {
  await branchShows(repo, branch, sha)
  for (const w of workflows) await dispatchWorkflow(repo, w, branch, inputs)
}

/**
 * Whether a run started on `branch` since `since` (an ISO time, a minute of slack for the clocks) is on another commit than `sha`,
 * with none on `sha`: the dispatch ran on the branch as GitHub still had it, so no run of this commit will come.
 * Only the dispatches count: a pull request's or a push's run names the branch too.
 */
export async function strayRun(repo, workflows, branch, sha, since) {
  const from = Date.parse(since) - 60_000
  const runs = []
  for (const w of workflows) runs.push(...(await workflowRuns(repo, w, { branch, event: 'workflow_dispatch' })))
  const mine = runs.filter((r) => !r.createdAt || Date.parse(r.createdAt) >= from)
  return mine.length > 0 && !mine.some((r) => r.headSha === sha)
}
