import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fixtureGit, removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { gitSummary } from './git.js'
import { gitFetchBranch, gitWorktreeAdd, gitWorktreeDirty, gitWorktreeList, gitWorktreePrune, gitWorktreeRemove, pathKey, resolveForkBase } from './git-worktree.js'

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

  it('removal takes a worktree with uncommitted changes too: the caller has saved them or the person chose to lose them', async () => {
    const path = join(root, 'outside', 'session-3')
    await gitWorktreeAdd(repo, path, 'centralu/wt3', undefined, TRUSTED)
    writeFileSync(join(path, 'a.txt'), 'not committed yet\n')

    await gitWorktreeRemove(repo, path)
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
 * Removing a worktree (#1655, #1560): the host removes the folder and git only drops its entry. On Windows git stopped at
 * a path past 260 characters after it had already dropped its entry and the `.git` file, and it deleted through a
 * junction what the junction led to (measured, git 2.47).
 */
describe('removing a worktree (#1655, #1560)', () => {
  const listed = async (path: string) => (await gitWorktreeList(repo)).some((w) => pathKey(w.path) === pathKey(path))
  /** A pnpm-style node_modules: one path past 260 characters, a junction inside the worktree, and one leading out of it */
  const install = (path: string, outside: string) => {
    let deep = join(path, 'node_modules', '.pnpm')
    for (let i = 0; i < 12; i++) deep = join(deep, `segment-${i}-abcdefghijklmnopqrst`)
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'index.js'), 'x')
    expect(deep.length).toBeGreaterThan(260)
    symlinkSync(join(path, 'node_modules', '.pnpm', 'segment-0-abcdefghijklmnopqrst'), join(path, 'node_modules', 'inside'), 'junction')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'keep.txt'), 'not the worktree\'s')
    symlinkSync(outside, join(path, 'node_modules', 'away'), 'junction')
  }

  it('removes a worktree with paths past 260 characters, and never what a junction in it leads to', async () => {
    const path = join(root, 'worktrees', 'p', 'session-long')
    const outside = join(root, 'outside')
    await gitWorktreeAdd(repo, path, 'centralu/long', undefined, TRUSTED)
    install(path, outside)

    await gitWorktreeRemove(repo, path)
    expect(existsSync(path)).toBe(false)
    expect(await listed(path)).toBe(false)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
  })

  it('finishes a removal git left part way: a folder git no longer lists, without its .git', async () => {
    const path = join(root, 'worktrees', 'p', 'session-left')
    await gitWorktreeAdd(repo, path, 'centralu/left', undefined, TRUSTED)
    install(path, join(root, 'outside'))
    // What git leaves when its delete stops: the entry and the `.git` file gone, the rest still there
    rmSync(join(path, '.git'))
    await gitWorktreePrune(repo)
    expect(await listed(path)).toBe(false)

    // Only inside Centralu's worktree folder: anywhere else an unlisted folder is not taken for a leftover
    await expect(gitWorktreeRemove(repo, path)).rejects.toThrow(/not a worktree/)
    expect(existsSync(path)).toBe(true)
    await gitWorktreeRemove(repo, path, { worktreeRoot: join(root, 'worktrees') })
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(root, 'outside', 'keep.txt'))).toBe(true)
  })

  it('never removes a folder that holds a checkout git lists: the project, with its .git, or a worktree', async () => {
    const path = join(root, 'worktrees', 'p', 'session-held')
    await gitWorktreeAdd(repo, path, 'centralu/held', undefined, TRUSTED)
    writeFileSync(join(path, 'a.txt'), 'not committed\n')

    await expect(gitWorktreeRemove(repo, root, { worktreeRoot: root })).rejects.toThrow(/holds/)
    await expect(gitWorktreeRemove(repo, join(root, 'worktrees', 'p'), { worktreeRoot: join(root, 'worktrees') })).rejects.toThrow(/holds/)
    expect(existsSync(join(repo, '.git'))).toBe(true)
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
    expect(existsSync(join(path, 'a.txt'))).toBe(true)
  })

  // A link names its target to git: removing the link took the other worktree, uncommitted work and all
  it('never removes a link, nor the worktree it leads to', async () => {
    const target = join(root, 'worktrees', 'p', 'session-target')
    await gitWorktreeAdd(repo, target, 'centralu/target', undefined, TRUSTED)
    writeFileSync(join(target, 'a.txt'), 'not committed\n')
    // A junction is Windows' own (POSIX makes a symlink of it); a directory symlink may need a right Windows withholds
    for (const type of ['junction', 'dir'] as const) {
      const link = join(root, 'worktrees', 'p', `session-${type}`)
      try {
        symlinkSync(target, link, type)
      } catch {
        continue
      }
      await expect(gitWorktreeRemove(repo, link, { worktreeRoot: join(root, 'worktrees') })).rejects.toThrow(/is a link/)
      expect(existsSync(join(target, 'a.txt'))).toBe(true)
      expect(await listed(target)).toBe(true)
    }
  })

  it('never takes another project\'s folder of worktrees for a leftover', async () => {
    const worktrees = join(root, 'worktrees')
    const otherProject = join(root, 'other-repo')
    fixtureGit(root, ['init', '-q', '-b', 'main', otherProject])
    writeFileSync(join(otherProject, 'a.txt'), 'x\n')
    fixtureGit(otherProject, ['add', '.'])
    fixtureGit(otherProject, ['commit', '-qm', 'init'])
    const theirs = join(worktrees, 'q', 'session-theirs')
    await gitWorktreeAdd(otherProject, theirs, 'centralu/theirs', undefined, TRUSTED)
    writeFileSync(join(theirs, 'a.txt'), 'not committed\n')

    await expect(gitWorktreeRemove(repo, join(worktrees, 'q'), { worktreeRoot: worktrees })).rejects.toThrow(/not a worktree/)
    expect(existsSync(join(theirs, 'a.txt'))).toBe(true)
  })

  // A Windows short name (8.3) for the folder: git lists its long name, and its entry has to go too
  it.skipIf(process.platform !== 'win32')('removes a worktree named by its short name, git\'s entry included', async (ctx) => {
    const path = join(root, 'worktrees', 'a-folder-with-a-long-name', 'session-short')
    await gitWorktreeAdd(repo, path, 'centralu/short', undefined, TRUSTED)
    const short = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim()
    if (short.toLowerCase() === path.toLowerCase()) ctx.skip()

    await gitWorktreeRemove(repo, short)
    expect(existsSync(path)).toBe(false)
    expect(await listed(path)).toBe(false)
  })

  it('keeps a folder git does not list that has a .git of its own', async () => {
    const other = join(root, 'other')
    fixtureGit(root, ['init', '-q', other])
    writeFileSync(join(other, 'work.txt'), 'someone else\'s')

    await expect(gitWorktreeRemove(repo, other, { worktreeRoot: root })).rejects.toThrow(/not a worktree/)
    expect(existsSync(join(other, 'work.txt'))).toBe(true)
  })

  it('keeps a folder git does not list inside a checkout it lists, or of a folder that is no repository', async () => {
    const inside = join(repo, 'build')
    mkdirSync(inside)
    writeFileSync(join(inside, 'out.txt'), 'the project\'s')
    const plain = join(root, 'plain')
    mkdirSync(plain)
    writeFileSync(join(plain, 'data.txt'), 'kept')

    await expect(gitWorktreeRemove(repo, inside, { worktreeRoot: root })).rejects.toThrow(/not a worktree/)
    await expect(gitWorktreeRemove(plain, join(plain, 'data.txt'), { worktreeRoot: root })).rejects.toThrow(/not a worktree/)
    expect(existsSync(join(inside, 'out.txt'))).toBe(true)
    expect(existsSync(join(plain, 'data.txt'))).toBe(true)
  })

  it('keeps a locked worktree unless asked to take it anyway', async () => {
    const path = join(root, 'worktrees', 'p', 'session-locked')
    await gitWorktreeAdd(repo, path, 'centralu/locked', undefined, TRUSTED)
    fixtureGit(repo, ['worktree', 'lock', path])

    await expect(gitWorktreeRemove(repo, path)).rejects.toThrow(/locked/)
    expect(existsSync(join(path, 'a.txt'))).toBe(true)
    await gitWorktreeRemove(repo, path, { unlocked: true })
    expect(existsSync(path)).toBe(false)
  })

  // A folder POSIX lets no one empty; root may empty it anyway
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says what was left when the folder cannot all be removed, and keeps git\'s entry so it can be tried again', async () => {
    const path = join(root, 'worktrees', 'p', 'session-stuck')
    await gitWorktreeAdd(repo, path, 'centralu/stuck', undefined, TRUSTED)
    mkdirSync(join(path, 'held'))
    writeFileSync(join(path, 'held', 'f.txt'), 'x')
    chmodSync(join(path, 'held'), 0o500)
    try {
      await expect(gitWorktreeRemove(repo, path)).rejects.toThrow(/left/)
      expect(existsSync(join(path, 'held', 'f.txt'))).toBe(true)
      expect(await listed(path)).toBe(true)
    } finally {
      chmodSync(join(path, 'held'), 0o700)
    }
    await gitWorktreeRemove(repo, path)
    expect(existsSync(path)).toBe(false)
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

  it('a remote that failed is not fetched again for a while, also once it answers again (#1488)', async () => {
    const { remoteTip } = withRemote()
    const bare = join(root, 'origin.git')
    fixtureGit(repo, ['remote', 'set-url', 'origin', join(root, 'gone.git')])
    const first = await resolveForkBase(repo, 'main', { trusted: true })
    expect(first.note).toContain('Could not fetch origin')
    expect(first.unfetched).toBe(true)
    fixtureGit(repo, ['remote', 'set-url', 'origin', bare])
    // The remote is fine now, but the failure is remembered: no fetch, the same words, the local ref
    const second = await resolveForkBase(repo, 'main', { trusted: true })
    expect(second).toEqual(first)
    expect(second.sha).not.toBe(remoteTip)
    // Another repository is its own
    const other = join(root, 'second')
    fixtureGit(root, ['clone', '-q', bare, other])
    expect((await resolveForkBase(other, 'main', { trusted: true })).sha).toBe(remoteTip)
  })

  it('a branch the remote does not have is not a failed remote: the next fetch is still made (#1488)', async () => {
    const { remoteTip } = withRemote()
    expect(await gitFetchBranch(repo, 'origin', 'no-such-branch')).toHaveProperty('why')
    expect(await gitFetchBranch(repo, 'origin', 'main')).toEqual({ sha: remoteTip })
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
