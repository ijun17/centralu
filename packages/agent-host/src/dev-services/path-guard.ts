import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class UnsafePathError extends Error {
  override readonly name = 'UnsafePathError'
  readonly code = 'internal'

  constructor(message: string) {
    super(message)
  }
}

export class MissingPathError extends Error {
  override readonly name = 'MissingPathError'
  readonly code = 'internal'

  constructor(readonly rel: string) {
    super(`${rel || '.'} is no longer there`)
  }
}

export type CreatePathState = { readonly exists: boolean }

type WalkMode = 'existing' | 'create-leaf'

type WalkResult = { readonly stats: Stats; readonly exists: true } | { readonly exists: false }

export function isMissingPathError(error: unknown): error is MissingPathError {
  return error instanceof MissingPathError
}

export async function assertExistingPath(root: string, rel: string): Promise<Stats> {
  const result = await walkPath(root, rel, 'existing')
  if (!result.exists) throw new MissingPathError(rel)
  return result.stats
}

export async function assertCreatePath(root: string, rel: string): Promise<CreatePathState> {
  const result = await walkPath(root, rel, 'create-leaf')
  return { exists: result.exists }
}

export function assertExistingPathSync(root: string, rel: string): Stats {
  const result = walkPathSync(root, rel, 'existing')
  if (!result.exists) throw new MissingPathError(rel)
  return result.stats
}

async function walkPath(root: string, rel: string, mode: WalkMode): Promise<WalkResult> {
  const rootReal = await realpath(root)
  let current = rootReal
  const parts = pathParts(root, rel)
  if (parts.length === 0) return { stats: await stat(rootReal), exists: true }

  for (const [index, part] of parts.entries()) {
    if (part === '..') {
      current = checkedParent(rootReal, current)
      continue
    }

    const candidate = join(current, part)
    assertInside(rootReal, candidate)
    let stats: Stats
    try {
      const linkStats = await lstat(candidate)
      if (linkStats.isSymbolicLink()) {
        const target = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
          if (isMissingFsPath(error)) throw new MissingPathError(rel)
          throw error
        })
        assertInside(rootReal, target)
        stats = await stat(target)
        current = target
      } else {
        stats = linkStats
        current = candidate
      }
    } catch (error) {
      if (isMissingFsPath(error) && mode === 'create-leaf' && index === parts.length - 1) return { exists: false }
      if (isMissingFsPath(error)) throw new MissingPathError(rel)
      throw error
    }
    if (index < parts.length - 1 && !stats.isDirectory()) throw new UnsafePathError(`${rel || '.'} is not a folder`)
    if (index === parts.length - 1) return { stats, exists: true }
  }

  return { stats: await stat(current), exists: true }
}

function walkPathSync(root: string, rel: string, mode: WalkMode): WalkResult {
  const rootReal = realpathSync(root)
  let current = rootReal
  const parts = pathParts(root, rel)
  if (parts.length === 0) return { stats: statSync(rootReal), exists: true }

  for (const [index, part] of parts.entries()) {
    if (part === '..') {
      current = checkedParent(rootReal, current)
      continue
    }

    const candidate = join(current, part)
    assertInside(rootReal, candidate)
    let stats: Stats
    try {
      const linkStats = lstatSync(candidate)
      if (linkStats.isSymbolicLink()) {
        const target = realpathSync(candidate)
        assertInside(rootReal, target)
        stats = statSync(target)
        current = target
      } else {
        stats = linkStats
        current = candidate
      }
    } catch (error) {
      if (isMissingFsPath(error) && mode === 'create-leaf' && index === parts.length - 1) return { exists: false }
      if (isMissingFsPath(error)) throw new MissingPathError(rel)
      throw error
    }
    if (index < parts.length - 1 && !stats.isDirectory()) throw new UnsafePathError(`${rel || '.'} is not a folder`)
    if (index === parts.length - 1) return { stats, exists: true }
  }

  return { stats: statSync(current), exists: true }
}

/**
 * The segments to walk. **`..` is folded first — that is the whole point of this function.**
 *
 * This used to fold only for an absolute path, and split a relative path exactly as given. So
 * `..` was left as a segment, and the walk climbed to the parent **after** following a symlink
 * along the way. Meanwhile, the path the real syscall uses is built by `safeJoin` folding it
 * **first** with `resolve()`. When a link's target sits deeper than the link itself, the two paths
 * diverge: the guard looks inside and lets it through, while the syscall went outside.
 *
 *   root/link -> root/sub/deep      the link's target sits deeper than the link itself
 *   root/sub/evil/                  the bait the guard ends up walking
 *   root/evil -> /wherever          where it actually opens
 *
 * Given `link/../evil`, the guard checked `root/sub/evil` and allowed it, while `safeJoin`
 * returned `root/evil`. Measured, this made it possible to list a directory outside the project,
 * create a file at an arbitrary location, exfiltrate a project file, and watch an outside
 * directory.
 *
 * So the rule is pinned down in one line: **the string that is checked has to be the string that
 * is used.** That is why the same `resolve()` as `safeJoin` is used here.
 *
 * Even after folding, `..` can remain — a path leaving the root (`../outside`) is one such case,
 * and the walking side's `checkedParent` rejects it at that point.
 */
function pathParts(root: string, rel: string): readonly string[] {
  const rootResolved = resolve(root)
  const path = relative(rootResolved, resolve(rootResolved, rel || '.'))
  const separator = process.platform === 'win32' ? /[/\\]+/ : '/'
  return path.split(separator).filter((part) => part.length > 0 && part !== '.')
}

function checkedParent(rootReal: string, current: string): string {
  const parent = dirname(current)
  assertInside(rootReal, parent)
  return parent
}

function assertInside(rootReal: string, candidate: string): void {
  const rel = relative(rootReal, candidate)
  if (rel === '') return
  if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return
  throw new UnsafePathError('Path is outside the project')
}

function isMissingFsPath(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
