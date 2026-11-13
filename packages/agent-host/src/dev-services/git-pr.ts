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
 * What PR status knows precisely is exactly what gitBranchMerged cannot see (squash and rebase
 * merges — the dominant outcome for a GitHub PR): MERGED is not an inference, it is a fact the
 * server recorded.
 *
 * This function fails quietly. Two branches of failure are returned as distinct:
 *   - `'unavailable'` — gh itself is missing (ENOENT). The answer will not change on asking
 *     again, so the caller is right to stop asking for the rest of this process.
 *   - `null` — unknown for now (no PR, offline, not a GitHub repository, not authenticated).
 *     Asking again later may get an answer.
 * Neither branch throws — this signal is the basis for one badge, not a precondition for the
 * session list. But a gh that fails for any reason other than "no pull request" (its sign-in
 * expired, the network, GitHub refusing) is said once in the host's log with gh's own line
 * (#841): read as "no PR" alone, a badge that never came had no trace of why.
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

/** A pull request's checks on its head (docs/plans/mailbox.md §18.3): how many there are, how many still run, how many failed */
export type PrChecks = { state: BranchPr['state']; headOid: string; total: number; pending: number; failed: number }

/** A check run's ends that are not a pass: what the notice counts as failed */
const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])

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
  for (const c of j.statusCheckRollup) {
    if (!isObj(c)) continue
    const end = typeof c.conclusion === 'string' && c.conclusion ? c.conclusion : typeof c.state === 'string' ? c.state : ''
    const running = 'status' in c ? c.status !== 'COMPLETED' : end === 'PENDING' || end === 'EXPECTED'
    if (running) pending++
    else if (FAILED.has(end)) failed++
  }
  return { state: prState(j.state), headOid: j.headRefOid, total: j.statusCheckRollup.length, pending, failed }
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
   * to read the remotes); in the host's group it spared them (#982 review). It ends the tree at once (no grace: gh holds
   * no lock files), and returns when gh has exited and its output has closed, or a second after the exit.
   *
   * They work in the project's folder, and Windows refuses to remove a folder a running process works in (EBUSY). On
   * macOS and Linux the tree kill does not reach a child that left gh's process group, and that child can hold the
   * output open for as long as it runs, which must not hold the host's shutdown (nor does it hold the folder there:
   * those systems remove a folder a process works in).
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
