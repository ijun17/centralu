import { execFailure } from './exec-error.js'
import { devNull } from 'node:os'
import { programPath } from '../tool-launch.js'
import { raceTimeout } from '../timing.js'
import { execText } from '../os/exec.js'
import { realOs } from '../os/real.js'
import type { OsChild, RunOptions } from '../os/port.js'
import { RUN_STOP_GRACE_MS } from '../os/run.js'
import { rpcError } from '../rpc-error.js'

/**
 * The one place the host starts git (#407). Every git call goes through `runGit` (or `streamGit`, for an answer read
 * as it arrives); a test fails if a source file under `src/` starts git any other way (`git-exec.test.ts`).
 *
 * **Before a project is trusted, git may not run anything the repository chose** (unless `allowRepoPrograms`, which
 * a read passes only for a trusted project): which reads run which programs, and the flags `LOCKED`,
 * `LOCKED_SUBCOMMAND` and `filterOverrides` add against each, are in
 * docs/security-boundaries/project-trust.md "Git before trust (#407)".
 * Writes the person asks for (stage, commit, switch, push) run as plain git does.
 */

/**
 * Whether the project is trusted (#92). **Absent means untrusted**: a read then runs none of the
 * repository's programs. Only a trusted project's reads run them, as plain git would, which keeps
 * an fsmonitor-backed status fast on a large repository.
 */
export type GitTrust = { trusted?: boolean }

export type RunGitOptions = {
  /** Let the repository's hooks, filters, textconv and fsmonitor run. A read passes this only for a trusted project */
  allowRepoPrograms?: boolean
  /** Written to git's standard input */
  input?: string
  timeout?: number
  maxBuffer?: number
  /** Stream stdout to a private file instead of buffering large repository listings. */
  outputFile?: string
  /** Added to the host's environment for this call (a clone's non-interactive settings, #515) */
  env?: Record<string, string>
  /**
   * Shares one listing of each folder's filter drivers among the calls of one operation (`gitFilterListings`). The
   * listing is keyed by folder alone and made without this call's `env`: calls that change which configuration git
   * reads (`GIT_DIR`, `GIT_CONFIG_*`, `GIT_CONFIG_GLOBAL`, `HOME`) must not share one. `GIT_INDEX_FILE` does not.
   */
  filters?: GitFilterListings
  /**
   * Ends git as a timeout does (SIGTERM so git takes its `index.lock` away, SIGKILL after a grace) when it
   * fires, and rejects with `aborted` (code `ABORT_ERR`): the person cancelling a commit or push still running (#1007).
   * Already fired, git is not started.
   */
  signal?: AbortSignal
}

/**
 * **One listing of the filter drivers per folder for one operation** (#368): without it every read before trust is
 * two git processes, and on windows-2022 each costs 100 ms or more.
 *
 * Sharing widens the window between listing and read to the calls that share it, so only calls that run no filter
 * share one; a call that reads the working tree through the filters (`add`, a working-tree `diff`, a checkout) takes a
 * listing made right before it (docs/security-boundaries/project-trust.md "Git before trust (#407)"). A listing that
 * fails is not kept: the next call lists again.
 */
export type GitFilterListings = Map<string, Promise<string[]>>

export function gitFilterListings(): GitFilterListings {
  return new Map()
}

function listedFilterOverrides(cwd: string, listings: GitFilterListings): Promise<string[]> {
  let listed = listings.get(cwd)
  if (!listed) {
    listed = filterOverrides(cwd)
    listings.set(cwd, listed)
    listed.catch(() => {
      if (listings.get(cwd) === listed) listings.delete(cwd)
    })
  }
  return listed
}

const DEFAULTS = { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }

/**
 * `core.quotePath=false` (#176): by default git quotes any path with a byte at or above 0x80 as octal escapes
 * (`"\355\225\234…"`), breaking a Korean name on screen and the path a click follows. Only quotes, backslashes and
 * control characters are still escaped.
 */
