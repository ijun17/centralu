import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __forgetPrograms } from '../tool-launch.js'
import { gitBranchPr } from './git-pr.js'
import { eventually, SLOW } from '../../../../tooling/test-timing.js'
import { fileHolding, ownProcesses } from '../process.test-helpers.js'


/**
 * A gh that runs the script `pr` in its working directory with Node. On Windows it is Node itself under gh's name (an
 * .exe has to be found on PATH as gh.exe); elsewhere a shell script that execs Node, since a copied Node binary may not
 * start at all (Homebrew's links its library by a relative path).
 */
function fakeGh(bin: string): void {
  if (process.platform === 'win32') {
    const gh = join(bin, 'gh.exe')
    try {
      linkSync(process.execPath, gh)
    } catch {
      copyFileSync(process.execPath, gh)
    }
    return
  }
  const gh = join(bin, 'gh')
  writeFileSync(gh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$PWD/pr"\n`)
  chmodSync(gh, 0o755)
}

const pids = (project: string, ms: number) => fileHolding(join(project, 'pids'), (t) => JSON.parse(t) as [number, number], ms)

/*
 * The host's merge check runs gh in the project's folder, and stopping the host aborts it (#368). Windows refuses to
 * remove a folder a running process works in, so an abort must not return while gh is still there, and gh's own
 * children (it runs git) must end with it. The gh here (`fakeGh`) runs the
 * script named `pr` in its working directory, which starts a child of its own and waits. The child is detached: a
 * child Node starts otherwise is in Node's job and ends with it on Windows, which gh's (a Go program's) are not.
 * Its end is checked on Windows only: elsewhere a detached child leaves gh's process group, which is what `killTree`
 * ends, and a folder a process works in can be removed. A child that stays in the group is checked everywhere (below).
 */
describe('gh stopped by an abort (#368)', () => {
  let root: string
  let childPid: number | undefined
  // What a test has seen end is not signalled afterwards: its number may be someone else's by then (#1308)
  let own = ownProcesses()
  const alive = (pid: number) => own.alive(pid)
  afterEach(() => {
    // It can end between the last look and the kill (ESRCH failed this cleanup on Linux CI, #368): `end` ignores that
    if (childPid !== undefined) own.end([childPid], { signal: 'SIGTERM' })
    childPid = undefined
    own = ownProcesses()
    vi.unstubAllEnvs()
    __forgetPrograms()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  // Starting a Node binary as gh, which then starts another, takes seconds on a loaded machine: the bound is that wait's
  it('ends gh and what it started, and returns once gh is gone', { timeout: 30_000 * SLOW }, async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-gh-abort-')))
    const bin = join(root, 'bin')
    const project = join(root, 'project')
    mkdirSync(bin)
    mkdirSync(project)
    fakeGh(bin)
    // Whatever a folder above says, `pr` is CommonJS
    writeFileSync(join(project, 'package.json'), '{"type":"commonjs"}')
    writeFileSync(join(project, 'pr'), [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      // The child works elsewhere, so the folder test below waits on gh alone
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: ${JSON.stringify(bin)}, stdio: 'ignore', detached: true })`,
      "writeFileSync('pids', JSON.stringify([process.pid, child.pid]))",
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
    __forgetPrograms()

    const stop = new AbortController()
    const answer = gitBranchPr(project, 'feat/x', stop.signal)
    const [ghPid, child] = await pids(project, 10_000)
    childPid = child
    expect(alive(child)).toBe(true)
    stop.abort()
    expect(await answer).toBeNull()
    expect(alive(ghPid)).toBe(false)
    // No retries: Windows refuses (EBUSY) while gh still works in it
    rmSync(project, { recursive: true })
    if (process.platform === 'win32') await eventually(() => !alive(child), 5_000)
  })

  // macOS and Linux: the tree kill does not reach a child that left gh's group, and one holding gh's output kept
  // `close` from coming for as long as it ran, which held the host's shutdown with it. Windows (#849): the child is
  // outside gh's job, so only `taskkill /T` ends it, and it must, since it holds the output open
  it('returns once gh is gone even while a child it started holds its output', { timeout: 30_000 * SLOW }, async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-gh-abort-')))
    const bin = join(root, 'bin')
    const project = join(root, 'project')
    mkdirSync(bin)
    mkdirSync(project)
    fakeGh(bin)
    writeFileSync(join(project, 'package.json'), '{"type":"commonjs"}')
    writeFileSync(join(project, 'pr'), [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      // Detached, so out of gh's group, and with gh's stdout and stderr as its own
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: ${JSON.stringify(bin)}, stdio: ['ignore', 'inherit', 'inherit'], detached: true })`,
      "writeFileSync('pids', JSON.stringify([process.pid, child.pid]))",
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
    __forgetPrograms()

    const stop = new AbortController()
    const answer = gitBranchPr(project, 'feat/x', stop.signal)
    const [ghPid, child] = await pids(project, 20_000)
    childPid = child
    stop.abort()
    const started = Date.now()
    expect(await answer).toBeNull()
    expect(Date.now() - started).toBeLessThan(5_000 * SLOW)
    expect(alive(ghPid)).toBe(false)
    if (process.platform === 'win32') await eventually(() => !alive(child), 5_000)
  })

  // #982: the bound was execFile's own, which ends gh alone; a child holding gh's output then held the answer as well
  it('ends gh and what it started when gh does not answer in time', { timeout: 30_000 * SLOW }, async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-gh-timeout-')))
    const bin = join(root, 'bin')
    const project = join(root, 'project')
    mkdirSync(bin)
    mkdirSync(project)
    fakeGh(bin)
    writeFileSync(join(project, 'package.json'), '{"type":"commonjs"}')
    writeFileSync(join(project, 'pr'), [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { cwd: ${JSON.stringify(bin)}, stdio: ['ignore', 'inherit', 'inherit'], detached: true })`,
      "writeFileSync('pids', JSON.stringify([process.pid, child.pid]))",
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
    __forgetPrograms()

    const bound = 3_000 * SLOW
    const started = Date.now()
    const answer = gitBranchPr(project, 'feat/x', undefined, bound)
    const [ghPid, child] = await pids(project, 20_000)
    childPid = child
    expect(await answer).toBeNull()
    expect(Date.now() - started).toBeLessThan(bound + 5_000 * SLOW)
    expect(alive(ghPid)).toBe(false)
    if (process.platform === 'win32') await eventually(() => !alive(child), 5_000)
  })

  // #982 review: in the host's process group the tree kill spared what gh started (git, reading the remotes); gh now
  // leads a group of its own, and a child that stays in it ends with it on every system
  it('ends a child gh started in its own group when gh does not answer in time', { timeout: 30_000 * SLOW }, async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-gh-timeout-')))
    const bin = join(root, 'bin')
    const project = join(root, 'project')
    mkdirSync(bin)
    mkdirSync(project)
    fakeGh(bin)
    writeFileSync(join(project, 'package.json'), '{"type":"commonjs"}')
    writeFileSync(join(project, 'pr'), [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      // Not detached: what gh's own git looks like
      `const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { cwd: ${JSON.stringify(bin)}, stdio: 'ignore' })`,
      "writeFileSync('pids', JSON.stringify([process.pid, child.pid]))",
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
    __forgetPrograms()

    const answer = gitBranchPr(project, 'feat/x', undefined, 3_000 * SLOW)
    const [ghPid, child] = await pids(project, 20_000)
    childPid = child
    expect(await answer).toBeNull()
    expect(alive(ghPid)).toBe(false)
    await eventually(() => !alive(child), 5_000)
  })
})

/*
 * #849: a gh.cmd first on PATH (a wrapper, a package manager's shim of a script) was handed to the spawn, which Node
 * refuses on Windows with EINVAL: gitBranchPr threw, though it is documented never to.
 */
describe('a gh that is a batch file', () => {
  let root = ''
  afterEach(() => {
    vi.unstubAllEnvs()
    __forgetPrograms()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  /*
   * And never the bare name instead: given one, Windows looks in the working directory, the project, before PATH, so a
   * gh.exe committed to the repository would run (a review of #964). Here that gh.exe is Node, which runs the script
   * `pr` it finds there and leaves a mark.
   */
  it('is no gh to run: the answer is that gh is unavailable, never a throw, and never a gh.exe in the project', async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-gh-cmd-')))
    const bin = join(root, 'bin')
    const project = join(root, 'project')
    mkdirSync(bin)
    mkdirSync(project)
    writeFileSync(join(bin, 'gh.cmd'), '@echo {}\r\n')
    fakeGh(project)
    writeFileSync(join(project, 'package.json'), '{"type":"commonjs"}')
    writeFileSync(join(project, 'pr'), "require('node:fs').writeFileSync('planted-ran', 'yes')\n")
    vi.stubEnv('PATH', bin)
    // Windows' default, which some shells (agent CLIs among them) turn off: the working directory is looked in first
    vi.stubEnv('NoDefaultCurrentDirectoryInExePath', undefined)
    __forgetPrograms()
    const answer = await gitBranchPr(project, 'feat/x')
    expect({ answer, plantedRan: existsSync(join(project, 'planted-ran')) }).toEqual({ answer: 'unavailable', plantedRan: false })
  })

  /*
   * #838: with no gh on PATH at all, the bare name was spawned, and Windows ran the gh.exe committed to the project (the
   * common case: git installed, gh not). Here that gh.exe is Node, which runs the script `pr` it finds and leaves a mark.
   */
  it('is no gh on PATH at all: gh is unavailable, and the gh.exe in the project never runs', async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-gh-none-')))
    const bin = join(root, 'bin')
    const project = join(root, 'project')
    mkdirSync(bin)
    mkdirSync(project)
    fakeGh(project)
    writeFileSync(join(project, 'package.json'), '{"type":"commonjs"}')
    writeFileSync(join(project, 'pr'), "require('node:fs').writeFileSync('planted-ran', 'yes')\n")
    vi.stubEnv('PATH', bin)
    vi.stubEnv('NoDefaultCurrentDirectoryInExePath', undefined)
    __forgetPrograms()
    const answer = await gitBranchPr(project, 'feat/x')
    expect({ answer, plantedRan: existsSync(join(project, 'planted-ran')) }).toEqual({ answer: 'unavailable', plantedRan: false })
  })
})

/*
 * #841: every gh failure read as "no pull request", and gh's stderr was thrown away, so a sign-in that had expired left
 * the merge badge missing with no trace of why. A failure is said once in the host's log with gh's own line.
 */
describe('a gh lookup that fails (#841)', () => {
  let root: string
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    __forgetPrograms()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  function ghSaying(stderr: string): string {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-gh-fail-')))
    const bin = join(root, 'bin')
    const project = join(root, 'project')
    mkdirSync(bin)
    mkdirSync(project)
    fakeGh(bin)
    writeFileSync(join(project, 'package.json'), '{"type":"commonjs"}')
    writeFileSync(join(project, 'pr'), `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1\n`)
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
    __forgetPrograms()
    return project
  }

  it('says why in the host log, once, and still reads as unknown', { timeout: 30_000 * SLOW }, async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const project = ghSaying('HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login\n')
    expect(await gitBranchPr(project, 'feat/x')).toBeNull()
    expect(await gitBranchPr(project, 'feat/x')).toBeNull()
    const said = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('Bad credentials'))
    expect(said).toEqual(['[git] gh could not read the pull request of feat/x: HTTP 401: Bad credentials (https://api.github.com/graphql)'])
  })

  it('says nothing when the branch has no pull request, which is an answer', { timeout: 30_000 * SLOW }, async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const project = ghSaying('no pull requests found for branch "feat/y"\n')
    expect(await gitBranchPr(project, 'feat/y')).toBeNull()
    expect(log.mock.calls.filter((c) => String(c[0]).includes('gh could not'))).toEqual([])
  })
})
