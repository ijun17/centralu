import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as gitModule from './git-exec.js'
import { restoreWorktreeRecovery, saveWorktreeRecovery, worktreeRecoveryDir } from './worktree-recovery.js'

const git = (cwd: string, args: string[]) => execFileSync('git', [
  '-c', 'user.name=Recovery test', '-c', 'user.email=recovery@example.test', '-c', 'core.autocrlf=false', ...args,
], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const gitPath = (path: string) => path.replaceAll('\\', '/')

describe('worktree recovery follow-ups (#608)', () => {
  let dir: string
  let repo: string
  let child: string
  let sessionId: string
  const branch = 'worker'

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-recovery-')))
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

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
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
      const privateRepo = realpathSync(git(module, ['rev-parse', '--absolute-git-dir']))
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
    }, process.platform === 'win32' ? 90_000 : 30_000,
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
    }, process.platform === 'win32' ? 90_000 : 30_000,
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
    }, process.platform === 'win32' ? 90_000 : 30_000,
  )
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
  }, process.platform === 'win32' ? 90_000 : 30_000)

  it('review: preserves old-path gitlinks after git mv with a stable custom module name', async () => {
    const { base, module } = moduleFixture()
    const tip = commit(module, 'only recorded under old name\n')
    git(child, ['add', 'old module'])
    git(child, ['commit', '-qm', 'record module work'])
    git(module, ['checkout', '-q', '--detach', base])
    git(child, ['add', 'old module'])
    git(child, ['commit', '-qm', 'move module HEAD back'])
    const privateDir = realpathSync(git(module, ['rev-parse', '--absolute-git-dir']))
    git(child, ['mv', 'old module', 'new module'])
    git(child, ['commit', '-qm', 'rename module'])
    expect(realpathSync(git(join(child, 'new module'), ['rev-parse', '--absolute-git-dir']))).toBe(privateDir)
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
  }, process.platform === 'win32' ? 90_000 : 30_000)

  it('review: scans a long missing-trunk history and a tree larger than the stdout limit in bounded calls', async () => {
    const inputGit = (args: string[], input: string) => execFileSync('git', [
      '-c', 'user.name=Recovery test', '-c', 'user.email=recovery@example.test', ...args,
    ], { cwd: repo, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    const blob = git(repo, ['rev-parse', 'HEAD:file.txt'])
    // No giant checkout: real Git trees/commits are sufficient to reproduce the old
    // 32 MiB ls-tree overflow, and raw history exceeds that buffer as well.
    const rows = Array.from({ length: 140_000 }, (_, n) => `100644 blob ${blob}\t${String(n).padStart(6, '0')}-${'x'.repeat(190)}\n`).join('')
    expect(Buffer.byteLength(rows)).toBeGreaterThan(32 * 1024 * 1024)
    const tree = inputGit(['mktree'], rows)
    const initial = git(repo, ['rev-parse', 'HEAD'])
    let stream = ''
    for (let n = 0; n < 2_000; n++) {
      stream += `commit refs/heads/${branch}\nmark :${n + 1}\ncommitter Recovery <recovery@example.test> ${1700000000 + n} +0000\ndata 4\nstep\nfrom ${n ? `:${n}` : initial}\n`
      if (n === 0) stream += `M 040000 ${tree} giant\n`
      if (n === 1_999) stream += `deleteall\nM 100644 ${blob} file.txt\n`
      stream += '\n'
    }
    inputGit(['fast-import', '--quiet'], stream)
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
  }, process.platform === 'win32' ? 180_000 : 60_000)

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
  }, process.platform === 'win32' ? 90_000 : 30_000)

})
