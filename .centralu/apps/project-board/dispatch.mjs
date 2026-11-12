import { cancelWorkflowRun, dispatchWorkflow, FATAL, GitHubError, readCommit, workflowRuns } from './github.mjs'
import { readBack } from './read-back.mjs'
import { sleep } from './util.mjs'

// Starting CI on a branch the queue has just moved through GitHub's API (a batch's, a bisect probe's) or on a pull request's own
// (the full tier): the queue's one way to do it (#2201). A workflow_dispatch names a ref, and GitHub resolves the name when it makes
// the run, which can be before the ref shows what the API just wrote: run 43113309704 of batch-537 ran on main's commit, not the
// batch's, and the batch waited 15 minutes for a run that could not come.

/** How many times, and how long apart, a branch is read before a run is started on it; `PROJECT_BOARD_QUEUE_SEEN_MS` is for tests only */
export const SEEN_TRIES = 6
const SEEN_WAIT_MS = Number(process.env.PROJECT_BOARD_QUEUE_SEEN_MS) || 1_000

/** A workflow's file name, from its path in the configuration (`.github/workflows/build.yml`) or as it is */
const fileOf = (workflow) => workflow.split('/').pop()

/** Reads the branch until it shows `sha`, at most `SEEN_TRIES` times. False when it never did (or could not be read). */
export async function branchShows(repo, branch, sha) {
  for (let i = 0; i < SEEN_TRIES; i++) {
    if (i) await sleep(SEEN_WAIT_MS)
    if ((await readBack(() => readCommit(repo, branch)))?.sha === sha) return true
  }
  return false
}

/**
 * Starts each of `workflows` (paths or file names) on `branch`, once the branch shows `sha`. A branch that never does is
 * dispatched all the same: `strayRuns` finds the run that came of it, and it is started once more.
 */
export async function dispatchOn(repo, workflows, branch, sha, inputs) {
  await branchShows(repo, branch, sha)
  for (const w of workflows) await dispatchWorkflow(repo, fileOf(w), branch, inputs)
}

/**
 * The runs started on `branch` since `since` (an ISO time, a minute of slack for the clocks) that are on another commit than `sha`,
 * when none is on `sha`: the dispatch ran on the branch as GitHub still had it, so no run of this commit will come. Empty otherwise.
 * Only the dispatches count: a pull request's or a push's run names the branch too.
 */
export async function strayRuns(repo, workflows, branch, sha, since) {
  const from = Date.parse(since) - 60_000
  const runs = []
  for (const w of workflows) runs.push(...(await workflowRuns(repo, fileOf(w), { branch, event: 'workflow_dispatch' })))
  const mine = runs.filter((r) => !r.createdAt || Date.parse(r.createdAt) >= from)
  return mine.some((r) => r.headSha === sha) ? [] : mine
}

/** Cancels the stray runs that have not ended: a run of the old commit holds a full run's runners. One already finished (or gone) is left. */
export async function cancelStray(repo, runs) {
  for (const run of runs.filter((r) => r.status !== 'completed')) {
    try {
      await cancelWorkflowRun(repo, run.id)
    } catch (e) {
      if (!(e instanceof GitHubError) || FATAL.has(e.kind)) throw e
    }
  }
}
