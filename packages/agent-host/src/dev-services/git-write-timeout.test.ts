import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SLOW } from '../../../../tooling/test-timing.js'

/** The bound a call gets when it names none: a read's. Shortened here so a hook can outlast it in seconds, not 10 s */
const READ_BOUND_MS = 1000 * SLOW
/** How long each hook below sleeps: past the read bound, by a margin a loaded machine still keeps */
const HOOK_SECONDS = READ_BOUND_MS / 1000 + 1.5

/** The bound each write asked for, by subcommand */
const asked = vi.hoisted(() => new Map<string, number | undefined>())

vi.mock('./git-exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./git-exec.js')>()
  return {
    ...real,
    runGit: (cwd: string, args: string[], opts: import('./git-exec.js').RunGitOptions = {}) => {
      if (opts.allowRepoPrograms) asked.set(args[0]!, opts.timeout)
      return real.runGit(cwd, args, { timeout: READ_BOUND_MS, ...opts })
    },
  }
})

const { WRITE_TIMEOUT_MS, gitCommit, gitPush, gitStage } = await import('./git-write.js')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function sleepingHook(repo: string, name: string): void {
  const hook = join(repo, '.git', 'hooks', name)
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
  writeFileSync(hook, `#!/bin/sh\nsleep ${HOOK_SECONDS}\n`)
  chmodSync(hook, 0o755)
}

/*
 * #980: a write the person asks for runs the repository's hooks (a pre-commit type check, a pre-push test run) and the
 * credential helper, which can wait on a sign-in. Under the read bound git was killed partway and Commit or Push failed.
 */
describe('a write outlasts the bound of a read (#980)', () => {
  let root: string
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))

  it('commits through a pre-commit hook that takes longer than a read may', { timeout: 30_000 * SLOW }, async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-git-write-'))
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'test@test')
    git(root, 'config', 'user.name', 'test')
    git(root, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(root, 'a.txt'), 'a\n')
    await gitStage(root, ['a.txt'])
    sleepingHook(root, 'pre-commit')

    expect(await gitCommit(root, 'first')).toEqual({ ok: true })
    expect(git(root, 'log', '--format=%s').trim()).toBe('first')
  })

  it('pushes through a pre-push hook that takes longer than a read may', { timeout: 30_000 * SLOW }, async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-git-write-'))
    const repo = join(root, 'repo')
    const remote = join(root, 'remote.git')
    mkdirSync(repo)
    git(root, 'init', '-q', '--bare', remote)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'test@test')
    git(repo, 'config', 'user.name', 'test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'first')
    git(repo, 'remote', 'add', 'origin', remote)
    sleepingHook(repo, 'pre-push')

    expect(await gitPush(repo)).toEqual({ ok: true })
    expect(git(remote, 'log', '--format=%s').trim()).toBe('first')
  })

  // The tests above pass with any bound past the shortened read's; this one holds the value itself
  it('gives stage, commit and push ten minutes, as a clone gets', { timeout: 30_000 * SLOW }, async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-git-write-'))
    const repo = join(root, 'repo')
    const remote = join(root, 'remote.git')
    mkdirSync(repo)
    git(root, 'init', '-q', '--bare', remote)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'test@test')
    git(repo, 'config', 'user.name', 'test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    git(repo, 'remote', 'add', 'origin', remote)
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    asked.clear()
    await gitStage(repo, ['a.txt'])
    expect(await gitCommit(repo, 'first')).toEqual({ ok: true })
    expect(await gitPush(repo)).toEqual({ ok: true })

    expect(WRITE_TIMEOUT_MS).toBe(10 * 60_000)
    for (const sub of ['add', 'commit', 'push']) expect(asked.get(sub), sub).toBe(10 * 60_000)
  })
})
