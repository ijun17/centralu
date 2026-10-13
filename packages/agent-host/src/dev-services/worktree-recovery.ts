import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isSessionId } from '@cc/protocol'
import { dataRoot } from '../data-dir.js'
import { runGit, type GitTrust } from './git-exec.js'
import { assertExistingPath } from './path-guard.js'

export type WorktreeRecovery = { snapshot: string; tip: string; changedFiles: number; commits: number }
type Snapshot = WorktreeRecovery & { repositories: { path: string; tip: string; patch: boolean; staged: boolean; bundle: boolean }[] }

export function worktreeRecoveryDir(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error('Invalid session id for worktree recovery')
  return join(dataRoot(), 'worktree-recovery', sessionId)
}

export async function clearWorktreeRecovery(sessionId: string): Promise<void> {
  await rm(worktreeRecoveryDir(sessionId), { recursive: true, force: true })
}

/** Snapshot through a private index: never stage the child's files or change its real index. */
export async function saveWorktreeRecovery(sessionId: string, cwd: string, trunk: string): Promise<WorktreeRecovery> {
  const snapshotId = randomUUID()
  const dir = join(worktreeRecoveryDir(sessionId), snapshotId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const snapshot: Snapshot = { snapshot: snapshotId, tip: '', changedFiles: 0, commits: 0, repositories: [] }
  const capture = async (repo: string, path: string, baseline: string): Promise<void> => {
    const n = snapshot.repositories.length
    const tip = (await runGit(repo, ['rev-parse', '--verify', 'HEAD'])).trim()
    const baselineOid = await runGit(repo, ['rev-parse', '--verify', `${baseline}^{commit}`]).then((s) => s.trim()).catch(() => null)
    const commits = Number((await runGit(repo, ['rev-list', '--count', tip, ...(baselineOid ? ['--not', baselineOid] : [])])).trim())
    const entry = { path, tip, patch: false, staged: false, bundle: commits > 0 }
    snapshot.repositories.push(entry)
    if (n === 0) snapshot.tip = tip
    snapshot.commits += commits
    if (entry.bundle) {
      // A full bundle remains usable even after the original repository or trunk disappears.
      await runGit(repo, ['bundle', 'create', join(dir, `${n}.bundle`), 'HEAD'], { timeout: 120_000 })
    }
    const stagedPatch = await runGit(repo, ['diff', '--cached', '--binary', '--full-index', '--no-renames', tip])
    entry.staged = !!stagedPatch
    if (stagedPatch) await writeFile(join(dir, `${n}.staged.patch`), stagedPatch, { mode: 0o600 })
    const stagedNames = await runGit(repo, ['diff', '--cached', '--name-only', '-z', '--no-renames', tip])
    const modules = new Map<string, string>()
    for (const row of (await runGit(repo, ['ls-tree', '-rz', tip])).split('\0')) {
      if (row.startsWith('160000 ')) modules.set(row.slice(row.indexOf('\t') + 1), row.slice(14, row.indexOf('\t')))
    }
    const env = { GIT_INDEX_FILE: join(dir, `${n}.index`) }
    try {
      await runGit(repo, ['read-tree', tip], { env })
      // Locked git disables filters/hooks even for a trusted repo. The patch keeps the actual bytes,
      // including binary files and symlink targets, without executing repository programs.
      await runGit(repo, ['add', '-A', '--', '.'], { env })
      const names = await runGit(repo, ['diff', '--cached', '--name-only', '-z', '--no-renames', tip], { env })
      snapshot.changedFiles += new Set([...names.split('\0'), ...stagedNames.split('\0')].filter(Boolean)).size
      const patch = await runGit(repo, ['diff', '--cached', '--binary', '--full-index', '--no-renames', tip], { env })
      for (const row of (await runGit(repo, ['ls-files', '--stage', '-z'], { env })).split('\0')) {
        if (!row.startsWith('160000 ')) continue
        const rel = row.slice(row.indexOf('\t') + 1)
        if (!modules.has(rel)) modules.set(rel, 'missing-baseline')
      }
      entry.patch = !!patch
      if (patch) await writeFile(join(dir, `${n}.patch`), patch, { mode: 0o600 })
    } finally {
      await rm(env.GIT_INDEX_FILE, { force: true })
    }
    // A superproject patch cannot hold a submodule's working files or local commits.
    for (const [rel, baseline] of modules) {
      await assertExistingPath(repo, rel).catch((e) => {
        if (existsSync(join(repo, rel))) throw e
      })
      if (!existsSync(join(repo, rel, '.git'))) continue
      await capture(join(repo, rel), path ? `${path}/${rel}` : rel, baseline)
    }
  }
  try {
    await capture(cwd, '', trunk)
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify(snapshot), { mode: 0o600 })
    return { snapshot: snapshotId, tip: snapshot.tip, changedFiles: snapshot.changedFiles, commits: snapshot.commits }
  } catch (e) {
    await rm(dir, { recursive: true, force: true })
    throw e
  }
}

