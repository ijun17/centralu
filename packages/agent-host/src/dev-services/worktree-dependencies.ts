import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { copyTree, dropEscapingLinks, prepareCopyTarget, resolveExisting } from './fs.js'
import { isMissingPathError } from './path-guard.js'

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']

/** Reuse installed JS dependencies without sharing writable files or running install scripts (#582). */
export async function prepareWorktreeDependencies(projectCwd: string, worktreeCwd: string): Promise<void> {
  // A child may fork from another branch: only reuse dependencies for the same lockfiles.
  let locked = false
  for (const name of LOCKFILES) {
    const target = await lstat(join(worktreeCwd, name)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (!target) continue
    const [source, destination] = await Promise.all([
      resolveExisting(projectCwd, name),
      resolveExisting(worktreeCwd, name),
    ])
    const [before, after] = await Promise.all([readFile(source), readFile(destination)])
    if (!before.equals(after)) return
    locked = true
  }
  if (!locked) return

  const copied: string[] = []
  const folders = ['']
  while (folders.length) {
    const folder = folders.pop()!
    const entries = await readdir(join(worktreeCwd, folder), { withFileTypes: true })
    // Walk the checkout, not ignored build output in the main repository, and never follow a link.
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
        folders.push(join(folder, entry.name))
      }
    }
    if (folder && !entries.some((e) => e.name === 'package.json' && e.isFile())) continue
    if (entries.some((e) => e.name === 'node_modules')) continue
    const rel = join(folder, 'node_modules')
    try {
      const src = await resolveExisting(projectCwd, rel)
      if (!(await lstat(src)).isDirectory()) continue
      // Workspace manifests may differ even when a branch forgot to update its lockfile.
      const manifest = join(folder, 'package.json')
      const [source, target] = await Promise.all([
        resolveExisting(projectCwd, manifest).then((p) => readFile(p)),
        resolveExisting(worktreeCwd, manifest).then((p) => readFile(p)),
      ])
      if (!source.equals(target)) continue
      const dst = await prepareCopyTarget(worktreeCwd, rel)
      copied.push(dst)
      await copyTree(src, dst)
    } catch (err) {
      if (!isMissingPathError(err)) console.error(`[worktree] dependencies skipped: ${rel} — ${(err as Error).message}`)
    }
  }
  // pnpm workspace links can point to a sibling package's node_modules: check after all copies land.
  for (const dst of copied) {
    const removed = await dropEscapingLinks(worktreeCwd, dst).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] // A copy may have failed before creating its destination.
      throw err
    })
    for (const gone of removed) {
      console.error(`[worktree] link dropped (points outside the worktree): ${gone}`)
    }
  }
}
