import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __forgetPrograms } from '../tool-launch.js'
import { gitBranchPr } from './git.js'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/*
 * The host's merge check runs gh in the project's folder, and stopping the host aborts it (#368). Windows refuses to
 * remove a folder a running process works in, so an abort must not return while gh is still there, and gh's own
 * children (it runs git) must end with it. The gh here is Node under gh's name: `gh pr view …` makes it run the
 * script named `pr` in its working directory, which starts a child of its own and waits. The child is detached: a
 * child Node starts otherwise is in Node's job and ends with it on Windows, which gh's (a Go program's) are not.
 * Its end is checked on Windows only: elsewhere gh is in the host's process group, which `killTree` leaves alone,
 * and a folder a process works in can be removed.
 */
describe('gh stopped by an abort (#368)', () => {
  let root: string
  let childPid: number | undefined
  afterEach(() => {
    if (childPid !== undefined && alive(childPid)) process.kill(childPid)
    vi.unstubAllEnvs()
    __forgetPrograms()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  it('ends gh and what it started, and returns once gh is gone', async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-gh-abort-')))
    const bin = join(root, 'bin')
    const project = join(root, 'project')
    mkdirSync(bin)
    mkdirSync(project)
    const gh = join(bin, process.platform === 'win32' ? 'gh.exe' : 'gh')
    try {
      linkSync(process.execPath, gh)
    } catch {
      copyFileSync(process.execPath, gh)
    }
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
    await until(() => existsSync(join(project, 'pids')), 10_000)
    const [ghPid, child] = JSON.parse(readFileSync(join(project, 'pids'), 'utf8')) as [number, number]
    childPid = child
    expect(alive(child)).toBe(true)
    stop.abort()
    expect(await answer).toBeNull()
    expect(alive(ghPid)).toBe(false)
    // No retries: Windows refuses (EBUSY) while gh still works in it
    rmSync(project, { recursive: true })
    if (process.platform === 'win32') await until(() => !alive(child), 5_000)
  })
})
