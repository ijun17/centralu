import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
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

/**
 * Removal in two steps, so a purge never leaves a trash entry without the files it needs (#647). `stage` moves the
 * session's recovery folder aside before the rows go: it fails where a removal would (a file held open on
 * Windows), and the entry stays retryable. Once the rows are gone, `commit` deletes the moved folder; when the
 * database step fails, `abort` puts it back under its own name, where a restore finds it again.
 */
export async function stageWorktreeRecoveryRemoval(sessionId: string): Promise<{ commit: () => Promise<void>; abort: () => Promise<void> }> {
  const dir = worktreeRecoveryDir(sessionId)
  if (!existsSync(dir)) return { commit: async () => {}, abort: async () => {} }
  const staged = `${dir}${PURGING}${randomUUID()}`
  await rename(dir, staged)
  return {
    commit: () => rm(staged, { recursive: true, force: true, maxRetries: 3 }),
    abort: () => rename(staged, dir),
  }
}

const PURGING = '.purging-'

/**
 * Finishes what a purge interrupted by a crash left (#647): a folder moved aside goes back under its session's name
 * while that session is still in the trash (its snapshots join any made since), and is deleted once the entry is gone.
 * Run at startup, when no purge is under way.
 */
export async function repairWorktreeRecoveryRemovals(trashed: (sessionId: string) => boolean): Promise<void> {
  const root = join(dataRoot(), 'worktree-recovery')
  if (!existsSync(root)) return
  for (const name of await readdir(root)) {
    const at = name.indexOf(PURGING)
    if (at === -1) continue
    const sessionId = name.slice(0, at)
    if (!isSessionId(sessionId)) continue
    const staged = join(root, name)
    // One folder that cannot be touched (a file held open on Windows) is left for the next start; the rest go on
    try {
      if (!trashed(sessionId)) {
        await rm(staged, { recursive: true, force: true, maxRetries: 3 })
        continue
      }
      const dir = join(root, sessionId)
      if (!existsSync(dir)) {
        await rename(staged, dir)
        continue
      }
      for (const snapshot of await readdir(staged)) {
        if (!existsSync(join(dir, snapshot))) await rename(join(staged, snapshot), join(dir, snapshot))
      }
      await rm(staged, { recursive: true, force: true, maxRetries: 3 })
    } catch (e) {
      console.error(`[trash] recovery folder ${name} left by an interrupted purge was not repaired, retried at the next start: ${(e as Error).message}`)
    }
  }
}

const MARK = 'refs/centralu/recovered/'

/**
 * Drops the mark restore left on a recovery branch (#647), together with the branch itself: a mark outliving its
 * branch would keep the saved commits reachable for good. Nothing to drop for a branch restore did not name.
 */
export async function clearRecoveredBranchMark(repo: string, branch: string): Promise<void> {
  if (!branch.startsWith('recovered/')) return
  await runGit(repo, ['update-ref', '-d', `${MARK}${branch}`])
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
    /*
     * An occupied original name is left alone, whoever made it. A recovery name is taken over when it is free, or when
     * this code made it (#647): `git worktree add -b` creates the branch before the folder, so a failed attempt leaves
     * the branch behind, and a retry must find its own leftover reusable rather than fail on it forever. The mark is a
     * ref under `refs/centralu/recovered/`; the mark and the branch are created together, both with the same one-time
     * reflog message. Deleting a branch deletes its reflog, so a branch the person deletes and makes again at the
     * same commit has no such entry: it is the person's, and a numbered name is used instead, so a later cleanup
     * never deletes a branch the person made.
     */
    const tipOf = (ref: string) => runGit(repo, ['rev-parse', '--verify', ref]).then((s) => s.trim()).catch(() => null)
    // The oldest reflog entry: the one written when the ref was created
    const createdBy = (ref: string) => runGit(repo, ['log', '-g', '--format=%gs', ref, '--']).then((s) => s.trim().split('\n').at(-1) ?? '').catch(() => '')
    const ours = async (name: string): Promise<boolean | null> => {
      const existing = await tipOf(`refs/heads/${name}`)
      if (!existing) return null
      if (existing !== recovery.tip || (await tipOf(`${MARK}${name}`)) !== recovery.tip) return false
      const made = await createdBy(`${MARK}${name}`)
      if (!made.startsWith('centralu recovery ') || made !== await createdBy(`refs/heads/${name}`)) return false
      return (await runGit(repo, ['for-each-ref', '--format=%(worktreepath)', `refs/heads/${name}`])).trim() === ''
    }
    let create = true
    if (await tipOf(`refs/heads/${branch}`)) {
      const base = `recovered/${sessionId}`
      branch = base
      for (let suffix = 1; ; suffix++) {
        const state = await ours(branch)
        if (state !== false) {
          create = state === null
          break
        }
        branch = `${base}-${suffix}`
      }
    }
    if (root.bundle) await runGit(repo, ['fetch', join(dir, '0.bundle'), ...(root.refs ?? ['HEAD'])], { allowRepoPrograms: trust.trusted === true })
    if (create && branch.startsWith('recovered/')) {
      const made = `centralu recovery ${randomUUID()}`
      await runGit(repo, ['update-ref', '--create-reflog', '-m', made, `${MARK}${branch}`, recovery.tip])
      // Created here rather than by `worktree add -b`, so its reflog carries the same message as the mark
      await runGit(repo, ['update-ref', '--create-reflog', '-m', made, `refs/heads/${branch}`, recovery.tip, ''])
      create = false
    }
    await runGit(repo, ['worktree', 'add', ...(create ? ['-b', branch, path, recovery.tip] : [path, branch])], { allowRepoPrograms: trust.trusted === true })
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
