import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fixtureGit, removeTree, tempRoot } from './temp-dir.test-helpers.js'
import { SLOW } from '../../../tooling/test-timing.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await removeTree(d)
})

describe('temporary folders and fixture repositories (#845)', () => {
  it('a temporary folder is named by its long real path', () => {
    const d = tempRoot('cc-temp-dir-')
    made.push(d)
    expect(existsSync(d)).toBe(true)
    expect(d).toBe(realpathSync.native(d))
  })

  /*
   * #503: every `git commit` may start a detached `git maintenance run --auto` that keeps working in the repository after
   * the commit returns, which Windows' folder removal then meets. git's trace shows the start, so this does not depend
   * on whether the maintenance found anything to do.
   */
  it('a fixture commit starts no background git maintenance', () => {
    const d = tempRoot('cc-temp-dir-git-')
    made.push(d)
    fixtureGit(d, ['init', '-q', '-b', 'main'])
    writeFileSync(join(d, 'a.txt'), 'a\n')
    fixtureGit(d, ['add', '.'])
    const trace = join(d, '..', `${d.split(/[\\/]/).at(-1)}.trace.json`)
    try {
      fixtureGit(d, ['commit', '-qm', 'init'], { env: { ...process.env, GIT_TRACE2_EVENT: trace } })
      const started = readFileSync(trace, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { event: string; argv?: string[] })
        .filter((e) => e.event === 'child_start')
        .map((e) => e.argv?.join(' '))
      expect(started.filter((a) => a?.includes('maintenance'))).toEqual([])
      expect(fixtureGit(d, ['log', '--format=%an <%ae>'])).toBe('Test <test@example.com>\n')
    } finally {
      rmSync(trace, { force: true })
    }
  })

  /*
   * Windows will not delete a folder a process is still working in. A process the test started that is ending as the
   * test does (here one told to leave the moment the removal starts) failed a cleanup without retries with EBUSY.
   */
  it.runIf(process.platform === 'win32')('removes a folder a process is still leaving', async () => {
    const d = tempRoot('cc-temp-dir-busy-')
    // It works in the folder until its stdin closes, and says so once it runs
    const child = spawn(process.execPath, ['-e', "process.stdout.write('up\\n'); process.stdin.resume().on('end', () => setTimeout(() => process.exit(0), 300))"], {
      cwd: d,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const exited = new Promise((r) => child.once('exit', r))
    try {
      await new Promise((r) => child.stdout!.once('data', r))
      expect(() => rmSync(d, { recursive: true, force: true })).toThrow(/EBUSY/)
      child.stdin!.end()
      await removeTree(d)
      expect(existsSync(d)).toBe(false)
    } finally {
      child.kill()
      await exited
      made.push(d)
    }
  }, 30_000 * SLOW)
})
