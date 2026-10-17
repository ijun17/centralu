import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fixtureGit, removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { gitSummary, gitWorktreeAdd, gitWorktreeDirty, gitWorktreeList, gitWorktreeRemove } from './git.js'

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