const BASE = ['-c', 'core.quotePath=false']

/**
 * A hook is looked up as `<hooksPath>/<name>`, which cannot exist under the null device. Not an empty temporary
 * folder: it can be cleaned away and recreated by someone else.
 */
const LOCKED = [
  '--no-optional-locks',
  '-c', `core.hooksPath=${devNull}`,
  '-c', 'core.fsmonitor=',
  '-c', 'log.showSignature=false',
]

/** Options a subcommand needs on top of the configuration, when the repository's programs may not run */
const LOCKED_SUBCOMMAND: Record<string, string[]> = {
  status: ['--ignore-submodules=all'],
  diff: ['--no-textconv', '--no-ext-diff', '--ignore-submodules=all'],
  show: ['--no-textconv', '--no-ext-diff'],
  log: ['--no-textconv', '--no-ext-diff'],
}

/**
 * The filter drivers git would see in this folder, each turned off. A driver whose name cannot be
 * written as `-c filter.<name>.clean=` (a name with `=` in it would be cut there) refuses the
 * call instead of letting that driver through.
 */
async function filterOverrides(cwd: string): Promise<string[]> {
  let stdout: string
  try {
    ;({ stdout } = await execText(programPath('git'), [...BASE, ...LOCKED, 'config', '-z', '--name-only', '--get-regexp', '^filter\\.'], {
      cwd,
      timeoutMs: DEFAULTS.timeout,
      maxBuffer: DEFAULTS.maxBuffer,
    }))
  } catch (e) {
    // 1 = no key matched. Anything else (a broken config, a denied folder) fails the read itself
    if (execFailure(e).code === 1) return []
    throw e
  }
  const names = new Set<string>()
  for (const key of stdout.split('\0')) {
    const dot = key.lastIndexOf('.')
    if (!key.startsWith('filter.') || dot < 'filter.'.length) continue
    names.add(key.slice('filter.'.length, dot))
  }
  const out: string[] = []
  for (const name of names) {
    if (name.includes('=')) {
      throw rpcError(`git filter "${name}" cannot be turned off for a read before trust`)
    }
    out.push('-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`)
  }
  return out
}

/** The full argument list for one call — exported for tests that check what git received */
export async function gitArgv(cwd: string, args: string[], allowRepoPrograms = false, filters?: GitFilterListings): Promise<string[]> {
  if (allowRepoPrograms) return [...BASE, ...args]
  const [sub = '', ...rest] = args
  const overrides = await (filters ? listedFilterOverrides(cwd, filters) : filterOverrides(cwd))
  return [...BASE, ...LOCKED, ...overrides, sub, ...(LOCKED_SUBCOMMAND[sub] ?? []), ...rest]
}

/**
 * **The environment every git call gets** (#982): the host's, then the call's own (`env`), then these.
 *
 * - `LC_ALL=C.UTF-8`: git's own messages untranslated. Callers read them (`cloneFailure` matches "Remote branch …
 *   not found", a summary tells "not a repository" from a failure), and Git for Windows, WSL and a git built with
 *   gettext (Homebrew's) follow the locale. Not `C`: the person's hooks run under this environment too, and under `C`
 *   Ruby reads every file as US-ASCII and Java as ASCII. Where `C.UTF-8` is not installed, git falls back to `C`,
 *   which is still untranslated.
 * - `LANGUAGE=C`: gettext reads `LANGUAGE` before the locale wherever the locale is not `C` itself, which an older
 *   gettext thinks `C.UTF-8` is not.
 */
function gitEnv(own?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...own, LC_ALL: 'C.UTF-8', LANGUAGE: 'C' }
}

/** The git processes running now, each until it exits: what the host's shutdown ends (`stopGitChildren`) */
const live = new Set<OsChild>()

const running = (child: OsChild) => child.exitCode === null && child.signalCode === null

