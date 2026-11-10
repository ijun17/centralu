/*
 * #2141 on the path the ordered stop gives up on: a process table that cannot be read in time (a starved machine, CI's Windows runners)
 * leaves `taskkill /T` on the root, in no order (`stopTreesWindows`). That is the path #2141 came from: a hook's `sleep` ended before
 * git, the hook reported success, and git made the commit. A real git, a real slow hook, the table forced unreadable: git must not
 * commit, whichever of them the tree kill ends first.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { runGit, stopGitChildren } from './git-exec.js'
import { settle } from './process-tree.test-helpers.js'
import { SLOW } from '../../../../tooling/test-timing.js'

// The real stop, with the table it reads made unreadable: what the stop does when PowerShell would not answer in time
vi.mock('../os/kill-tree.js', async (original) => {
  const real = await original<typeof import('../os/kill-tree.js')>()
  const unreadable = {
    ...real.leftoverOs(promisify(execFile)),
    listProcesses: () => Promise.reject(Object.assign(new Error('timed out'), { killed: true })),
  }
  return {
    ...real,
    stopTreeWindows: (root: Parameters<typeof real.stopTreeWindows>[0], endRoot: Parameters<typeof real.stopTreeWindows>[1]) => real.stopTreeWindows(root, endRoot, unreadable),
    stopTreesWindows: (roots: Parameters<typeof real.stopTreesWindows>[0]) => real.stopTreesWindows(roots, unreadable),
  }
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
const shPath = (p: string) => JSON.stringify(p.replace(/\\/g, '/'))

describe('a git stopped with its process table unreadable (#2141)', () => {
  it.runIf(process.platform === 'win32')('never commits: the host stopping ends it, with taskkill /T', { timeout: 60_000 * SLOW }, async () => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-git-fallback-')))
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'test@test')
    git(repo, 'config', 'user.name', 'test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-q', '-m', 'one')
    writeFileSync(join(repo, 'a.txt'), 'b\n')
    const started = join(repo, 'hook-started')
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    writeFileSync(hook, `#!/bin/sh\ntouch ${shPath(started)}\nsleep 30\n`)
    chmodSync(hook, 0o755)

    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const call = runGit(repo, ['commit', '-a', '-m', 'two'], { allowRepoPrograms: true, timeout: 120_000 * SLOW }).then(
        () => 'committed',
        () => 'ended',
      )
      expect(await settle(() => existsSync(started), Boolean, 20_000 * SLOW)).toBe(true)
      await stopGitChildren()
      expect(await call).toBe('ended')
      // The path under test was the one taken
      expect(said.mock.calls.some(([m]) => String(m).includes('process table could not be read'))).toBe(true)
      expect(git(repo, 'log', '--format=%s').trim()).toBe('one')
    } finally {
      said.mockRestore()
    }
  })
})
