// The temporary worktrees `pnpm pre-pr` checks commits in (scripts/pre-pr.mjs), their dependency links, and taking them away
// again without reaching through a link into the checkout's own node_modules.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' }

export function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })
}

/**
 * A path as the file system names it: links followed, and on Windows the 8.3 short names
 * (`RUNNER~1`) written out. tsc compares files by the path it reached them by, so one folder reached by two
 * spellings (a temporary folder named in its short form, and a link's target in its long form) is two
 * folders and one class has two declarations (#1254). A path that does not exist is answered as it is.
 */
export function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}
/** The folders named node_modules in a checkout: its root's and each workspace package's (two levels down). */
export function nodeModulesDirs(root) {
  const found = []
  const walk = (rel, depth) => {
    if (existsSync(join(root, rel, 'node_modules'))) found.push(rel ? `${rel}/node_modules` : 'node_modules')
    if (depth === 2) return
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(rel ? `${rel}/${e.name}` : e.name, depth + 1)
    }
  }
  walk('', 0)
  return found
}

/** A link to a folder: a junction on Windows (no privilege needed), a symbolic link elsewhere */
const FOLDER_LINK = process.platform === 'win32' ? 'junction' : 'dir'

/**
 * Gives a worktree the checkout's installed dependencies without installing (#1254): each node_modules
 * folder of the checkout (see {@link nodeModulesDirs}) is mirrored as a real folder of links, and a link
 * that leads to a package of the workspace points at that package in the worktree, not in the checkout.
 * Linking the folder itself, as this once did, made tsc follow `@cc/platform` back to the checkout's
 * sources while the worktree's own files stayed where they are: one class with two declarations, and
 * `Types have separate declarations of a private property`. Any other link (pnpm's store, a plain
 * folder) points at what it is in the checkout; plain files (pnpm's state) are not given. A folder of the
 * checkout that the worktree has no place for is left out, as is a workspace package the worktree lacks.
 * Running it again over what is there (after the links were taken away) fills in what is missing.
 * Answers how many folders were mirrored. removeWorktree takes every link away before the worktree goes.
 */
export function mirrorModules(root, worktree, folders = nodeModulesDirs(root)) {
  // Every path below is the file system's own spelling of it, whatever way the caller named the folders (canonical)
  const rootReal = canonical(root)
  const dir = canonical(worktree)
  const inWorkspace = (target) => {
    const rel = relative(rootReal, target)
    return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !rel.split(sep).includes('node_modules') ? rel : null
  }
  const link = (target, path) => {
    let st
    try {
      st = statSync(target)
    } catch {
      return // dangling: nothing to give
    }
    // A junction cannot lead to a file (on Windows it is made without a word, and reads as nothing): a copy does
    if (st.isDirectory()) symlinkSync(target, path, FOLDER_LINK)
    else if (st.isFile()) copyFileSync(target, path)
  }
  const mirror = (src, dst) => {
    mkdirSync(dst, { recursive: true })
    for (const e of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, e.name)
      const d = join(dst, e.name)
      const isLink = lstatSync(s).isSymbolicLink()
      // A scope (@cc, @types) holds links of its own, which may be workspace packages
      if (!isLink && e.isDirectory() && e.name.startsWith('@')) {
        mirror(s, d)
        continue
      }
      // What is there already stays: prepare runs again after the links were taken away (the revert check),
      // which leaves these folders, and their scopes, as real and empty ones
      if (lstatSync(d, { throwIfNoEntry: false })) continue
      if (isLink) {
        let target
        try {
          target = realpathSync.native(s)
        } catch {
          continue
        }
        const rel = inWorkspace(target)
        if (!rel) link(target, d)
        else if (existsSync(join(dir, rel))) link(join(dir, rel), d)
      } else if (e.isDirectory()) link(s, d)
      // A plain file is pnpm's state (.modules.yaml, naming the checkout's store): not copied, since a
      // pnpm install into the worktree would trust it and tsc, vitest and dependency-cruiser do not read it
    }
  }
  let n = 0
  for (const rel of folders) {
    const at = join(dir, rel)
    if (!existsSync(dirname(at))) continue
    mirror(join(rootReal, rel), at)
    n++
  }
  return n
}
/** Every run keeps its worktrees in one folder of the temporary folder, named after the run. */
export const RUN_PREFIX = 'cc-pre-pr-'
export const runDir = (id) => join(canonical(tmpdir()), `${RUN_PREFIX}${id}`)

/**
 * Removes every link (a symlink, or a junction on Windows) under `dir` down to `depth` levels,
 * without ever following one. The dependency links a worktree gets lead into the checkout's own
 * node_modules: a recursive delete that followed one would empty the checkout's dependencies. The
 * default reaches the deepest of them: packages/ui/node_modules/@cc/core, five levels down (see
 * {@link mirrorModules}). A `.pnpm` folder is a real one only where pnpm installed into the worktree,
 * and its links lead inside it: they are left to the removal of the folder.
 */
export function unlinkLinks(dir, depth = 5) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let n = 0
  for (const e of entries) {
    const p = join(dir, e.name)
    let st
    try {
      st = lstatSync(p)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      unlinkSync(p)
      n++
    } else if (st.isDirectory() && depth > 1 && e.name !== '.git' && e.name !== '.pnpm') {
      n += unlinkLinks(p, depth - 1)
    }
  }
  return n
}

/** Takes one worktree of a run away, links first. Answers what went wrong, or null. */
export function removeWorktree(wt, root) {
  try {
    unlinkLinks(wt)
    // A second look finds nothing, or nothing is removed: never a recursive delete with a link inside
    if (unlinkLinks(wt) !== 0) throw new Error('a link came back')
  } catch (err) {
    return `${wt}: its dependency links could not be removed (${err.message}); remove the links, then the folder`
  }
  try {
    git(root, ['worktree', 'remove', '--force', wt])
  } catch {
    rmSync(wt, { recursive: true, force: true })
  }
  return null
}

/**
 * Takes a run's folder away: the links in each worktree first, then the worktree (through git, so
 * the checkout forgets it), then the folder. Safe on a run that died halfway: it reads nothing but
 * the folder. Answers what it could not remove.
 */
export function removeRun(dir, root) {
  const left = []
  if (!existsSync(dir)) return left
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('wt-')) continue
    const problem = removeWorktree(join(dir, e.name), root)
    if (problem) left.push(problem)
  }
  if (!left.length) rmSync(dir, { recursive: true, force: true })
  try {
    git(root, ['worktree', 'prune'])
  } catch {
    // the checkout may be gone; nothing of it to forget then
  }
  return left
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** Removes the folders of earlier runs on this checkout whose process is gone (killed, or the machine slept through a timeout). */
export function sweepStale(root, { isAlive = alive } = {}) {
  const swept = []
  const temp = canonical(tmpdir())
  for (const name of readdirSync(temp)) {
    if (!name.startsWith(RUN_PREFIX)) continue
    const dir = join(temp, name)
    let owner
    try {
      owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8'))
    } catch {
      continue
    }
    if (resolve(owner.root ?? '') !== resolve(root) || isAlive(owner.pid)) continue
    if (!removeRun(dir, root).length) swept.push(dir)
  }
  return swept
}