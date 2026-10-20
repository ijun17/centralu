import { randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorMessage } from '@cc/protocol'
import { FIXTURE_GIT_CONFIG, fixtureGit, removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import * as gitModule from './git-exec.js'
import { clearRecoveredBranchMark, repairWorktreeRecoveryRemovals, restoreWorktreeRecovery, saveWorktreeRecovery, worktreeRecoveryDir } from './worktree-recovery.js'
import { SLOW } from '../../../../tooling/test-timing.js'

const git = (cwd: string, args: string[]) => fixtureGit(cwd, [
  '-c', 'user.name=Recovery test', '-c', 'user.email=recovery@example.test', '-c', 'core.autocrlf=false', ...args,
]).trim()
const gitPath = (path: string) => path.replaceAll('\\', '/')
const canonicalPath = (path: string) => gitPath(realpathSync.native(path))

describe('worktree recovery follow-ups (#608)', () => {
  let dir: string
  let repo: string
  let child: string
  let sessionId: string
  const branch = 'worker'

  beforeEach(() => {
    dir = tempRoot('cc-recovery-')
    vi.stubEnv('CC_DATA_DIR', join(dir, 'data'))
    repo = join(dir, 'repo')
    child = join(dir, 'child')
    sessionId = randomUUID()
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'core.autocrlf', 'false'])
    writeFileSync(join(repo, 'file.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await removeTree(dir)
  })

  /*
   * The snapshot a restore reads back is a file in the data folder (#384): cut short by a stop mid-write, or edited by
   * hand. The restore failed with JSON's own SyntaxError, which named nothing. It names the file now, and its patches
   * and bundles stay where they are for a restore by hand.
   */
  it.each([
    ['not JSON', '{"repositories":[{"path":'],
    ['without a repository', '{"repositories":[]}'],
  ])('a snapshot that is %s fails the restore naming the file, and its files stay', async (_label, text) => {
    const snapshot = randomUUID()
    const kept = join(worktreeRecoveryDir(sessionId), snapshot)
    mkdirSync(kept, { recursive: true })
    writeFileSync(join(kept, 'snapshot.json'), text)
    writeFileSync(join(kept, '0.patch'), 'a patch')
    const recovery = { snapshot, tip: 'a'.repeat(40), changedFiles: 1, commits: 0 }
    await expect(restoreWorktreeRecovery(sessionId, repo, child, branch, recovery, {})).rejects.toThrow(
      `The recovery snapshot ${join(kept, 'snapshot.json')} could not be read`,
    )
    expect(existsSync(join(kept, '0.patch'))).toBe(true)
  })

  const commit = (cwd: string, content: string) => {
    writeFileSync(join(cwd, 'file.txt'), content)
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-qm', content.trim()])
    return git(cwd, ['rev-parse', 'HEAD'])
  }
  const moduleFixture = () => {
    const source = join(dir, 'source')
    git(dir, ['init', '-q', '-b', 'main', source])
    const base = commit(source, 'module base\n')
    git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'stable-name', source, 'old module'])
    git(repo, ['commit', '-qam', 'add module'])
    git(repo, ['worktree', 'add', '-b', branch, child])
    git(child, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'])
    return { source, base, module: join(child, 'old module') }
  }
  const remove = () => {
    git(repo, ['worktree', 'remove', '--force', '--force', child])
    git(repo, ['branch', '-D', branch])
  }

  /*
   * Every read before trust used to list the folder's filter drivers in a git process of its own first, so a save was
   * about thirty git processes for one repository. On windows-2022 at 100 ms or more each, a test that deleted two
   * worktrees ran past 15 s (#368). The save's reads share one listing per repository, and the `add -A` that runs
   * clean filters takes its own right before it; every driver is still turned off.
   */
  const plantFilter = (name: string, ran: string) => {
    git(repo, ['config', `filter.${name}.clean`, `sh -c 'echo clean >> "${gitPath(ran)}"; cat'`])
    git(repo, ['config', `filter.${name}.smudge`, `sh -c 'echo smudge >> "${gitPath(ran)}"; cat'`])
  }
  const traced = async <T>(run: () => Promise<T>): Promise<{ result: T; listings: number; starts: number }> => {
    const trace = join(dir, 'trace')
    mkdirSync(trace)
    process.env.GIT_TRACE2_EVENT = trace
    let result: T
    try {
      result = await run()
    } finally {
      delete process.env.GIT_TRACE2_EVENT
    }
    const starts = readdirSync(trace).flatMap((name) => readFileSync(join(trace, name), 'utf8').split('\n'))
      .filter(Boolean).map((line) => JSON.parse(line) as { event: string; argv?: string[] })
      .filter((e) => e.event === 'start')
    const listings = starts.filter((e) => e.argv!.includes('--get-regexp') && e.argv!.includes('^filter\\.')).length
    return { result, listings, starts: starts.length }
  }

  it('lists the filter drivers twice per repository, and every call of the save still runs none of them (#368)', async () => {
    git(repo, ['worktree', 'add', '-b', branch, child])
    commit(child, 'committed work\n')
    const ran = join(dir, 'filter-ran')
    plantFilter('planted', ran)
    writeFileSync(join(child, '.gitattributes'), '* filter=planted\n')
    writeFileSync(join(child, 'new.txt'), 'uncommitted work\n')
    const { result, listings, starts } = await traced(() => saveWorktreeRecovery(sessionId, child, 'main', branch))
    expect(starts).toBeGreaterThan(10)
    // One shared by the reads, one made right before `add -A`
    expect(listings).toBe(2)
    expect(existsSync(ran)).toBe(false)
    expect(result).toMatchObject({ changedFiles: 2, commits: 1 })
  })

  /*
   * The save runs while the project's other sessions go on, and one of them can write a driver into the configuration
   * the worktree shares, after the reads listed theirs. The worktree's .gitattributes names it here from the start.
   */
  it('turns off for add -A a filter driver written after the save listed its drivers (#368)', async () => {
    git(repo, ['worktree', 'add', '-b', branch, child])
    commit(child, 'committed work\n')
    const ran = join(dir, 'filter-ran')
    writeFileSync(join(child, '.gitattributes'), '* filter=late\n')
    writeFileSync(join(child, 'new.txt'), 'uncommitted work\n')
    const run = gitModule.runGit
    let written = false
    const calls = vi.spyOn(gitModule, 'runGit').mockImplementation(async (cwd, args, opts) => {
      // During the history scan: after the reads' listing, before `add -A`
      if (!written && args[0] === 'log') {
        plantFilter('late', ran)
        written = true
      }
      return run(cwd, args, opts)
    })
    try {
      const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
      expect(written).toBe(true)
      expect(calls.mock.calls.some(([, args]) => args[0] === 'add')).toBe(true)
      expect(recovery).toMatchObject({ changedFiles: 2, commits: 1 })
    } finally {
      calls.mockRestore()
    }
    expect(existsSync(ran)).toBe(false)
  })

  it.each(['history', 'index', 'stored branch'])(
    'bundles a gitlink-only module commit from the %s after module HEAD moves away', async (location) => {
      const source = join(dir, 'module-source')
      git(dir, ['init', '-q', '-b', 'main', source])
      const base = commit(source, 'module base\n')
      git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'modules/nested space'])
      git(repo, ['commit', '-qam', 'add module'])
      git(repo, ['worktree', 'add', '-b', branch, child])
      git(child, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'])
      const module = join(child, 'modules', 'nested space')
      const privateRepo = canonicalPath(git(module, ['rev-parse', '--absolute-git-dir']))
      const tip = commit(module, 'module work\n')
      git(child, ['add', 'modules/nested space'])
      if (location !== 'index') {
        git(child, ['commit', '-qm', 'record module work'])
      }
      git(module, ['checkout', '-q', '--detach', base])
      if (location === 'history') {
        // The current tree no longer names the module commit either.
        git(child, ['add', 'modules/nested space'])
        git(child, ['commit', '-qm', 'move module back'])
      } else if (location === 'stored branch') {
        git(child, ['checkout', '-q', '--detach', 'main'])
      }
      expect(git(module, ['branch', '--contains', tip])).toBe('')
      git(child, ['config', 'diff.ignoreSubmodules', 'all'])
      const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
      expect(git(module, ['for-each-ref', '--format=%(refname)', 'refs/centralu-recovery/'])).toBe('')
      const snapshotDir = join(worktreeRecoveryDir(sessionId), recovery.snapshot)
      remove()
      expect(existsSync(privateRepo)).toBe(false)
      const snapshot = JSON.parse(readFileSync(join(snapshotDir, 'snapshot.json'), 'utf8')) as {
        repositories: { path: string; refs: string[] }[]
      }
      const index = snapshot.repositories.findIndex((entry) => entry.path === gitPath(join('modules', 'nested space')))
      expect(index).toBeGreaterThan(0)
      const bundle = join(snapshotDir, `${index}.bundle`)
      expect(existsSync(bundle)).toBe(true)
      const refs = git(repo, ['bundle', 'list-heads', bundle]).split('\n')
      const ref = refs.find((row) => row.startsWith(`${tip} `))?.split(' ')[1]
      expect(ref).toBeDefined()
      const recovered = join(dir, 'recovered-module')
      git(dir, ['init', '-q', recovered])
      git(recovered, ['fetch', bundle, `${ref}:refs/heads/recovered`])
      expect(git(recovered, ['show', 'recovered:file.txt'])).toBe('module work')
    }, 30_000 * SLOW,
  )

  it.each(['switched', 'detached', 'occupied'])(
    'restores the differing stored branch as a reachable recovery branch with %s HEAD', async (mode) => {
      git(repo, ['worktree', 'add', '-b', branch, child])
      const storedTip = commit(child, 'stored work\n')
      git(child, ['checkout', '-q', '-b', 'other', 'main'])
      const head = commit(child, 'HEAD work\n')
      if (mode === 'detached') {
        git(child, ['checkout', '-q', '--detach'])
        git(repo, ['branch', '-D', 'other'])
      }
      const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
      remove()
      if (mode === 'occupied') {
        git(repo, ['branch', branch, 'main'])
        git(repo, ['branch', `recovered/${sessionId}-stored-branch`, 'main'])
      }
      const restored = await restoreWorktreeRecovery(sessionId, repo, child, branch, recovery, {})
      expect(git(child, ['rev-parse', 'HEAD'])).toBe(head)
      const recovered = git(repo, ['for-each-ref', '--format=%(refname:short)', '--points-at', storedTip, 'refs/heads/recovered/'])
      expect(recovered).toMatch(/^recovered\//)
      expect(restored.notice).toContain(recovered)
      expect(git(repo, ['show', `${recovered}:file.txt`])).toBe('stored work')
      if (mode === 'occupied') {
        expect(git(repo, ['rev-parse', branch])).toBe(git(repo, ['rev-parse', 'main']))
        expect(git(repo, ['rev-parse', `recovered/${sessionId}-stored-branch`])).toBe(git(repo, ['rev-parse', 'main']))
      }
      const refs = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/recovered/'])
      await restoreWorktreeRecovery(sessionId, repo, child, branch, recovery, {})
      expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/recovered/'])).toBe(refs)
    }, 30_000 * SLOW,
  )

  it.each(['working', 'staged', 'both'])(
    'warns about unapplied %s patches on retry after worktree creation', async (patches) => {
      git(repo, ['worktree', 'add', '-b', branch, child])
      writeFileSync(join(child, 'file.txt'), 'saved work\n')
      if (patches !== 'working') git(child, ['add', 'file.txt'])
      if (patches === 'staged') writeFileSync(join(child, 'file.txt'), 'base\n')
      const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
      remove()
      // Reproduce a process exit after worktree add, before either patch is applied.
      git(repo, ['worktree', 'add', '-b', branch, child, recovery.tip])
      const restored = await restoreWorktreeRecovery(sessionId, repo, child, branch, recovery, {})
      expect(restored.notice).toContain('saved patches were not applied on this retry')
      expect(restored.notice).toContain('manual recovery')
      expect(readFileSync(join(child, 'file.txt'), 'utf8')).toBe('base\n')
      expect(git(child, ['show', ':file.txt'])).toBe('base')
    }, 30_000 * SLOW,
  )
  it.each(['original', 'recovered'])(
    'retries a restore whose failed first attempt left the %s branch behind (#647)', async (name) => {
      git(repo, ['worktree', 'add', '-b', branch, child])
      const tip = commit(child, 'saved work\n')
      writeFileSync(join(child, 'file.txt'), 'uncommitted\n')
      const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
      remove()
      if (name === 'recovered') git(repo, ['branch', branch, 'main'])
      const expected = `recovered/${sessionId}`
      // `git worktree add -b` creates the branch before the folder: a parent that is a file fails the second step.
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, '')
      const path = join(blocker, 'child')
      await expect(restoreWorktreeRecovery(sessionId, repo, path, branch, recovery, {})).rejects.toThrow()
      expect(git(repo, ['rev-parse', name === 'recovered' ? expected : branch])).toBe(tip)
      expect(existsSync(path)).toBe(false)
      rmSync(blocker)
      const restored = await restoreWorktreeRecovery(sessionId, repo, path, branch, recovery, {})
      expect(restored.branch).toBe(expected)
      expect(git(path, ['symbolic-ref', '--short', 'HEAD'])).toBe(expected)
      expect(git(path, ['rev-parse', 'HEAD'])).toBe(tip)
      expect(readFileSync(join(path, 'file.txt'), 'utf8')).toBe('uncommitted\n')
      expect(git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/recovered/'])).toBe(expected)
      // The original name the first attempt created is left as it is, like any branch the person could have made
      if (name === 'original') expect(git(repo, ['rev-parse', branch])).toBe(tip)
    }, 30_000 * SLOW,
  )

  it('does not adopt a recovery-named branch the person made, even at the saved tip (#647)', async () => {
    git(repo, ['worktree', 'add', '-b', branch, child])
    const tip = commit(child, 'saved work\n')
    const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
    remove()
    git(repo, ['branch', branch, 'main'])
    git(repo, ['branch', `recovered/${sessionId}`, tip])
    const restored = await restoreWorktreeRecovery(sessionId, repo, child, branch, recovery, {})
    expect(restored.branch).toBe(`recovered/${sessionId}-1`)
    expect(git(repo, ['rev-parse', `refs/centralu/recovered/recovered/${sessionId}-1`])).toBe(tip)
    expect(() => git(repo, ['rev-parse', '--verify', `refs/centralu/recovered/recovered/${sessionId}`])).toThrow()
  }, 30_000 * SLOW)

  it('does not adopt a recovery branch the person deleted and made again at the saved tip (#647)', async () => {
    git(repo, ['worktree', 'add', '-b', branch, child])
    const tip = commit(child, 'saved work\n')
    const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
    remove()
    git(repo, ['branch', branch, 'main'])
    const first = await restoreWorktreeRecovery(sessionId, repo, child, branch, recovery, {})
    expect(first.branch).toBe(`recovered/${sessionId}`)
    // The person removes the restored worktree and branch by hand (the mark stays), then makes the branch again
    git(repo, ['worktree', 'remove', '--force', child])
    git(repo, ['branch', '-D', `recovered/${sessionId}`])
    git(repo, ['branch', `recovered/${sessionId}`, tip])
    const again = await restoreWorktreeRecovery(sessionId, repo, child, branch, recovery, {})
    expect(again.branch).toBe(`recovered/${sessionId}-1`)
  }, 30_000 * SLOW)

  it('drops the mark together with its recovery branch (#647)', async () => {
    git(repo, ['worktree', 'add', '-b', branch, child])
    commit(child, 'saved work\n')
    const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
    remove()
    git(repo, ['branch', branch, 'main'])
    const restored = await restoreWorktreeRecovery(sessionId, repo, child, branch, recovery, {})
    expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/centralu/'])).toBe(`refs/centralu/recovered/${restored.branch}`)
    await clearRecoveredBranchMark(repo, restored.branch)
    expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/centralu/'])).toBe('')
    await clearRecoveredBranchMark(repo, branch)
  }, 30_000 * SLOW)

  it('repairs the other folders when one folder left by a purge cannot be repaired (#647)', async () => {
    const root = join(dir, 'data', 'worktree-recovery')
    const [blocked, other] = [randomUUID(), randomUUID()].sort() as [string, string]
    // The blocked session's own name is taken by a file, so its snapshots cannot be moved back
    mkdirSync(join(root, `${blocked}.purging-1`, 'snap'), { recursive: true })
    writeFileSync(join(root, blocked), '')
    mkdirSync(join(root, `${other}.purging-2`, 'snap'), { recursive: true })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await repairWorktreeRecoveryRemovals(() => true)
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`${blocked}.purging-1`))
    } finally {
      log.mockRestore()
    }
    expect(existsSync(join(root, other, 'snap'))).toBe(true)
    expect(existsSync(join(root, `${other}.purging-2`))).toBe(false)
    expect(existsSync(join(root, `${blocked}.purging-1`, 'snap'))).toBe(true)
  })

  it('leaves a recovery branch that moved on alone and numbers its own (#647)', async () => {
    git(repo, ['worktree', 'add', '-b', branch, child])
    const tip = commit(child, 'saved work\n')
    const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
    remove()
    git(repo, ['branch', branch, 'main'])
    git(repo, ['branch', `recovered/${sessionId}`, 'main'])
    const restored = await restoreWorktreeRecovery(sessionId, repo, child, branch, recovery, {})
    expect(restored.branch).toBe(`recovered/${sessionId}-1`)
    expect(git(child, ['rev-parse', 'HEAD'])).toBe(tip)
    expect(git(repo, ['rev-parse', `recovered/${sessionId}`])).toBe(git(repo, ['rev-parse', 'main']))
  }, 30_000 * SLOW)

  it.each(['history', 'index'])('review: ignores unfetched gitlinks from the %s before deleting', async (location) => {
    const { source, module } = moduleFixture()
    const absent = commit(source, 'work from another worker\n')
    git(child, ['update-index', '--cacheinfo', `160000,${absent},old module`])
    if (location === 'history') git(child, ['commit', '-qm', 'merge another worker without updating module'])
    expect(() => git(module, ['cat-file', '-e', `${absent}^{commit}`])).toThrow()
    const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
    remove()
    expect(existsSync(child)).toBe(false)
    expect(recovery.commits).toBe(location === 'history' ? 1 : 0)
  }, 30_000 * SLOW)

  it('review: preserves old-path gitlinks after git mv with a stable custom module name', async () => {
    const { base, module } = moduleFixture()
    const tip = commit(module, 'only recorded under old name\n')
    git(child, ['add', 'old module'])
    git(child, ['commit', '-qm', 'record module work'])
    git(module, ['checkout', '-q', '--detach', base])
    git(child, ['add', 'old module'])
    git(child, ['commit', '-qm', 'move module HEAD back'])
    const privateDir = canonicalPath(git(module, ['rev-parse', '--absolute-git-dir']))
    git(child, ['mv', 'old module', 'new module'])
    git(child, ['commit', '-qm', 'rename module'])
    expect(canonicalPath(git(join(child, 'new module'), ['rev-parse', '--absolute-git-dir']))).toBe(privateDir)
    const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
    const snapshotDir = join(worktreeRecoveryDir(sessionId), recovery.snapshot)
    remove()
    expect(existsSync(privateDir)).toBe(false)
    const snapshot = JSON.parse(readFileSync(join(snapshotDir, 'snapshot.json'), 'utf8')) as {
      repositories: { path: string }[]
    }
    const index = snapshot.repositories.findIndex((entry) => entry.path === 'new module')
    const bundle = join(snapshotDir, `${index}.bundle`)
    expect(existsSync(bundle)).toBe(true)
    const ref = git(repo, ['bundle', 'list-heads', bundle]).split('\n').find((row) => row.startsWith(`${tip} `))!.split(' ')[1]!
    const recovered = join(dir, 'recovered-renamed')
    git(dir, ['init', '-q', recovered])
    git(recovered, ['fetch', bundle, `${ref}:refs/heads/recovered`])
    expect(git(recovered, ['show', 'recovered:file.txt'])).toBe('only recorded under old name')
  }, 30_000 * SLOW)

  it('keeps a module commit recorded only by a gitlink already merged into the trunk (#623)', async () => {
    const { base, module } = moduleFixture()
    const tip = commit(module, 'only the deleted worktree has this\n')
    git(child, ['add', 'old module'])
    git(child, ['commit', '-qm', 'record module work'])
    // Merging the gitlink publishes nothing: the module object stays in the worker's private repository.
    git(repo, ['merge', '--ff-only', branch])
    git(module, ['checkout', '-q', '--detach', base])
    git(child, ['add', 'old module'])
    git(child, ['commit', '-qm', 'move module back'])
    git(repo, ['merge', '--ff-only', branch])
    // Nothing is left unmerged, and neither HEAD's tree nor the index names the commit.
    expect(git(child, ['rev-list', '--count', 'main..HEAD'])).toBe('0')
    expect(git(module, ['branch', '--contains', tip])).toBe('')
    const privateDir = canonicalPath(git(module, ['rev-parse', '--absolute-git-dir']))
    const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
    const snapshotDir = join(worktreeRecoveryDir(sessionId), recovery.snapshot)
    remove()
    expect(existsSync(privateDir)).toBe(false)
    const snapshot = JSON.parse(readFileSync(join(snapshotDir, 'snapshot.json'), 'utf8')) as {
      repositories: { path: string }[]
    }
    const index = snapshot.repositories.findIndex((entry) => entry.path === 'old module')
    const bundle = join(snapshotDir, `${index}.bundle`)
    expect(existsSync(bundle)).toBe(true)
    const ref = git(repo, ['bundle', 'list-heads', bundle]).split('\n').find((row) => row.startsWith(`${tip} `))!.split(' ')[1]!
    const recovered = join(dir, 'recovered-merged')
    git(dir, ['init', '-q', recovered])
    git(recovered, ['fetch', bundle, `${ref}:refs/heads/recovered`])
    expect(git(recovered, ['show', 'recovered:file.txt'])).toBe('only the deleted worktree has this')
  }, 30_000 * SLOW)

  it('does not bundle a merged gitlink whose module commit a remote has (#623)', async () => {
    const { source, base, module } = moduleFixture()
    const published = commit(source, 'published by the module remote\n')
    git(module, ['fetch', '-q', 'origin'])
    git(module, ['checkout', '-q', '--detach', published])
    git(child, ['add', 'old module'])
    git(child, ['commit', '-qm', 'record published module work'])
    git(module, ['checkout', '-q', '--detach', base])
    git(child, ['add', 'old module'])
    git(child, ['commit', '-qm', 'move module back'])
    git(repo, ['merge', '--ff-only', branch])
    const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
    const snapshot = JSON.parse(readFileSync(join(worktreeRecoveryDir(sessionId), recovery.snapshot, 'snapshot.json'), 'utf8')) as {
      repositories: { path: string; bundle: boolean; refs: string[] }[]
    }
    remove()
    expect(recovery.commits).toBe(0)
    expect(snapshot.repositories.find((entry) => entry.path === 'old module')).toMatchObject({ bundle: false })
    expect(snapshot.repositories.find((entry) => entry.path === 'old module')!.refs).not.toContain(published)
  }, 30_000 * SLOW)

  it('keeps a merged gitlink under a module name that was renamed since (#623)', async () => {
    const { base, module } = moduleFixture()
    const tip = commit(module, 'recorded under the old path, merged\n')
    git(child, ['add', 'old module'])
    git(child, ['commit', '-qm', 'record module work'])
    git(module, ['checkout', '-q', '--detach', base])
    git(child, ['add', 'old module'])
    git(child, ['commit', '-qm', 'move module back'])
    git(child, ['mv', 'old module', 'new module'])
    git(child, ['commit', '-qm', 'rename module'])
    git(repo, ['merge', '--ff-only', branch])
    const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
    const snapshotDir = join(worktreeRecoveryDir(sessionId), recovery.snapshot)
    remove()
    const snapshot = JSON.parse(readFileSync(join(snapshotDir, 'snapshot.json'), 'utf8')) as { repositories: { path: string }[] }
    const bundle = join(snapshotDir, `${snapshot.repositories.findIndex((entry) => entry.path === 'new module')}.bundle`)
    expect(git(repo, ['bundle', 'list-heads', bundle])).toContain(`${tip} `)
  }, 30_000 * SLOW)

  it('review: scans a long missing-trunk history and a tree larger than the stdout limit in bounded calls', async () => {
    /*
     * Not execFileSync (#368): writing a 32 MiB tree and 2,000 commits held the worker for 10 s on a fast Windows PC,
     * and a held worker answers nothing (vitest gives up on its own messages at 60 s).
     */
    const inputGit = (args: string[], input: string) => new Promise<string>((resolve, reject) => {
      const child = execFile('git', [...FIXTURE_GIT_CONFIG, '-c', 'user.name=Recovery test', '-c', 'user.email=recovery@example.test', ...args], {
        cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      }, (err, out) => (err ? reject(new Error(errorMessage(err), { cause: err })) : resolve(out.trim())))
      child.stdin?.end(input)
    })
    const blob = git(repo, ['rev-parse', 'HEAD:file.txt'])
    // No giant checkout: real Git trees/commits are sufficient to reproduce the old
    // 32 MiB ls-tree overflow, and raw history exceeds that buffer as well.
    const rows = Array.from({ length: 140_000 }, (_, n) => `100644 blob ${blob}\t${String(n).padStart(6, '0')}-${'x'.repeat(190)}\n`).join('')
    expect(Buffer.byteLength(rows)).toBeGreaterThan(32 * 1024 * 1024)
    const tree = await inputGit(['mktree'], rows)
    const initial = git(repo, ['rev-parse', 'HEAD'])
    let stream = ''
    for (let n = 0; n < 2_000; n++) {
      stream += `commit refs/heads/${branch}\nmark :${n + 1}\ncommitter Recovery <recovery@example.test> ${1700000000 + n} +0000\ndata 4\nstep\nfrom ${n ? `:${n}` : initial}\n`
      if (n === 0) stream += `M 040000 ${tree} giant\n`
      if (n === 1_999) stream += `deleteall\nM 100644 ${blob} file.txt\n`
      stream += '\n'
    }
    await inputGit(['fast-import', '--quiet'], stream)
    git(repo, ['worktree', 'add', child, branch])
    const calls = vi.spyOn(gitModule, 'runGit')
    try {
      const recovery = await saveWorktreeRecovery(sessionId, child, 'missing-trunk', branch)
      expect(recovery.commits).toBe(2_001)
      expect(calls.mock.calls.filter(([, args]) => args[0] === 'ls-tree')).toHaveLength(1)
      expect(calls.mock.calls.filter(([, args]) => args[0] === 'log')).toHaveLength(1)
      expect(calls.mock.calls.length).toBeLessThan(25)
    } finally {
      calls.mockRestore()
    }
  }, 60_000 * SLOW)

  it.each(['working', 'staged', 'both'])('review: reports previously applied %s patches on a store-restore retry', async (patches) => {
    git(repo, ['worktree', 'add', '-b', branch, child])
    writeFileSync(join(child, 'file.txt'), 'saved work\n')
    if (patches !== 'working') git(child, ['add', 'file.txt'])
    if (patches === 'staged') writeFileSync(join(child, 'file.txt'), 'base\n')
    const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
    remove()
    // The store failed after the first invocation completed patch application.
    await restoreWorktreeRecovery(sessionId, repo, child, branch, recovery, {})
    const index = git(child, ['show', ':file.txt'])
    writeFileSync(join(child, 'file.txt'), 'edits after the interruption\n')
    const retry = await restoreWorktreeRecovery(sessionId, repo, child, branch, recovery, {})
    expect(retry.notice).toContain('Saved patches were applied during the previous restore attempt')
    expect(retry.notice).not.toContain('may still need manual recovery')
    expect(git(child, ['show', ':file.txt'])).toBe(index)
    expect(readFileSync(join(child, 'file.txt'), 'utf8')).toBe('edits after the interruption\n')
  }, 30_000 * SLOW)

  it.each(['combined', 'dense-combined'])('re-review: preserves merge-only gitlinks with log.diffMerges=%s', async (format) => {
    const { base, module } = moduleFixture()
    const target = commit(module, 'only merge M records T\n')
    git(module, ['checkout', '-q', '--detach', base])
    const other = commit(module, 'other parent U\n')
    git(module, ['checkout', '-q', '--detach', base])
    const resolution = commit(module, 'later resolution V\n')
    git(module, ['checkout', '-q', '--detach', base])
    const initial = git(child, ['rev-parse', 'HEAD'])
    const superCommit = (oid: string, parents: string[], message: string) => {
      git(child, ['update-index', '--cacheinfo', `160000,${oid},old module`])
      const tree = git(child, ['write-tree'])
      return git(child, ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message])
    }
    const left = superCommit(base, [initial], 'left')
    const right = superCommit(base, [initial], 'right')
    const merge = superCommit(target, [left, right], 'M records T')
    const otherParent = superCommit(other, [initial], 'other parent records U')
    const merge2 = superCommit(resolution, [merge, otherParent], 'M2 resolves to V')
    git(child, ['reset', '--hard', merge2])
    git(child, ['config', 'log.diffMerges', format])
    expect(git(child, ['log', '-m', '--raw', '--format='])).toContain('::160000')
    const recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
    const bundle = join(worktreeRecoveryDir(sessionId), recovery.snapshot, '1.bundle')
    remove()
    const ref = git(repo, ['bundle', 'list-heads', bundle]).split('\n').find((row) => row.startsWith(`${target} `))?.split(' ')[1]
    expect(ref).toBeDefined()
    const recovered = join(dir, 'merge-recovered')
    git(dir, ['init', '-q', recovered])
    git(recovered, ['fetch', bundle, `${ref}:refs/heads/recovered`])
    expect(git(recovered, ['show', 'recovered:file.txt'])).toBe('only merge M records T')
  }, 30_000 * SLOW)

  it('re-review: keeps a thousand gitlinks off Windows command lines and in the bundle', async () => {
    const { module, base } = moduleFixture()
    const initial = git(child, ['rev-parse', 'HEAD'])
    const importGit = (cwd: string, input: string) => execFileSync('git', ['fast-import', '--quiet'], {
      cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    })
    const header = (ref: string, n: number, parent: string) =>
      `commit ${ref}\nmark :${n + 1}\ncommitter Recovery <recovery@example.test> ${1700000000 + n} +0000\ndata 4\nstep\nfrom ${parent}\n`
    let stream = ''
    for (let n = 0; n < 1_000; n++) stream += header('refs/heads/many', n, n ? `:${n}` : base) + '\n'
    importGit(module, stream)
    const tips = git(module, ['rev-list', 'many', `^${base}`]).split('\n')
    expect(tips.join(' ').length).toBeGreaterThan(32_767)
    stream = ''
    for (const [n, tip] of tips.entries()) {
      stream += header(`refs/heads/${branch}`, n, n ? `:${n}` : initial) + `M 160000 ${tip} "old module"\n\n`
    }
    importGit(child, stream)
    git(child, ['reset', '--hard', branch])
    git(module, ['branch', '-D', 'many'])
    const run = gitModule.runGit
    const calls = vi.spyOn(gitModule, 'runGit').mockImplementation(async (cwd, args, opts) => {
      // Exercise real Git while imposing Windows' command-line bound on every platform.
      if (args.join(' ').length >= 32_767) throw new Error('Windows command line exceeds 32767 characters')
      return run(cwd, args, opts)
    })
    let recovery: Awaited<ReturnType<typeof saveWorktreeRecovery>>
    try {
      recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
      for (const command of ['rev-list', 'log', 'bundle']) {
        const moduleCalls = calls.mock.calls.filter(([cwd, args]) => canonicalPath(cwd) === canonicalPath(module) && args[0] === command)
        expect(moduleCalls.length).toBeGreaterThan(0)
        expect(moduleCalls.every(([, args, opts]) => args.includes('--stdin') && opts?.input)).toBe(true)
      }
    } finally {
      calls.mockRestore()
    }
    expect(recovery!.commits).toBe(2_000)
    const bundle = join(worktreeRecoveryDir(sessionId), recovery!.snapshot, '1.bundle')
    remove()
    const heads = git(repo, ['bundle', 'list-heads', bundle])
    for (const tip of tips) expect(heads).toContain(`${tip} refs/centralu-recovery/`)
  }, 60_000 * SLOW)

  it.each([true, false])('re-review: checking partial-clone gitlinks stays local (lazy-fetch switch supported: %s)', async (supportsSwitch) => {
    const { source, module } = moduleFixture()
    const absent = commit(source, 'available only from the promisor remote\n')
    git(module, ['config', 'protocol.file.allow', 'always'])
    git(module, ['config', 'remote.origin.promisor', 'true'])
    git(module, ['config', 'remote.origin.partialclonefilter', 'blob:none'])
    git(child, ['update-index', '--cacheinfo', `160000,${absent},old module`])
    git(child, ['commit', '-qm', 'record unfetched commit'])
    const trace = join(dir, 'git-trace')
    vi.stubEnv('GIT_TRACE', gitPath(trace))
    const run = gitModule.runGit
    const calls = vi.spyOn(gitModule, 'runGit').mockImplementation((cwd, args, opts) => {
      // Model pre-2.45 Git ignoring GIT_NO_LAZY_FETCH while retaining the real transport.
      if (!supportsSwitch && args[0] === 'cat-file') return run(cwd, args, { ...opts, env: { ...opts?.env, GIT_NO_LAZY_FETCH: '0' } })
      return run(cwd, args, opts)
    })
    let recovery: Awaited<ReturnType<typeof saveWorktreeRecovery>>
    try {
      recovery = await saveWorktreeRecovery(sessionId, child, 'main', branch)
    } finally {
      calls.mockRestore()
    }
    expect(readFileSync(trace, 'utf8')).not.toMatch(supportsSwitch ? /fetch origin/ : /upload-pack/)

    expect(await gitModule.runGit(module, ['cat-file', '--batch-check'], {
      input: `${absent}\n`, env: { GIT_NO_LAZY_FETCH: '1' },
    })).toContain('missing')
    expect(recovery!.commits).toBe(1)
    remove()
  }, 30_000 * SLOW)

})
