import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { canonicalPath } from '../dev-services/path-guard.js'
import { WorktreeSessions, type WorktreeHost } from './worktree-sessions.js'

/*
 * The worktree code over a host it reaches only through `WorktreeHost` (#428): the refusals before anything is checked
 * out, and which sessions a cleanup under way holds still. Checking out, setting up and cleaning up are covered over
 * the real manager (manager-worktree.test.ts, worktree sessions).
 */

let root: string
let store: Store
let meta: Map<string, SessionInfo>

/** A host with only `given`; reading anything else throws, naming it */
function hostWith(given: Partial<WorktreeHost>): WorktreeHost {
  return new Proxy(given as WorktreeHost, {
    get(target, key) {
      if (key in target) return target[key as keyof WorktreeHost]
      throw new Error(`the worktree code read host.${String(key)}, which this test did not give it`)
    },
  })
}
const repo = (name: string) => {
  const dir = join(root, name)
  mkdirSync(dir)
  execFileSync('git', ['init', '-q', dir])
  return dir
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-worktrees-')))
  store = new Store()
  meta = new Map()
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

describe('before anything is checked out', () => {
  it('a folder that is not a git repository has no worktrees', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const wt = new WorktreeSessions(hostWith({ gitTrust: () => ({ trusted: true }) }))
    await expect(wt.createWorktree({ cwd: plain, projectId: 'p1' }, 's1')).rejects.toThrow('Worktrees need a git repository. This directory is not one.')
  })

  it("an untrusted project's repository is not checked out, unless the asking session's auto opens that boundary", async () => {
    const dir = repo('untrusted')
    const asked: string[] = []
    const wt = new WorktreeSessions(hostWith({
      gitTrust: () => ({ trusted: false }),
      projectTrusted: () => false,
      autoBoundaryOpen: (id, boundary) => (asked.push(`${id}:${boundary}`), false),
      worktreeRoot: join(root, 'trees'),
    }))
    const refusal = "Worktree sessions need a trusted project: checking out runs the repository's hooks and filters. Trust the project first."
    await expect(wt.createWorktree({ cwd: dir, projectId: 'p1' }, 's1')).rejects.toThrow(refusal)
    await expect(wt.createWorktree({ cwd: dir, projectId: 'p1', askedBy: 'parent' }, 's1')).rejects.toThrow(refusal)
    expect(asked).toEqual(['parent:worktree in an untrusted project'])
  })

  it('a branch name git would refuse is refused before the checkout', async () => {
    const dir = repo('trusted')
    const wt = new WorktreeSessions(hostWith({ gitTrust: () => ({ trusted: true }), projectTrusted: () => true, worktreeRoot: join(root, 'trees') }))
    await expect(wt.createWorktree({ cwd: dir, projectId: 'p1', worktreeBranch: 'bad..name' }, 's1')).rejects.toThrow('Not a valid branch name: bad..name')
  })

  it('a session with no worktree of its own has nothing to clean up', async () => {
    const wt = new WorktreeSessions(hostWith({}))
    expect(await wt.cleanUpWorktreeChild({ id: 'c', name: 'Child', projectId: 'p1', worktree: null } as SessionInfo)).toEqual({
      ok: false,
      error: '"Child" works in no worktree of its own, so there is nothing to clean up — the person deletes a session',
    })
  })
})

describe('what a cleanup under way holds still (#647)', () => {
  it('the child whose worktree goes, and any session working inside that worktree; nobody else', () => {
    const tree = join(root, 'trees', 'child')
    mkdirSync(join(tree, 'pkg'), { recursive: true })
    const wt = new WorktreeSessions(hostWith({ store, meta }))
    const at = (id: string, path: string) => meta.set(id, { id, worktree: { path, branch: 'b' } } as SessionInfo)
    at('helper', join(tree, 'pkg'))
    at('other', root)
    expect(wt.worktreeCleanupBlocks('helper')).toBe(false)
    // The code keeps the native canonical form (`canonicalPath`): on Windows that is the long name, not the 8.3 one
    wt.worktreeCleanup.set('child', canonicalPath(tree))
    expect(wt.worktreeCleanupBlocks('child')).toBe(true)
    expect(wt.worktreeCleanupBlocks('helper')).toBe(true)
    expect(wt.worktreeCleanupBlocks('other')).toBe(false)
    expect(wt.worktreeCleanupBlocks('unknown')).toBe(false)
  })
})

describe('where a new session worktree forks from (#1484)', () => {
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com']

  it('forks from the fetched trunk, not the checkout\'s branch, records it as the base, and names the commit', async () => {
    const bare = join(root, 'origin.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    const dir = join(root, 'checkout')
    execFileSync('git', ['init', '-q', '-b', 'main', dir])
    git(dir, [...identity, 'commit', '-q', '--allow-empty', '-m', 'one'])
    git(dir, ['remote', 'add', 'origin', bare])
    git(dir, ['push', '-q', '-u', 'origin', 'main'])
    // The remote moves on; the checkout sits on an unrelated branch, behind
    const other = join(root, 'other')
    execFileSync('git', ['clone', '-q', bare, other])
    git(other, [...identity, 'commit', '-q', '--allow-empty', '-m', 'two'])
    git(other, ['push', '-q', 'origin', 'main'])
    const tip = git(other, ['rev-parse', 'HEAD'])
    git(dir, ['switch', '-q', '--orphan', 'audit'])
    git(dir, [...identity, 'commit', '-q', '--allow-empty', '-m', 'unrelated'])

    const wt = new WorktreeSessions(
      hostWith({
        store,
        gitTrust: () => ({ trusted: true }),
        projectTrusted: () => true,
        trunkOf: () => 'main',
        worktreeRoot: join(root, 'trees'),
      }),
    )
    const id = '00000000-0000-4000-8000-000000000001'
    const { worktree, base } = await wt.createWorktree({ cwd: dir, projectId: 'p1' }, id)
    expect(git(worktree.path, ['rev-parse', 'HEAD'])).toBe(tip)
    expect(git(worktree.path, ['merge-base', 'HEAD', 'origin/main'])).toBe(tip)
    expect(worktree.base).toBe(tip)
    expect(base.note).toBe(`Forked from origin/main at ${tip.slice(0, 9)}, fetched just now`)
  })
})
