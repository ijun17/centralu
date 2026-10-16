import { execFile, spawn } from 'node:child_process'
import { open } from 'node:fs/promises'
import { devNull } from 'node:os'
import { promisify } from 'node:util'
import { programPath } from '../tool-launch.js'

const exec = promisify(execFile)

/**
 * The one place the host starts git (#407). Every git call goes through `runGit` (or `streamGit`, for an answer read
 * as it arrives); a test fails if a source file under `src/` starts git any other way (`git-exec.test.ts`).
 *
 * **Before a project is trusted, git may not run anything the repository chose.** A folder
 * copied from somewhere (a zip, a shared drive) carries its own `.git/config` and `.git/hooks`,
 * and a plain read runs several of them: `status` runs `core.fsmonitor`, the clean filter of every
 * file whose stat data changed, and the `post-index-change` hook when it writes the refreshed
 * index; `check-ignore` and `ls-files` run `core.fsmonitor`; `diff` and `show` run textconv
 * drivers and smudge and clean filters; `log` and `show` run `gpg.program` on a signed commit
 * when `log.showSignature` is set; `worktree add` runs `post-checkout`, `reference-transaction`
 * and smudge filters. Each was reproduced against git 2.54 on a copied repository.
 *
 * So unless the caller says the repository's programs may run (`allowRepoPrograms`, which a
 * read passes only for a trusted project), a call gets:
 *   - `--no-optional-locks`: the index is not rewritten, so `post-index-change` has no reason to
 *     fire, and a read leaves the folder as it found it;
 *   - `core.hooksPath` pointing at the null device: no hook can be found under it;
 *   - `core.fsmonitor=` (empty, which every git reads as off; `false` is only a boolean from git
 *     2.36 on);
 *   - `log.showSignature=false`: no signature is verified, so `gpg.program` is never started;
 *   - every filter driver configured anywhere git would look (`filter.<name>.*`, read with the
 *     same flags, so `include.path` and `includeIf` are followed exactly as the real call will)
 *     overridden to no command and not required;
 *   - and, after the subcommand, `--no-textconv --no-ext-diff` for `diff`, `show` and `log`, and
 *     `--ignore-submodules=all` for `status` and `diff`: a submodule has its own config, whose
 *     filter drivers were not listed here.
 *
 * Command-line configuration outranks every file, and git hands it to the git processes it
 * starts itself (`GIT_CONFIG_PARAMETERS`), so an included file or a nested call cannot undo it.
 *
 * What none of this touches: `safe.directory` (git honours it only from the user's own and the
 * system configuration, and nothing here sets it), `core.pager` (never started: stdout is a pipe),
 * `core.editor` (no read opens one), and the network settings (`core.sshCommand`,
 * `credential.helper`), which only a push reads. Writes the person asks for (stage, commit,
 * switch, push) run as plain git does — docs/security-boundaries.md says what that leaves open.
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
}

/**
 * **One listing of the filter drivers per folder for one operation** (#368).
 *
 * Without it, every read before trust is two git processes: the listing, then the read. Saving a worktree's work
 * before its deletion (#608) makes about fifteen reads in one folder, so thirty processes, and on windows-2022 each
 * one costs 100 ms or more: a test that deleted two worktrees ran past 15 s there. An operation that makes several
 * calls in a row creates one of these and passes it to each call; the first call in a folder lists the drivers, and
 * the rest reuse what it found.
 *
 * What this gives up: the listing and the read were already two processes, so a configuration written between them
 * was never kept out, and sharing the listing widens that window from one call to the calls that share it. A planted
 * repository's configuration is on disk before the operation starts and is turned off as before. The project's other
 * sessions keep running meanwhile, though, and can write a driver into the configuration a worktree shares. So only
 * calls that run no filter share a listing (refs, history, trees, the index); a call that reads the working tree
 * through the filters (`add`, a working-tree `diff`, a checkout) takes a listing made right before it. A listing that
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
 * Every call is given `core.quotePath=false` (#176). With the default (on), git wraps any path
 * containing a byte at or above 0x80 in quotes with octal escapes, like `"\355\225\234…"` — a
 * Korean file name came out that way in diff headers and `--name-only`, breaking the label on
 * screen and losing the path a click needed to follow it to the file. Turning it off leaves the
 * original name intact (only quotes, backslashes and control characters are still escaped).
 */
const BASE = ['-c', 'core.quotePath=false']

