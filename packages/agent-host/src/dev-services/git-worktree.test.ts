import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fixtureGit, removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { gitSummary } from './git.js'
import { gitWorktreeAdd, gitWorktreeDirty, gitWorktreeList, gitWorktreeRemove, resolveForkBase } from './git-worktree.js'

/**
 * A worktree can only be tested against **real git.**
 * Standing up a fake one would only check the rules we already know about, and would miss
 * exactly git's own rules (rejecting a duplicate branch, rejecting a dirty tree) — every case
 * that actually stops the user in this feature is the latter.
 */
/** A worktree is only made in a trusted project (#407) */
const TRUSTED = { trusted: true }
let repo = ''
let root = ''

beforeEach(() => {
  root = tempRoot('cc-wt-')
  repo = join(root, 'repo')
  fixtureGit(root, ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  fixtureGit(repo, ['add', '.'])
  fixtureGit(repo, ['commit', '-qm', 'init'])
})

afterEach(() => removeTree(root))

describe('worktrees', () => {
  it('creates one outside the repository, with a branch different from the original', async () => {
    const path = join(root, 'outside', 'session-1')
    const wt = await gitWorktreeAdd(repo, path, 'centralu/abc12345', undefined, TRUSTED)

    expect(wt).toEqual({ path, branch: 'centralu/abc12345' })
    expect(existsSync(join(path, 'a.txt'))).toBe(true)
    // The original has to stay on main — that is what isolation means
    expect((await gitSummary(repo)).branch).toBe('main')
    expect((await gitSummary(path)).branch).toBe('centralu/abc12345')
  })

  it('editing one side never disturbs the other (the point of this feature)', async () => {
    const path = join(root, 'outside', 'session-2')
    await gitWorktreeAdd(repo, path, 'centralu/wt2', undefined, TRUSTED)
    writeFileSync(join(path, 'a.txt'), 'fixed in the worktree\n')

    expect((await gitWorktreeDirty(path)).dirty).toBe(true)
    expect((await gitWorktreeDirty(repo)).dirty).toBe(false)
  })

  it('an uncommitted change blocks removal unless force is given', async () => {
    const path = join(root, 'outside', 'session-3')
    await gitWorktreeAdd(repo, path, 'centralu/wt3', undefined, TRUSTED)
    writeFileSync(join(path, 'a.txt'), 'not committed yet\n')

    // Confirms git itself rejects this — this is exactly why we attach force
    await expect(gitWorktreeRemove(repo, path)).rejects.toThrow()
    expect(existsSync(path)).toBe(true)

    await gitWorktreeRemove(repo, path, true)
    expect(existsSync(path)).toBe(false)
  })

  it('cannot create two worktrees with the same branch name', async () => {
    const a = join(root, 'outside', 'a')
    const b = join(root, 'outside', 'b')
    await gitWorktreeAdd(repo, a, 'centralu/dup', undefined, TRUSTED)
    // Naming branches by a session id's prefix makes this practically unreachable, but it must not fail silently if it happens
    await expect(gitWorktreeAdd(repo, b, 'centralu/dup', undefined, TRUSTED)).rejects.toThrow()
  })

  it('only what is registered shows up in the list (and disappears once removed)', async () => {
    const path = join(root, 'outside', 'listed')
    await gitWorktreeAdd(repo, path, 'centralu/listed', undefined, TRUSTED)

    const before = await gitWorktreeList(repo)
    expect(before.map((w) => w.branch)).toContain('centralu/listed')

    await gitWorktreeRemove(repo, path)
    const after = await gitWorktreeList(repo)
    expect(after.map((w) => w.branch)).not.toContain('centralu/listed')
  })

  it('the list comes back empty, not thrown, when this is not a git repository', async () => {
    expect(await gitWorktreeList(root)).toEqual([])
  })
})

/**
 * Where a new worktree forks from (#1484): the trunk as the remote has it, not what the checkout has checked out.
 * Real git throughout: a bare repository stands for the remote, a second clone moves it ahead.
 */
describe('the base a new worktree forks from (#1484)', () => {
  const sha = (cwd: string, ref: string) => fixtureGit(cwd, ['rev-parse', ref]).trim()
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`)
    fixtureGit(cwd, ['add', '.'])
    fixtureGit(cwd, ['commit', '-qm', file])
  }
  /** `repo` with a bare `origin`, pushed; and a second clone that pushes one more commit to origin's main */
  function withRemote(): { remoteTip: string } {
    const bare = join(root, 'origin.git')
    fixtureGit(root, ['init', '-q', '--bare', '-b', 'main', bare])
    fixtureGit(repo, ['remote', 'add', 'origin', bare])
    fixtureGit(repo, ['push', '-q', '-u', 'origin', 'main'])
    const other = join(root, 'other')
    fixtureGit(root, ['clone', '-q', bare, other])
    commit(other, 'ahead.txt')
    fixtureGit(other, ['push', '-q', 'origin', 'main'])
    return { remoteTip: sha(other, 'HEAD') }
  }

  it('forks from the fetched tip of the remote trunk when the checkout sits on an unrelated branch', async () => {
    const { remoteTip } = withRemote()
    fixtureGit(repo, ['switch', '-q', '--orphan', 'unrelated'])
    commit(repo, 'unrelated.txt')
    const base = await resolveForkBase(repo, 'main', { trusted: true })
    expect(base.sha).toBe(remoteTip)
    expect(base.ref).toBe('origin/main')
    expect(base.note).toBe(`Forked from origin/main at ${remoteTip.slice(0, 9)}, fetched just now`)
    const path = join(root, 'wt')
    await gitWorktreeAdd(repo, path, 'centralu/x', base.sha ?? undefined, TRUSTED)
    expect(sha(path, 'HEAD')).toBe(remoteTip)
    // The merge base with the trunk is the trunk's tip, and the new branch tracks nothing
    expect(fixtureGit(path, ['merge-base', 'HEAD', 'origin/main']).trim()).toBe(remoteTip)
    expect(() => fixtureGit(path, ['rev-parse', '--abbrev-ref', 'centralu/x@{upstream}'])).toThrow()
  })

  it('says which local commits of the trunk the worktree lacks', async () => {
    withRemote()
    commit(repo, 'local-only.txt')
    const base = await resolveForkBase(repo, 'main', { trusted: true })
    expect(base.note).toMatch(/, fetched just now\. The local main has 1 commit\(s\) the remote does not, which the worktree does not have$/)
  })

  it('a trunk held as "origin/main" and no trunk at all (the remote default) both fork from the remote tip', async () => {
    const { remoteTip } = withRemote()
    fixtureGit(repo, ['remote', 'set-head', 'origin', 'main'])
    expect((await resolveForkBase(repo, 'origin/main', { trusted: true })).sha).toBe(remoteTip)
    expect((await resolveForkBase(repo, null, { trusted: true })).sha).toBe(remoteTip)
  })

  it('a checkout on a detached HEAD does not matter', async () => {
    const { remoteTip } = withRemote()
    fixtureGit(repo, ['checkout', '-q', '--detach'])
    expect((await resolveForkBase(repo, 'main', { trusted: true })).sha).toBe(remoteTip)
  })

  it('without a remote it forks from the local trunk, not HEAD, and says there is no remote', async () => {
    const mainTip = sha(repo, 'main')
    fixtureGit(repo, ['switch', '-q', '-c', 'feature'])
    commit(repo, 'feature.txt')
    const base = await resolveForkBase(repo, 'main', { trusted: true })
    expect(base).toMatchObject({ sha: mainTip, ref: 'main' })
    expect(base.note).toBe(`This repository has no remote to fetch from, so the worktree forks from the local ref main at ${mainTip.slice(0, 9)}, which may be behind the remote`)
    // No trunk held: a local main is found
    expect((await resolveForkBase(repo, null, { trusted: true })).sha).toBe(mainTip)
  })

  it('a fetch that fails forks from the newer of the local trunk and the last fetched tip, with how far behind', async () => {
    withRemote()
    fixtureGit(repo, ['fetch', '-q', 'origin'])
    const fetched = sha(repo, 'origin/main')
    fixtureGit(repo, ['remote', 'set-url', 'origin', join(root, 'gone.git')])
    const base = await resolveForkBase(repo, 'main', { trusted: true })
    // origin/main (as last fetched) is ahead of the stale local main
    expect(base).toMatchObject({ sha: fetched, ref: 'origin/main' })
    expect(base.note).toContain('Could not fetch origin')
    // A trunk with no tracking ref: the local one, and it is not HEAD
    fixtureGit(repo, ['update-ref', '-d', 'refs/remotes/origin/main'])
    fixtureGit(repo, ['switch', '-q', '-c', 'feature'])
    expect((await resolveForkBase(repo, 'main', { trusted: true })).ref).toBe('main')
  })

  it('a fetch that hangs is ended at its bound and the worktree forks from what is here', async () => {
    fixtureGit(repo, ['remote', 'add', 'origin', 'ssh://example.invalid/x.git'])
    fixtureGit(repo, ['config', 'core.sshCommand', 'node -e "setTimeout(function(){},60000)"'])
    const started = Date.now()
    const base = await resolveForkBase(repo, 'main', { trusted: true, timeoutMs: 1500 })
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(base.sha).toBe(sha(repo, 'main'))
    expect(base.note).toContain('did not answer within 1500 ms')
  })

  it('an untrusted project is not fetched (a fetch runs the repository\'s network settings)', async () => {
    const { remoteTip } = withRemote()
    const stale = sha(repo, 'main')
    const base = await resolveForkBase(repo, 'main', { trusted: false })
    expect(base.sha).toBe(stale)
    expect(base.sha).not.toBe(remoteTip)
    expect(base.note).toContain('not trusted')
  })

  it('with no trunk anywhere it forks from HEAD and says so', async () => {
    fixtureGit(repo, ['branch', '-m', 'elsewhere'])
    const base = await resolveForkBase(repo, null, { trusted: true })
    expect(base).toMatchObject({ sha: sha(repo, 'HEAD'), ref: 'HEAD' })
    expect(base.note).toMatch(/checkout's HEAD at \w{9}, which may not be the trunk$/)
  })

  it('a repository with no commit yet has no base to record, and git still makes the worktree', async () => {
    const empty = join(root, 'empty')
    fixtureGit(root, ['init', '-q', '-b', 'main', empty])
    const base = await resolveForkBase(empty, 'main', { trusted: true })
    expect(base).toEqual({ sha: null, ref: 'HEAD', note: 'This repository has no commit yet, so the worktree starts empty' })
    const wt = await gitWorktreeAdd(empty, join(root, 'wt-empty'), 'centralu/e', base.sha ?? undefined, TRUSTED)
    expect(wt.branch).toBe('centralu/e')
  })
})
