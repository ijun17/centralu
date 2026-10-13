import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isSessionId } from '@cc/protocol'
import { dataRoot } from '../data-dir.js'
import { runGit, type GitTrust } from './git-exec.js'
import { assertExistingPath } from './path-guard.js'

export type WorktreeRecovery = { snapshot: string; tip: string; changedFiles: number; commits: number }
type RepositorySnapshot = { path: string; tip: string; patch: boolean; staged: boolean; bundle: boolean; refs?: string[] }
type Snapshot = WorktreeRecovery & { repositories: RepositorySnapshot[] }

export const WORKTREE_RECOVERY_MAX_BYTES = 256 * 1024 * 1024
const RECOVERY_TIMEOUT = 120_000

export function worktreeRecoveryDir(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error('Invalid session id for worktree recovery')
  return join(dataRoot(), 'worktree-recovery', sessionId)
}

export async function clearWorktreeRecovery(sessionId: string): Promise<void> {
  await rm(worktreeRecoveryDir(sessionId), { recursive: true, force: true })
}

/** Read NUL records without imposing the subprocess stdout buffer limit on trees/history. */
async function* gitRecords(repo: string, args: string[], input?: string): AsyncGenerator<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cc-recovery-git-'))
  const file = join(dir, 'records')
  try {
    await runGit(repo, args, { outputFile: file, timeout: RECOVERY_TIMEOUT, input })
    let pending = ''
    for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
      pending += chunk
      let end: number
      while ((end = pending.indexOf('\0')) !== -1) {
        yield pending.slice(0, end)
        pending = pending.slice(end + 1)
      }
    }
    if (pending) yield pending
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Preflight every repository before any private index is populated or objects are written. */
export async function saveWorktreeRecovery(sessionId: string, cwd: string, trunk: string, branch?: string): Promise<WorktreeRecovery> {
  const plans: { repo: string; path: string; tip: string; refs: string[]; commits: number }[] = []
  let bytes = 0
  const account = (size: number) => {
    bytes += size
    if (bytes > WORKTREE_RECOVERY_MAX_BYTES) {
      throw new Error(`Worktree recovery exceeds the 256 MiB input limit (tracked and non-ignored untracked files plus staged changes, including submodules). No files were staged or removed; save the work elsewhere before deleting.`)
    }
  }
  const prepare = async (repo: string, path: string, gitlinks: string[] = []): Promise<void> => {
    const tip = (await runGit(repo, ['rev-parse', '--verify', 'HEAD'])).trim()
    const refs = ['HEAD']
    if (!path && branch) {
      const ref = `refs/heads/${branch}`
      if (await runGit(repo, ['rev-parse', '--verify', ref]).then(() => true).catch(() => false)) refs.push(ref)
    } else if (path) {
      // Removing the worktree also removes its private module repository. Preserve every local
      // branch plus detached HEAD when their commits are absent from that module's remotes.
      refs.push(...(await runGit(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).trim().split('\n').filter(Boolean))
      // A superproject can name module objects this checkout never fetched. They cannot be
      // lost here, and must not make rev-list or bundle creation refuse the deletion.
      if (gitlinks.length) {
        const available = await runGit(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
          input: gitlinks.map((oid) => `${oid}^{commit}`).join('\n') + '\n', timeout: RECOVERY_TIMEOUT,
          // Older Git ignores the lazy-fetch switch; disallow transports there too.
          env: { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
        })
        for (const row of available.trim().split('\n')) {
          const [oid, type] = row.split(' ')
          if (type === 'commit') refs.push(oid!)
        }
      }
    }
    const baselineOid = !path
      ? await runGit(repo, ['rev-parse', '--verify', `${trunk}^{commit}`]).then((s) => s.trim()).catch(() => null)
      : null
    const exclude = path
      ? (await runGit(repo, ['for-each-ref', '--format=^%(objectname)', 'refs/remotes/'])).trim().split('\n').filter(Boolean)
      : baselineOid ? [`^${baselineOid}`] : []
    // Keep both positive and negative revisions on stdin: --not on the command line
    // does not affect stdin revisions, and large module histories exceed Windows argv limits.
    const revisions = [...refs, ...exclude].join('\n') + '\n'
    const commits = Number((await runGit(repo, ['rev-list', '--count', '--stdin'], { input: revisions, timeout: RECOVERY_TIMEOUT })).trim())
    plans.push({ repo, path, tip, refs, commits })
    const stagedNames = new Set((await runGit(repo, ['diff', '--cached', '--name-only', '-z', '--no-renames', tip], { timeout: RECOVERY_TIMEOUT })).split('\0'))
    const modules: string[] = []
    const moduleCommits = new Map<string, Set<string>>()
    const keepGitlink = (rel: string, oid: string) => {
      modules.push(rel)
      const tips = moduleCommits.get(rel) ?? new Set<string>()
      tips.add(oid)
      moduleCommits.set(rel, tips)
    }
    const manifests = new Set<string>()
    const keepManifest = (rel: string, oid: string) => {
      if (rel === '.gitmodules' && !/^0+$/.test(oid)) manifests.add(oid)
    }
    // Raw parent diffs include intermediate and merge-only gitlinks without a process per
    // commit. HEAD's tree also covers unchanged links and the no-unmerged-commits case.
    let change: RegExpMatchArray | null = null
    for await (const row of gitRecords(repo, ['log', '--raw', '-z', '--no-renames', '--ignore-submodules=none', '--no-abbrev', '--format=', '--root', '--diff-merges=separate', '--stdin'], revisions)) {
      if (change) {
        const [, oldMode, newMode, oldOid, newOid] = change
        if (oldMode === '160000') keepGitlink(row, oldOid!)
        if (newMode === '160000') keepGitlink(row, newOid!)
        keepManifest(row, oldOid!)
        keepManifest(row, newOid!)
        change = null
      } else change = row.match(/^\n*:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) [A-Z]$/)
    }
    for await (const row of gitRecords(repo, ['ls-tree', '-r', '-z', 'HEAD'])) {
      const tab = row.indexOf('\t')
      const [mode, , oid] = row.slice(0, tab).split(' ')
      const rel = row.slice(tab + 1)
      if (mode === '160000') keepGitlink(rel, oid!)
      keepManifest(rel, oid!)
    }
    const stagedObjects: string[] = []
    for await (const row of gitRecords(repo, ['ls-files', '--stage', '-z'])) {
      if (!row) continue
      const tab = row.indexOf('\t')
      const rel = row.slice(tab + 1)
      const oid = row.split(' ')[1]!
      if (row.startsWith('160000 ')) keepGitlink(rel, oid)
      else if (stagedNames.has(rel)) stagedObjects.push(oid)
      keepManifest(rel, oid)
    }
    // git mv keeps the module name while changing its path. Read each distinct manifest
    // once, and associate all historical paths of a name with the initialized checkout.
    const modulePaths = new Map<string, Set<string>>()
    for (const oid of manifests) {
      const config = await runGit(repo, ['config', '--blob', oid, '-z', '--get-regexp', '^submodule\\..*\\.path$'])
        .catch((e: { code?: number }) => { if (e.code === 1) return ''; throw e })
      for (const row of config.split('\0').filter(Boolean)) {
        const newline = row.indexOf('\n')
        const name = row.slice('submodule.'.length, newline - '.path'.length)
        const paths = modulePaths.get(name) ?? new Set<string>()
        paths.add(row.slice(newline + 1))
        modulePaths.set(name, paths)
      }
    }
    for (const paths of modulePaths.values()) {
      const tips = new Set([...paths].flatMap((rel) => [...(moduleCommits.get(rel) ?? [])]))
      for (const rel of paths) {
        modules.push(rel)
        moduleCommits.set(rel, new Set([...(moduleCommits.get(rel) ?? []), ...tips]))
      }
    }
    if (stagedObjects.length) {
      const sizes = await runGit(repo, ['cat-file', '--batch-check=%(objectsize)'], { input: stagedObjects.join('\n') + '\n' })
      for (const size of sizes.trim().split('\n')) {
        if (!/^\d+$/.test(size)) throw new Error('Could not measure staged recovery data')
        account(Number(size))
      }
    }
    const files = new Set((await runGit(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))
    for (const rel of files) {
      const file = await lstat(join(repo, rel)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e
        return null
      })
      if (file?.isFile() || file?.isSymbolicLink()) account(file.size)
      else if (file?.isDirectory() && existsSync(join(repo, rel, '.git'))) modules.push(rel)
    }
    for (const rel of new Set(modules)) {
      await assertExistingPath(repo, rel).catch((e) => {
        if (existsSync(join(repo, rel))) throw e
      })
      if (existsSync(join(repo, rel, '.git'))) await prepare(join(repo, rel), path ? `${path}/${rel}` : rel, [...(moduleCommits.get(rel) ?? [])])
    }
  }
  await prepare(cwd, '')
  const snapshotId = randomUUID()
  const dir = join(worktreeRecoveryDir(sessionId), snapshotId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const snapshot: Snapshot = { snapshot: snapshotId, tip: plans[0]!.tip, changedFiles: 0, commits: 0, repositories: [] }
  const patchFile = async (repo: string, tip: string, file: string, env?: Record<string, string>): Promise<boolean> => {
    // Git writes bytes directly. Decoding stdout as UTF-8 would corrupt CP949/Latin-1 patches,
    // and buffering stdout would fail on large diffs even within the measured input limit.
    await runGit(repo, ['diff', '--cached', '--binary', '--full-index', '--no-renames', `--output=${file}`, tip], { env, timeout: RECOVERY_TIMEOUT })
    await chmod(file, 0o600)
    if ((await stat(file)).size > 0) return true
    await rm(file)
    return false
  }
  try {
    for (const [n, plan] of plans.entries()) {
      const { repo, path, tip, refs, commits } = plan
      const entry: RepositorySnapshot = { path, tip, refs, patch: false, staged: false, bundle: commits > 0 }
      snapshot.repositories.push(entry)
      snapshot.commits += commits
      if (entry.bundle) {
        // Bundle headers only advertise named refs, not bare object ids. Temporary refs keep
        // gitlink-only commits fetchable after the private submodule repository is removed.
        const temporaryRefs: string[] = []
        const updates: string[] = []
        try {
          entry.refs = []
          for (const ref of refs) {
            if (ref === 'HEAD' || ref.startsWith('refs/')) entry.refs.push(ref)
            else {
              const name = `refs/centralu-recovery/${snapshotId}/gitlink-${temporaryRefs.length}`
              temporaryRefs.push(name)
              updates.push(`create ${name} ${ref}`)
              entry.refs.push(name)
            }
          }
          if (updates.length) await runGit(repo, ['update-ref', '--stdin'], { input: updates.join('\n') + '\n', timeout: RECOVERY_TIMEOUT })
          await runGit(repo, ['bundle', 'create', join(dir, `${n}.bundle`), '--stdin'], { input: entry.refs.join('\n') + '\n', timeout: RECOVERY_TIMEOUT })
        } finally {
          if (temporaryRefs.length) await runGit(repo, ['update-ref', '--stdin'], { input: temporaryRefs.map((ref) => `delete ${ref}`).join('\n') + '\n', timeout: RECOVERY_TIMEOUT })
        }
      }
      entry.staged = await patchFile(repo, tip, join(dir, `${n}.staged.patch`))
      const stagedNames = await runGit(repo, ['diff', '--cached', '--name-only', '-z', '--no-renames', tip], { timeout: RECOVERY_TIMEOUT })
      const env = { GIT_INDEX_FILE: join(dir, `${n}.index`) }
      try {
        await runGit(repo, ['read-tree', tip], { env })
        await runGit(repo, ['add', '-A', '--', '.'], { env, timeout: RECOVERY_TIMEOUT })
        const names = await runGit(repo, ['diff', '--cached', '--name-only', '-z', '--no-renames', tip], { env, timeout: RECOVERY_TIMEOUT })
        snapshot.changedFiles += new Set([...names.split('\0'), ...stagedNames.split('\0')].filter(Boolean)).size
        entry.patch = await patchFile(repo, tip, join(dir, `${n}.patch`), env)
      } finally {
        await rm(env.GIT_INDEX_FILE, { force: true })
      }
    }
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
  let extraNotice = ''
  if (root.bundle) {
    const heads = (await runGit(repo, ['bundle', 'list-heads', join(dir, '0.bundle')])).trim().split('\n')
    for (const row of heads) {
      const [tip, ref] = row.split(' ')
      if (!tip || !ref?.startsWith('refs/heads/') || tip === recovery.tip) continue
      const base = `recovered/${sessionId}-stored-branch`
      let recovered = base
      for (let suffix = 1; ; suffix++) {
        const existing = await runGit(repo, ['rev-parse', '--verify', `refs/heads/${recovered}`]).then((s) => s.trim()).catch(() => null)
        if (existing === tip) break
        if (!existing) {
          await runGit(repo, ['fetch', join(dir, '0.bundle'), `${ref}:refs/heads/${recovered}`], { allowRepoPrograms: trust.trusted === true })
          break
        }
        recovered = `${base}-${suffix}`
      }
      extraNotice += `Stored branch ${ref.slice('refs/heads/'.length)} recovered as ${recovered}. `
    }
  }
  if (!existsSync(path)) {
    await rm(join(dir, 'patches-applied'), { force: true })
    if (await runGit(repo, ['show-ref', '--verify', `refs/heads/${branch}`]).then(() => true).catch(() => false)) {
      branch = `recovered/${sessionId}`
    }
    if (root.bundle) await runGit(repo, ['fetch', join(dir, '0.bundle'), ...(root.refs ?? ['HEAD'])], { allowRepoPrograms: trust.trusted === true })
    await runGit(repo, ['worktree', 'add', '-b', branch, path, recovery.tip], { allowRepoPrograms: trust.trusted === true })
    if (root.patch || root.staged) {
      try {
        if (root.staged) await runGit(path, ['apply', '--cached', '--binary', join(dir, '0.staged.patch')])
        if (root.patch) await runGit(path, ['apply', '--binary', join(dir, '0.patch')])
        await writeFile(join(dir, 'patches-applied'), await realpath(path), { mode: 0o600 })
      } catch {
        return { branch, notice: `Restored branch ${branch}. ${extraNotice}Patches could not all be applied. Recovery files remain at ${dir}; apply numbered .patch files manually with git apply and .staged.patch files with git apply --cached.` }
      }
    }
  } else {
    // A retry can find the worktree created before the store restore failed. Read its actual
    // branch, including a recovery name chosen to avoid an occupied original branch.
    const common = async (cwd: string) => realpath(resolve(cwd, (await runGit(cwd, ['rev-parse', '--git-common-dir'])).trim()))
    if (await common(path) !== await common(repo)) throw new Error(`The worktree path belongs to another repository. Recovery files remain at ${dir}`)
    branch = (await runGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
    if (root.patch || root.staged) {
      const appliedTo = await readFile(join(dir, 'patches-applied'), 'utf8').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null
        throw e
      })
      extraNotice += appliedTo === await realpath(path)
        ? 'Saved patches were applied during the previous restore attempt; they were not reapplied on this retry. '
        : 'The worktree already existed; saved patches were not applied on this retry and may still need manual recovery. '
    }
  }
  return {
    branch,
    notice: `Restored branch ${branch}. ${extraNotice}Recovery files remain at ${dir}: ${recovery.changedFiles} uncommitted files, ${recovery.commits} commits absent from the trunk or submodule remotes. ` +
      'Numbered .patch files can be applied with git apply; .bundle files list their saved refs with git bundle list-heads and can be fetched with git fetch <bundle> <ref>:<branch>. snapshot.json names each repository and its refs. Submodule recovery is manual. These files are removed when this session is deleted for good.',
  }
}