export async function worktreeRecoveryBytes(sessionId: string): Promise<number> {
  const dir = worktreeRecoveryDir(sessionId)
  if (!existsSync(dir)) return 0
  const sizes = await Promise.all((await readdir(dir, { recursive: true })).map(async (name) => {
    const s = await stat(join(dir, name))
    return s.isFile() ? s.size : 0
  }))
  return sizes.reduce((a, b) => a + b, 0)
}

/** Restore the root branch/worktree; keep patches available if applying them is no longer feasible. */
export async function restoreWorktreeRecovery(
  sessionId: string, repo: string, path: string, branch: string, recovery: WorktreeRecovery, trust: GitTrust,
): Promise<{ branch: string; notice: string }> {
  if (!isSessionId(recovery.snapshot)) throw new Error('Invalid recovery snapshot')
  const dir = join(worktreeRecoveryDir(sessionId), recovery.snapshot)
  const snapshot = JSON.parse(await readFile(join(dir, 'snapshot.json'), 'utf8')) as Snapshot
  const root = snapshot.repositories[0]!
  if (!existsSync(path)) {
    if (await runGit(repo, ['show-ref', '--verify', `refs/heads/${branch}`]).then(() => true).catch(() => false)) {
      branch = `recovered/${sessionId}`
    }
    if (root.bundle) await runGit(repo, ['fetch', join(dir, '0.bundle'), 'HEAD'], { allowRepoPrograms: trust.trusted === true })
    await runGit(repo, ['worktree', 'add', '-b', branch, path, recovery.tip], { allowRepoPrograms: trust.trusted === true })
    if (root.patch || root.staged) {
      try {
        if (root.staged) await runGit(path, ['apply', '--cached', '--binary', join(dir, '0.staged.patch')])
        if (root.patch) await runGit(path, ['apply', '--binary', join(dir, '0.patch')])
      } catch {
        return { branch, notice: `Restored branch ${branch}. Patches could not all be applied. Recovery files remain at ${dir}; apply numbered .patch files manually with git apply and .staged.patch files with git apply --cached.` }
      }
    }
  } else {
    // A retry can find the worktree created before the store restore failed. Read its actual
    // branch, including a recovery name chosen to avoid an occupied original branch.
    const common = async (cwd: string) => realpath(resolve(cwd, (await runGit(cwd, ['rev-parse', '--git-common-dir'])).trim()))
    if (await common(path) !== await common(repo)) throw new Error(`The worktree path belongs to another repository. Recovery files remain at ${dir}`)
    branch = (await runGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
  }
  return {
    branch,
    notice: `Restored branch ${branch}. Recovery files remain at ${dir}: ${recovery.changedFiles} uncommitted files, ${recovery.commits} commits not on the trunk. ` +
      'Numbered .patch files can be applied with git apply; .bundle files can be fetched with git fetch <bundle> HEAD:<branch>. snapshot.json names each repository. Submodule recovery is manual. These files are removed when this session is deleted for good.',
  }
}