/**
 * `os.devNull` is `/dev/null` off Windows and `\\.\nul` on it. A hook is looked up as
 * `<hooksPath>/<name>`, which cannot exist under either. An empty folder would do the same while
 * it lasts, but a temporary one can be cleaned away and recreated by someone else.
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
    ;({ stdout } = await exec(programPath('git'), [...BASE, ...LOCKED, 'config', '-z', '--name-only', '--get-regexp', '^filter\\.'], {
      cwd,
      ...DEFAULTS,
    }))
  } catch (e) {
    // 1 = no key matched. Anything else (a broken config, a denied folder) fails the read itself
    if ((e as { code?: unknown }).code === 1) return []
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
      throw Object.assign(new Error(`git filter "${name}" cannot be turned off for a read before trust`), { code: 'internal' })
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
 * Runs git and returns its stdout, or streams it to outputFile. Buffered calls retain
 * execFile errors; streamed calls also report the exit code and bounded stderr.
 */
export async function runGit(cwd: string, args: string[], opts: RunGitOptions = {}): Promise<string> {
  const argv = await gitArgv(cwd, args, opts.allowRepoPrograms, opts.filters)
  if (opts.outputFile) {
    const output = await open(opts.outputFile, 'w', 0o600)
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(programPath('git'), argv, {
          cwd, stdio: ['pipe', output.fd, 'pipe'], timeout: opts.timeout ?? DEFAULTS.timeout,
          ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
        })
        let stderr = ''
        let overflow = false
        child.stderr!.on('data', (chunk: Buffer) => {
          if (overflow) return
          stderr += chunk.toString()
          if (Buffer.byteLength(stderr) > (opts.maxBuffer ?? DEFAULTS.maxBuffer)) {
            overflow = true
            child.kill()
          }
        })
        child.on('error', reject)
        child.on('close', (code, signal) => {
          if (code === 0 && !overflow) resolve()
          else reject(Object.assign(new Error(overflow ? 'Git stderr exceeded maxBuffer' : stderr || `Git exited with ${code ?? signal}`), { code, stderr }))
        })
        child.stdin!.on('error', () => {})
        child.stdin!.end(opts.input)
      })
      return ''
    } finally {
      await output.close()
    }
  }
  const run = exec(programPath('git'), argv, {
    cwd,
    timeout: opts.timeout ?? DEFAULTS.timeout,
    maxBuffer: opts.maxBuffer ?? DEFAULTS.maxBuffer,
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  })
  if (opts.input !== undefined) {
    /*
     * git can exit before reading what it was given (not a repository: `fatal` comes first), and
     * the write then lands on a closed pipe. A stream 'error' with no listener is an uncaught
     * exception inside the host, so it is swallowed here; the exit is what the caller reads.
     */
    run.child.stdin?.on('error', () => {})
    run.child.stdin?.end(opts.input)
  }
  const { stdout } = await run
  return stdout
}

/** Why a streamed read ended without git's own answer: it ran past its time, or the caller stopped it */
export type StreamGitEnd = 'done' | 'stopped'

/**
 * Runs git and hands its stdout over as it arrives, holding none of it (#850 review of item 10). `onChunk` returns
 * true to stop: git is ended and the read settles as `'stopped'`. For an answer of unknown size that is read once,
 * such as a status count, where a buffered read (`runGit`) would overflow its `maxBuffer` on a large tree.
 *
 * Rejects with git's stderr (bounded) and exit code when git fails, and with `{ timedOut: true }` when it does not
 * answer within `timeout`. Only the stdout is unbuffered; the call is otherwise the one `runGit` makes.
 */
export async function streamGit(
  cwd: string,
  args: string[],
  onChunk: (chunk: Buffer) => boolean,
  opts: Pick<RunGitOptions, 'allowRepoPrograms' | 'timeout' | 'filters'> = {},
): Promise<StreamGitEnd> {
  const argv = await gitArgv(cwd, args, opts.allowRepoPrograms, opts.filters)
  return new Promise<StreamGitEnd>((resolve, reject) => {
    const child = spawn(programPath('git'), argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let ended: StreamGitEnd | 'timedOut' | null = null
    const end = (why: StreamGitEnd | 'timedOut') => {
      if (ended) return
      ended = why
      child.kill()
    }
    const timer = setTimeout(() => end('timedOut'), opts.timeout ?? DEFAULTS.timeout)
    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString()
    })
    child.stdout!.on('data', (chunk: Buffer) => {
      if (!ended && onChunk(chunk)) end('stopped')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (ended === 'stopped') resolve('stopped')
      else if (ended === 'timedOut') reject(Object.assign(new Error('git did not answer in time'), { timedOut: true, stderr }))
      else if (code === 0) resolve('done')
      else reject(Object.assign(new Error(stderr || `Git exited with ${code ?? signal}`), { code, stderr }))
    })
  })
}