/**
 * What every git call is run with (`os.processes.run`): git as the root of a tree this host can end (`start`'s
 * `contained`: on macOS and Linux in a process group of its own, on Windows hidden), the environment above, and a
 * stop that ends the whole tree. In the host's group, which the tree kill never fires at, a hook's child would
 * outlive the call (#982).
 *
 * Its own group also takes git out of what ends the host's group (the keeper's stop, a Ctrl+C), so every git is kept
 * in `live` until it exits and the shutdown ends what is left (`stopGitChildren`): **no git outlives its host**.
 */
function runOptions(cwd: string, env: Record<string, string> | undefined, timeoutMs: number, signal?: AbortSignal): RunOptions {
  return {
    cwd,
    env: gitEnv(env),
    timeoutMs,
    signal,
    onChild: (child) => {
      live.add(child)
      const gone = () => live.delete(child)
      child.once('exit', gone)
      child.once('error', gone)
    },
  }
}

/** How long git has, after SIGTERM, to take its lock files away before SIGKILL: the grace every run gives */
export const GIT_STOP_GRACE_MS = RUN_STOP_GRACE_MS

/**
 * Ends every git still running, as a timeout would (SIGTERM so git takes its `index.lock` away, SIGKILL after the
 * grace, the whole tree; on Windows the ordered stop of `os/kill-tree.ts` at once), and settles once each has exited
 * and been swept, or the grace has passed with a margin. The keeper does not hold git, so a git left running would
 * outlive the host with the repository's locks.
 *
 * On Windows git is ended first, then what it started, parents first (#2141, #2142): MSYS's `sh` sees status 0 from
 * a hook program taskkill ended, so a git still running would make the commit the stop was meant to prevent. Both
 * are waited for: what Windows started for git is not ended with the host (measured: a hook's `sh` stayed).
 */
export async function stopGitChildren(graceMs = GIT_STOP_GRACE_MS): Promise<void> {
  const children = [...live].filter(running)
  if (children.length === 0) return
  // All at once: on Windows one reading of the process table and one sweep for every git, not two per git (#2142)
  await raceTimeout(realOs().processes.stopAll(children, graceMs).catch(() => {}), graceMs + 1000, undefined)
}

/**
 * Runs git and returns its stdout, or streams it to outputFile.
 *
 * Rejects with git's exit `code` (or the spawn's, `ENOENT` when git is missing), `signal`, `stdout` and `stderr`, as
 * `execFile` did; with `timedOut` (and `killed`) when git ran past `timeout`. **It ends when git ends** (#982): on a
 * timeout, or an output past `maxBuffer`, git's whole tree is ended, and once git has exited the call waits at most
 * `CLOSE_AFTER_EXIT_MS` for its output to close: a process git started (a hook that left something running) can hold it
 * for as long as it runs.
 */
export async function runGit(cwd: string, args: string[], opts: RunGitOptions = {}): Promise<string> {
  const argv = await gitArgv(cwd, args, opts.allowRepoPrograms, opts.filters)
  if (opts.signal?.aborted) throw gitCancelled()
  const timeout = opts.timeout ?? DEFAULTS.timeout
  // An open standard input, closed at once when there is nothing to give: git reads its end as it always did
  const r = await realOs().processes.run(programPath('git'), argv, {
    ...runOptions(cwd, opts.env, timeout, opts.signal),
    input: opts.input ?? '',
    maxBuffer: opts.maxBuffer ?? DEFAULTS.maxBuffer,
    stdoutFile: opts.outputFile,
  })
  const out = r.stdout.toString('utf8')
  const err = r.stderr.toString('utf8')
  const { code, signal, ended } = r
  // A git that finished before the cancel reached it did the write: that is the answer, not "cancelled"
  if ((!ended || ended === 'aborted') && code === 0) return out
  if (ended === 'aborted') throw Object.assign(gitCancelled(), { signal, stdout: out, stderr: err })
  // **Our own bound is the answer, whatever git printed or exited with.** The callers read `stderr` before the message,
  // and git ended by the bound says things of its own: Windows ends the tree child first, and git reports "fatal: Could
  // not read from remote repository" and exits 128 before it is itself gone. So the failure carries no output then.
  if (ended === 'timeout' || ended === 'overflow') {
    const message = ended === 'timeout' ? `git did not answer within ${timeout} ms` : 'Git output exceeded maxBuffer'
    throw Object.assign(new Error(message), { code, signal, stdout: '', stderr: '', ...(ended === 'timeout' ? { timedOut: true, killed: true } : {}) })
  }
  throw Object.assign(new Error(err || `Git exited with ${code ?? signal}`), { code, signal, stdout: out, stderr: err })
}

