import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __forgetPrograms } from '../tool-launch.js'
import { gitBranchPr } from './git.js'
import { eventually, SLOW } from '../../../../tooling/test-timing.js'
import { alive } from '../process.test-helpers.js'


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
  afterEach(() => {
    // It can end between the check and the kill (ESRCH failed this cleanup on Linux CI, #368)
    if (childPid !== undefined && alive(childPid)) {
      try {
        process.kill(childPid)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
      }
    }
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
    await eventually(() => existsSync(join(project, 'pids')), 10_000)
    const [ghPid, child] = JSON.parse(readFileSync(join(project, 'pids'), 'utf8')) as [number, number]
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
    await eventually(() => existsSync(join(project, 'pids')), 20_000)
    const [ghPid, child] = JSON.parse(readFileSync(join(project, 'pids'), 'utf8')) as [number, number]
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
    await until(() => existsSync(join(project, 'pids')), 20_000)
    const [ghPid, child] = JSON.parse(readFileSync(join(project, 'pids'), 'utf8')) as [number, number]
    childPid = child
    expect(await answer).toBeNull()
    expect(Date.now() - started).toBeLessThan(bound + 5_000 * SLOW)
    expect(alive(ghPid)).toBe(false)
    if (process.platform === 'win32') await until(() => !alive(child), 5_000)
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
    await until(() => existsSync(join(project, 'pids')), 20_000)
    const [ghPid, child] = JSON.parse(readFileSync(join(project, 'pids'), 'utf8')) as [number, number]
    childPid = child
    expect(await answer).toBeNull()
    expect(alive(ghPid)).toBe(false)
    await until(() => !alive(child), 5_000 * SLOW)
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

})
