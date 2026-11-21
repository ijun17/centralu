import { isObj } from '../json-value.js'
import { execFailure } from './exec-error.js'
import { programPath } from '../tool-launch.js'
import { realOs } from '../os/real.js'

/** A branch's pull request status, asked of gh: what the merge checks know beside `gitBranchMerged` (#76). */

const OK = { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }
/** How much of the end of gh's stderr is kept for the reason it failed */
const GH_STDERR_KEEP = 4096
/** The reasons already said, so a check that runs on every refresh says each once */
const ghFailuresSaid = new Set<string>()

/** gh's own reason a lookup failed, in the host's log once; "no pull request" is an answer, not a failure */
function noteGhFailure(branch: string, e: { stderr?: string }): void {
  const lines = (e.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const first = lines[0]
  if (first === undefined || lines.some((l) => /no pull requests? found/i.test(l))) return
  const why = first.slice(0, 300)
  if (ghFailuresSaid.has(why)) return
  ghFailuresSaid.add(why)
  console.error(`[git] gh could not read the pull request of ${branch}: ${why}`)
}

export type BranchPr = {
  number: number
  state: 'open' | 'merged' | 'closed'
  url: string
  /**
   * The commit sha at the PR's head. This is what the hard gate (#76) bases its "up to date"
   * check on: the local tip has to match this before "all of the branch's work has landed in
   * that PR" is proven — a new commit stacked on after a squash merge is the one way to lose
   * work that neither is-ancestor nor the PR status can see.
   */
  headOid?: string
}

/**
 * This branch's pull request status — **asked of gh** (#76 stage 3).
 *
 * It sees what gitBranchMerged cannot (squash and rebase merges): MERGED is a fact the server recorded.
 *
 * Never throws, since it backs one badge, not the session list:
 *   - `'unavailable'` — gh itself is missing (ENOENT); the caller stops asking for the rest of this process.
 *   - `null` — unknown for now (no PR, offline, not a GitHub repository, not authenticated); asking later may answer.
 * A failure other than "no pull request" is said once in the host's log with gh's own line (#841), so a badge that
 * never came leaves a trace of why.
 */
export async function gitBranchPr(
  projectCwd: string,
  branch: string,
  signal?: AbortSignal,
  timeoutMs = OK.timeout,
): Promise<BranchPr | 'unavailable' | null> {
  const j = await ghPrView(projectCwd, branch, ['number', 'state', 'url', 'headRefOid'], signal, timeoutMs)
  if (j === 'unavailable') return 'unavailable'
  if (!j || j === 'signed_out' || typeof j.number !== 'number' || typeof j.state !== 'string' || typeof j.url !== 'string') return null
  return {
    number: j.number,
    state: prState(j.state),
    url: j.url,
    ...(typeof j.headRefOid === 'string' && j.headRefOid ? { headOid: j.headRefOid } : {}),
  }
}

const prState = (state: unknown): BranchPr['state'] => (state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open')

/** A pull request's checks on its head (docs/plans/mailbox.md §18.3): how many there are, how many still run, failed and were cancelled */
export type PrChecks = { state: BranchPr['state']; headOid: string; total: number; pending: number; failed: number; cancelled: number }

/** A check run's ends that are not a pass: what the notice counts as failed. `CANCELLED` is counted apart: a newer run cancels an older one */
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])

/**
 * The checks of pull request `number`, asked of gh as `gitBranchPr` asks it (a watch on `#123`, #1324). `'unavailable'`: gh is not installed;
 * `'signed_out'`: gh says it is not signed in; `null`: unknown for now (offline, no such pull request, GitHub refusing).
 * `statusCheckRollup` mixes check runs (`status`, `conclusion`) and commit statuses (`state`): both are read
 */
export async function prChecks(projectCwd: string, number: number, signal?: AbortSignal): Promise<PrChecks | 'unavailable' | 'signed_out' | null> {
  const j = await ghPrView(projectCwd, String(number), ['state', 'headRefOid', 'statusCheckRollup'], signal)
  if (j === null || j === 'unavailable' || j === 'signed_out') return j
  if (typeof j.state !== 'string' || typeof j.headRefOid !== 'string' || !Array.isArray(j.statusCheckRollup)) return null
  let pending = 0
  let failed = 0
  let cancelled = 0
  for (const c of j.statusCheckRollup) {
    if (!isObj(c)) continue
    const end = typeof c.conclusion === 'string' && c.conclusion ? c.conclusion : typeof c.state === 'string' ? c.state : ''
    const running = 'status' in c ? c.status !== 'COMPLETED' : end === 'PENDING' || end === 'EXPECTED'
    if (running) pending++
    else if (FAILED.has(end)) failed++
    else if (end === 'CANCELLED') cancelled++
  }
  return { state: prState(j.state), headOid: j.headRefOid, total: j.statusCheckRollup.length, pending, failed, cancelled }
}

/**
 * `gh pr view <ref> --json <fields>` in the project's folder: the object it printed, or why there is none
 */
async function ghPrView(
  projectCwd: string,
  ref: string,
  fields: string[],
  signal?: AbortSignal,
  timeoutMs = OK.timeout,
): Promise<Record<string, unknown> | 'unavailable' | 'signed_out' | null> {
  /*
   * **An abort, or running past `timeoutMs`, ends gh with the processes it started, and returns once gh is gone** (the
   * host stopping, #368; a gh that does not answer, #982). `os.processes.run` starts gh as the root of a tree this host
   * can end, as git is: off Windows in a process group of its own, so the tree kill reaches what gh started (it runs git
   * to read the remotes), which the host's group would spare. It ends the tree at once (no grace: gh holds
   * no lock files), and returns when gh has exited and its output has closed, or a second after the exit.
   *
   * They work in the project's folder, which Windows refuses to remove while they run (EBUSY). On macOS and Linux a
   * child that left gh's group can hold the output open as long as it runs, which must not hold the host's shutdown
   * (those systems remove a folder a process works in).
   */
  try {
    const run = await realOs().processes.run(programPath('gh'), ['pr', 'view', ref, '--json', fields.join(',')], {
      cwd: projectCwd,
      timeoutMs,
      maxBuffer: OK.maxBuffer,
      signal,
      stopGraceMs: 0,
      // Characters, not bytes, are kept: a character is at most four bytes
      stderrKeep: { bytes: GH_STDERR_KEEP * 4, from: 'tail' },
    })
    if (run.ended) return null
    if (run.code !== 0) {
      const stderr = run.stderr.toString('utf8').slice(-GH_STDERR_KEEP)
      noteGhFailure(ref, { stderr })
      return SIGNED_OUT.test(stderr) ? 'signed_out' : null
    }
    const j: unknown = JSON.parse(run.stdout.toString('utf8'))
    return isObj(j) ? j : null
  } catch (e) {
    // Not started at all (ENOENT) has nothing to wait for
    const failure = execFailure(e)
    if (failure.code === 'ENOENT') return 'unavailable'
    noteGhFailure(ref, failure)
    return null
  }
}

/** gh's words when it has no sign-in for the host (gh 2.83.0: "To get started with GitHub CLI, please run:  gh auth login") */
const SIGNED_OUT = /gh auth login|not logged in/i