/** What `runGit` rejects with when its `signal` fires: git was ended, or never started */
export function gitCancelled(): Error & { code: 'ABORT_ERR'; aborted: true } {
  return Object.assign(new Error('Cancelled'), { code: 'ABORT_ERR' as const, aborted: true as const })
}

/** Whether a call failed because its `signal` fired (`gitCancelled`) */
export function isGitCancelled(e: unknown): boolean {
  return execFailure(e).aborted === true
}

/** Why a streamed read ended without git's own answer: it ran past its time, or the caller stopped it */
export type StreamGitEnd = 'done' | 'stopped'


/**
 * Runs git and hands its stdout over as it arrives, holding none of it: for an answer of unknown size in `-z` form (a
 * status count) that would overflow `runGit`'s `maxBuffer`. `onEntry` gets each NUL-terminated entry as bytes, split
 * before decoding so a character cut between chunks stays whole; true stops git (`'stopped'`). A last entry without
 * its NUL is handed over at the end.
 *
 * - `GIT_OPTIONAL_LOCKS=0`, the environment form of `--no-optional-locks` (the flag would stand where `gitArgv` reads
 *   the subcommand), so a read after every turn does not hold `index.lock` against the agent's own `git add`.
 * - **It ends when git ends**, as `runGit` does: a hook or filter git started holds the same stdout, and on Windows `kill()` reaches
 *   git.exe alone, so the whole tree is ended.
 *
 * Rejects with git's stderr (bounded) and exit code, or `{ timedOut: true }` past `timeout`.
 */
export async function streamGit(
  cwd: string,
  args: string[],
  onEntry: (entry: Buffer) => boolean,
  opts: Pick<RunGitOptions, 'allowRepoPrograms' | 'timeout' | 'filters'> = {},
): Promise<StreamGitEnd> {
  const argv = await gitArgv(cwd, args, opts.allowRepoPrograms, opts.filters)
  let rest: Buffer = Buffer.alloc(0)
  let stopped = false
  const r = await realOs().processes.run(programPath('git'), argv, {
    ...runOptions(cwd, { GIT_OPTIONAL_LOCKS: '0' }, opts.timeout ?? DEFAULTS.timeout),
    stderrKeep: { bytes: 64 * 1024, from: 'head' },
    onStdout: (chunk) => {
      let buf = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk
      for (let nul = buf.indexOf(0); nul >= 0 && !stopped; nul = buf.indexOf(0)) {
        stopped = onEntry(buf.subarray(0, nul))
        buf = buf.subarray(nul + 1)
      }
      rest = stopped ? Buffer.alloc(0) : Buffer.from(buf)
      return stopped
    },
  })
  const message = r.stderr.toString('utf8')
  if (stopped) return 'stopped'
  // Our own bound is the answer, not what git printed while it was being ended (`runGit`)
  if (r.ended === 'timeout') throw Object.assign(new Error('git did not answer in time'), { timedOut: true, stderr: '' })
  // The last entry, when git ended its answer without a NUL. git has exited: nothing is left to stop
  if (r.code === 0) return rest.length > 0 && onEntry(rest) ? 'stopped' : 'done'
  throw Object.assign(new Error(message || `Git exited with ${r.code ?? r.signal}`), { code: r.code, stderr: message })
}
