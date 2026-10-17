import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitWriteRuns, gitCommit, gitPush, gitStage } from './git-write.js'
import { settle } from './process-tree.test-helpers.js'
import { SLOW } from '../../../../tooling/test-timing.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

/*
 * #1007: a commit or push from the git panel waits up to ten minutes (#980) on a hook or a credential helper waiting
 * on a sign-in nobody will give. The person can end it: git is ended as a timeout ends it, and the write answers that
 * it was cancelled, not that it failed.
 */
describe('a git write the person cancels (#1007)', () => {
  let root: string
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))

  /** A repository with a staged change, whose pre-commit hook sleeps far longer than the test waits */
  function slowCommit(): string {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-git-cancel-')))
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'test@test')
    git(root, 'config', 'user.name', 'test')
    git(root, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(root, 'a.txt'), 'a\n')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-q', '-m', 'one')
    writeFileSync(join(root, 'a.txt'), 'b\n')
    git(root, 'add', 'a.txt')
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    writeFileSync(hook, '#!/bin/sh\necho > .git/hook-started\nsleep 30\n')
    chmodSync(hook, 0o755)
    return root
  }

  const hookStarted = (repo: string) => join(repo, '.git', 'hook-started')

  it('ends a commit held by its hook, and says it was cancelled', { timeout: 30_000 * SLOW }, async () => {
    const repo = slowCommit()
    const runs = new GitWriteRuns()
    const commit = runs.run('p1', (signal) => gitCommit(repo, 'two', signal))
    try {
      expect(await settle(() => existsSync(hookStarted(repo)), Boolean, 10_000 * SLOW)).toBe(true)
      // Another project's cancel does not reach it
      expect(runs.cancel('p2')).toBe(false)

      const started = Date.now()
      expect(runs.cancel('p1')).toBe(true)
      expect(await commit).toEqual({ ok: false, message: 'Cancelled', cancelled: true })
      // Well before the hook would have ended (30 s): at the stop's grace, not the write's ten minutes
      expect(Date.now() - started).toBeLessThan(15_000 * SLOW)
      expect(git(repo, 'log', '--format=%s').trim()).toBe('one')
      // Nothing is left running to cancel
      expect(runs.cancel('p1')).toBe(false)
    } finally {
      // A failed run leaves no git holding the folder
      runs.cancel('p1')
      await commit
    }
  })

  it('starts no git once cancelled', async () => {
    const repo = slowCommit()
    const cancelled = AbortSignal.abort()
    expect(await gitCommit(repo, 'two', cancelled)).toEqual({ ok: false, message: 'Cancelled', cancelled: true })
    expect(await gitPush(repo, cancelled)).toEqual({ ok: false, message: 'Cancelled', cancelled: true })
    await expect(gitStage(repo, ['a.txt'], true, cancelled)).rejects.toMatchObject({ message: 'Cancelled', aborted: true })
    expect(git(repo, 'log', '--format=%s').trim()).toBe('one')
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('a.txt')
  })

  it('a write that is not cancelled answers as before', { timeout: 30_000 * SLOW }, async () => {
    const repo = slowCommit()
    rmSync(join(repo, '.git', 'hooks', 'pre-commit'))
    const runs = new GitWriteRuns()
    expect(await runs.run('p1', (signal) => gitCommit(repo, 'two', signal))).toEqual({ ok: true })
    expect(await runs.run('p1', (signal) => gitCommit(repo, 'three', signal))).toMatchObject({ ok: false, message: expect.stringContaining('nothing to commit') })
    expect(runs.cancel('p1')).toBe(false)
  })
})
