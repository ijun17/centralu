import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorMessage } from '@cc/protocol'
import { execFailure } from './exec-error.js'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit, streamGit, stopGitChildren } from './git-exec.js'
import { cloneFailure } from './project-clone.js'
import { settle } from './process-tree.test-helpers.js'
import { ownProcesses, pidIn } from '../process.test-helpers.js'
import { SLOW } from '../../../../tooling/test-timing.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

/** A path a hook's `sh` can run: Git for Windows' sh takes forward slashes */
const shPath = (p: string) => JSON.stringify(p.replace(/\\/g, '/'))

/*
 * #982: `runGit` gave git the host's locale, and what reads its stderr (`cloneFailure`) matches English. On a machine
 * whose git is translated (Homebrew's, or a Linux one with a language pack, under `LANG=de_DE.UTF-8`) a missing
 * branch fell through to the generic line. Not `LC_ALL=C` either: the person's hooks run under the same environment,
 * and under C Ruby reads every file as US-ASCII.
 */
describe("git's messages untranslated, text still UTF-8 (#982)", () => {
  let root: string
  afterEach(async () => {
    vi.unstubAllEnvs()
  })

  const german = () => {
    vi.stubEnv('LC_ALL', 'de_DE.UTF-8')
    vi.stubEnv('LANG', 'de_DE.UTF-8')
    vi.stubEnv('LANGUAGE', 'de')
  }

  /*
   * Fails without the fix only where git is translated and a German locale is installed (Homebrew's git on macOS);
   * CI's runners have neither, and there it passes either way. The test below is the guard everywhere.
   */
  it('names the missing branch of a clone under a German locale (meaningful only where git is translated)', async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-git-locale-')))
    const source = join(root, 'source')
    mkdirSync(source)
    git(source, 'init', '-q')
    git(source, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'one')
    german()
    // `cloneArgs` refuses a local source (`protocol.file.allow=never`); the failure and its reading are the same
    const failed = await runGit(root, ['clone', '--branch', 'nope', '--', source, join(root, 'into')], { allowRepoPrograms: true }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(failed).not.toBeNull()
    expect(cloneFailure(failed, source, 'nope')).toBe('The repository has no branch "nope".')
  })

  // The guard on every machine: what git and its hooks get, whether or not this machine's git is translated
  it("gives git, and the hooks it runs, an untranslated UTF-8 locale whatever the host's", async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-git-locale-')))
    german()
    // An alias that runs a shell command sees what a hook sees
    const env = await runGit(root, ['-c', 'alias.showenv=!env', 'showenv'], { allowRepoPrograms: true })
    const lcAll = env.split(/\r?\n/).find((line) => line.startsWith('LC_ALL='))
    expect(lcAll).toBe('LC_ALL=C.UTF-8')
  })
})

/*
 * #982: on a timeout `execFile` ended git alone. A hook's child (a test run, a type check) kept running, held git's
 * output so the call did not settle until it ended, and on Windows kept the folder busy (EBUSY on a later remove).
 */
describe('a git that runs past its time ends with what it started (#982)', () => {
  let root: string
  let childPid: number | undefined
  // The wait below sees the child end; a number seen ended is not signalled afterwards (#1308)
  let own = ownProcesses()
  const alive = (pid: number) => own.alive(pid)
  afterEach(async () => {
    if (childPid !== undefined) own.end([childPid])
    childPid = undefined
    own = ownProcesses()
  })

  it("ends the hook's child and settles", { timeout: 30_000 * SLOW }, async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-git-timeout-')))
    const repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'test@test')
    git(repo, 'config', 'user.name', 'test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    const pidFile = join(root, 'child.pid')
    const child = join(root, 'child.cjs')
    // Ends on its own well after the test, so a failed run leaves nothing for long
    writeFileSync(child, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60_000)`)
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    writeFileSync(hook, `#!/bin/sh\n${shPath(process.execPath)} ${shPath(child)}\n`)
    chmodSync(hook, 0o755)

    const started = Date.now()
    const outcome = runGit(repo, ['commit', '--allow-empty', '-m', 'x'], { allowRepoPrograms: true, timeout: 5_000 * SLOW }).then(
      () => 'committed',
      (e: unknown) => (execFailure(e).timedOut ? 'timed out' : `failed: ${errorMessage(e)}`),
    )
    childPid = await pidIn(pidFile, 5_000)
    const answer = await outcome
    // Settled at the bound, not when the child would have ended
    expect(Date.now() - started).toBeLessThan(20_000 * SLOW)
    expect(await settle(() => alive(childPid!), (up) => !up, 5_000 * SLOW)).toBe(false)
    expect(answer).toBe('timed out')
  })
})

/*
 * #1842: the bound is the answer, whatever git printed. `runGit`'s callers read `stderr` before the message, and git ended
 * by the bound reports on its own (on Windows the tree's child goes first, and git prints "fatal: Could not read from
 * remote repository" and exits 128). Here the program git runs says it before the bound fires, and again when it is
 * signalled, and exits non-zero on the signal where the OS lets it: on every OS the failure is the bound's.
 */
// A fixed bound, not SLOW-scaled (15 s on Windows for nothing). The program has to speak before it fires, which a cold node can need seconds for under load; each test's own limit stays scaled.
const BOUND = 5_000

