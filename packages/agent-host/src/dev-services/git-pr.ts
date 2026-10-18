import { killTree } from './kill-tree.js'
import { killHandle, spawnGrouped } from './grouped-child.js'
import { programPath } from '../tool-launch.js'
import { raceTimeout } from '../timing.js'

/** A branch's pull request status, asked of gh: what the merge checks know beside `gitBranchMerged` (#76). */

const OK = { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }
/** How much of the end of gh's stderr is kept for the reason it failed */
const GH_STDERR_KEEP = 4096
/** The reasons already said, so a check that runs on every refresh says each once */
const ghFailuresSaid = new Set<string>()

/** gh's own reason a lookup failed, in the host's log once; "no pull request" is an answer, not a failure */
function noteGhFailure(branch: string, e: { stderr?: unknown }): void {
  const lines = String(e.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length || lines.some((l) => /no pull requests? found/i.test(l))) return
  const why = lines[0]!.slice(0, 300)
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
  /*
   * Started as the root of a tree this host can end (`spawnGrouped`), as git is: off Windows in a process group of its
   * own, so the tree kill below reaches what gh started (it runs git to read the remotes); in the host's group it
   * spared them (#982 review). No `timeout` of execFile's own either: it ended gh alone. Running past `timeoutMs`
   * takes the abort's path.
   */
  const { child } = spawnGrouped(programPath('gh'), ['pr', 'view', branch, '--json', 'number,state,url,headRefOid'], {
    cwd: projectCwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out: Buffer[] = []
  let outBytes = 0
  child.stdout!.on('data', (chunk: Buffer) => {
    outBytes += chunk.length
    if (outBytes <= OK.maxBuffer) out.push(chunk)
  })
  let err = ''
  child.stderr!.on('data', (chunk: Buffer) => {
    err = (err + chunk.toString('utf8')).slice(-GH_STDERR_KEEP)
  })
  const run = new Promise<string>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(Object.assign(new Error(`gh exited with ${code}`), { code, stderr: err }))))
  })
  const closed = new Promise<void>((done) => child.once('close', () => done()))
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  /*
   * **An abort, or running past `timeoutMs`, ends gh with the processes it started, and returns once gh is gone** (the
   * host stopping, #368; a gh that does not answer, #982).
   * They work in the project's folder, and Windows refuses to remove a folder a running process works in (EBUSY).
   * `killTree` ends the tree (gh's group; `taskkill /T /F` on Windows). The wait is for gh's `exit`, then for `close`
   * (every process holding gh's output has ended) for at most a second: on macOS and Linux the tree kill does not
   * reach a child that left gh's process group, and that child can hold the output open for as long as it runs,
   * which must not hold the host's shutdown (nor does it hold the folder there: those systems remove a folder a
   * process works in).
   */
  const stop = () => {
    killTree(killHandle(child), 'SIGKILL')
    // gh itself as well, should the tree kill have found no group to fire at
    child.kill('SIGKILL')
  }
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      stop()
      void exited
        .then(() => raceTimeout(closed, 1000, undefined))
        .then(() => reject(Object.assign(new Error('gh was stopped'), { code: 'ABORT_ERR' })))
    }
  })
  aborted.catch(() => {})
  if (signal?.aborted) onAbort!()
  else signal?.addEventListener('abort', onAbort!, { once: true })
  const timer = setTimeout(onAbort!, timeoutMs)
  try {
    const stdout = await Promise.race([run, aborted])
    const j = JSON.parse(stdout) as { number?: unknown; state?: unknown; url?: unknown; headRefOid?: unknown }
    if (typeof j.number !== 'number' || typeof j.state !== 'string' || typeof j.url !== 'string') return null
    return {
      number: j.number,
      state: j.state === 'MERGED' ? 'merged' : j.state === 'CLOSED' ? 'closed' : 'open',
      url: j.url,
      ...(typeof j.headRefOid === 'string' && j.headRefOid ? { headOid: j.headRefOid } : {}),
    }
  } catch (e) {
    // Not started at all (ENOENT) has nothing to wait for
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'unavailable'
    noteGhFailure(branch, e as { stderr?: unknown })
    return null
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}