describe('a git that runs past its time reports the bound, not its own words (#1842)', () => {
  let root: string

  /** A repository whose hook (or fsmonitor) program prints to stderr, says so in a file, and then waits */
  function talkative(): { repo: string; said: string } {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-git-said-')))
    const repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'test@test')
    git(repo, 'config', 'user.name', 'test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    const said = join(root, 'said')
    const program = join(root, 'talk.cjs')
    writeFileSync(
      program,
      `const fs = require('node:fs')
console.error('fatal: it said this itself')
fs.writeFileSync(${JSON.stringify(said)}, 'x')
const bye = () => { console.error('fatal: and this when it was signalled'); process.exit(128) }
process.on('SIGTERM', bye)
process.on('SIGINT', bye)
setTimeout(() => {}, 60_000)`,
    )
    const script = `#!/bin/sh
${shPath(process.execPath)} ${shPath(program)}
`
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    writeFileSync(hook, script)
    chmodSync(hook, 0o755)
    return { repo, said }
  }

  it('runGit: the failure says the bound, with no output of its own', { timeout: 30_000 * SLOW }, async () => {
    const { repo, said } = talkative()
    const failed = await runGit(repo, ['commit', '--allow-empty', '-m', 'x'], { allowRepoPrograms: true, timeout: BOUND }).then(
      () => null,
      (e: unknown) => e,
    )
    // The program spoke before the bound fired: what the test is about happened
    expect(existsSync(said)).toBe(true)
    expect(failed).toMatchObject({ message: `git did not answer within ${BOUND} ms`, timedOut: true, stderr: '', stdout: '' })
  })

  it('streamGit: the failure says the bound, with no output of its own', { timeout: 30_000 * SLOW }, async () => {
    const { repo, said } = talkative()
    // Run by a status in a repository whose fsmonitor is the program; the hook above is not needed
    git(repo, 'config', 'core.fsmonitor', `${shPath(process.execPath)} ${shPath(join(root, 'talk.cjs'))}`)
    const failed = await streamGit(repo, ['status', '-z'], () => false, { allowRepoPrograms: true, timeout: BOUND }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(existsSync(said)).toBe(true)
    expect(failed).toMatchObject({ timedOut: true, stderr: '' })
  })
})

/*
 * #982 review: SIGKILL alone left `.git/index.lock` behind (git removes it on SIGTERM), so the next commit or stage
 * was refused. A commit with `-a` holds the lock while its pre-commit hook runs. Windows has no SIGTERM: `taskkill /F`
 * leaves the lock as SIGKILL does, so the lock is checked off Windows only.
 */
describe('a git that is stopped takes its lock away (#982)', () => {
  let root: string

  /** A repository with a change, whose pre-commit hook writes `started()` and then sleeps for `seconds` */
  function slowCommit(seconds: number): string {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-git-lock-')))
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'test@test')
    git(root, 'config', 'user.name', 'test')
    git(root, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(root, 'a.txt'), 'a\n')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-q', '-m', 'one')
    writeFileSync(join(root, 'a.txt'), 'b\n')
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    writeFileSync(hook, `#!/bin/sh\ntouch ${shPath(started(root))}\nsleep ${seconds}\n`)
    chmodSync(hook, 0o755)
    return root
  }

  const lock = (repo: string) => join(repo, '.git', 'index.lock')
  /** Written by the hook as it starts: git takes its lock before the hook runs, so the lock alone does not say it runs */
  const started = (repo: string) => join(repo, 'hook-started')

  it.skipIf(process.platform === 'win32')('at its bound', { timeout: 30_000 * SLOW }, async () => {
    const repo = slowCommit(30)
    const failed = await runGit(repo, ['commit', '-a', '-m', 'two'], { allowRepoPrograms: true, timeout: 1_000 * SLOW }).then(
      () => null,
      (e: { timedOut?: boolean }) => e,
    )
    expect(failed).toMatchObject({ timedOut: true })
    expect(existsSync(lock(repo))).toBe(false)
  })

  /** A commit whose hook has started: what the call settled with, once git has ended */
  async function commitStopped(stop: () => unknown, signal?: AbortSignal): Promise<{ outcome: string; signal?: unknown; repo: string }> {
    const repo = slowCommit(30)
    const call = runGit(repo, ['commit', '-a', '-m', 'two'], { allowRepoPrograms: true, timeout: 120_000 * SLOW, signal }).then(
      () => ({ outcome: 'committed' }),
      (e: { signal?: unknown }) => ({ outcome: 'ended', signal: e.signal }),
    )
    expect(await settle(() => existsSync(started(repo)), Boolean, 20_000 * SLOW)).toBe(true)
    await stop()
    // git's own end, however long the stop took
    return { ...(await call), repo }
  }

  /*
   * Stopped while its hook runs, git must not go on to commit (#2141). On Windows `taskkill /T` could end the hook's
   * `sleep` before git; the hook then reported success, and git made the commit. That race cannot be had on demand, so
   * the order is read from git's end: a git the stop itself ended has the signal, one that died of its hook failing or
   * of the tree kill has none (read on Windows, where the order is the stop's own). Without a stop, the hook sleeps out
   * and git commits.
   */
  const endedFirst = (r: { outcome: string; signal?: unknown; repo: string }) => {
    expect(r.outcome).toBe('ended')
    if (process.platform === 'win32') expect(r.signal).toBe('SIGTERM')
    if (process.platform !== 'win32') expect(existsSync(lock(r.repo))).toBe(false)
    expect(git(r.repo, 'log', '--format=%s').trim()).toBe('one')
  }

  // The host leaving (lifecycle/shutdown.ts): git runs in a group of its own, which nothing else ends
  it('when the host stops: every git still running ends, itself first', { timeout: 60_000 * SLOW }, async () => {
    endedFirst(await commitStopped(() => stopGitChildren()))
  })

  // A caller that gives up (a cancelled commit): the run's own stop
  it('when its caller aborts: git ends, itself first', { timeout: 60_000 * SLOW }, async () => {
    const abort = new AbortController()
    endedFirst(await commitStopped(() => abort.abort(), abort.signal))
  })
})
