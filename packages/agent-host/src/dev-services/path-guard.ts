import { lstatSync, realpathSync, statSync, type BigIntStats, type Stats } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve, sep, win32, type PlatformPath } from 'node:path'
import { walkLinks, walkLinksSync, type LinkWalk } from './link-walk.js'

/** This OS's path rules */
const nativePath: PlatformPath = sep === '\\' ? win32 : posix
const windows = sep === '\\'

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

type WalkResult<S = Stats> = { readonly stats: S; readonly exists: true } | { readonly exists: false }

export function isMissingPathError(error: unknown): error is MissingPathError {
  return error instanceof MissingPathError
}

/**
 * The stats are bigint ones so that `dev` and `ino` can be compared as they are (#368). On NTFS a
 * file id is 64 bits and above 2^53, and as a Number two different files can come out equal: the
 * identity checks in fs.ts then let a swapped file through.
 */
export async function assertExistingPath(root: string, rel: string): Promise<BigIntStats> {
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

async function walkPath(root: string, rel: string, mode: WalkMode): Promise<WalkResult<BigIntStats>> {
  const rootReal = await realpath(root)
  let current = rootReal
  const parts = pathParts(root, rel)
  if (parts.length === 0) return { stats: await stat(rootReal, { bigint: true }), exists: true }

  for (const [index, part] of parts.entries()) {
    if (part === '..') {
      current = checkedParent(rootReal, current)
      continue
    }

    const candidate = join(current, part)
    assertInside(rootReal, candidate)
    let stats: BigIntStats
    try {
      const linkStats = await lstat(candidate, { bigint: true })
      if (linkStats.isSymbolicLink()) {
        if (windows) offMachine(await walkLinks(candidate))
        const target = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
          if (isMissingFsPath(error)) throw new MissingPathError(rel)
          throw error
        })
        assertInside(rootReal, target)
        stats = await stat(target, { bigint: true })
        current = target
      } else {
        stats = linkStats
        current = windows ? realInside(rootReal, await realpath(candidate)) : candidate
      }
    } catch (error) {
      if (isMissingFsPath(error) && mode === 'create-leaf' && index === parts.length - 1) return { exists: false }
      if (isMissingFsPath(error)) throw new MissingPathError(rel)
      throw error
    }
    if (index < parts.length - 1 && !stats.isDirectory()) throw new UnsafePathError(`${rel || '.'} is not a folder`)
    if (index === parts.length - 1) return { stats, exists: true }
  }

  return { stats: await stat(current, { bigint: true }), exists: true }
}

function walkPathSync(root: string, rel: string, mode: WalkMode): WalkResult {
  // .native, as the async walk's realpath is (#849): the JS one keeps a Windows short name (`RUNNER~1`) as given, while a
  // link's target comes back in full, so every link under a root spelled short was refused as leaving it
  const rootReal = realpathSync.native(root)
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
        if (windows) offMachine(walkLinksSync(candidate))
        const target = realpathSync.native(candidate)
        assertInside(rootReal, target)
        stats = statSync(target)
        current = target
      } else {
        stats = linkStats
        current = windows ? realInside(rootReal, realpathSync.native(candidate)) : candidate
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
 *
 * **Windows (#14):** `relative()` returns an *absolute* path when the target is on another drive
 * or a UNC share (`D:\secret`, `\\evil\share\x`), and that split into segments (`D:`, `secret`)
 * that were then walked *inside* the root. A drive path still failed, since `root\D:` never
 * exists, but a UNC path passed if matching folders existed in the project. Every caller hands in
 * a checked or constant path today, so this is hardening: such a path is refused here, by name.
 * `p` is the path module, a parameter only so the Windows rules can be tested on any OS.
 */
export function pathParts(root: string, rel: string, p: PlatformPath = nativePath): readonly string[] {
  const rootResolved = p.resolve(root)
  const path = p.relative(rootResolved, p.resolve(rootResolved, rel || '.'))
  if (p.isAbsolute(path)) throw new UnsafePathError('Path is outside the project')
  const separator = p.sep === '\\' ? /[/\\]+/ : '/'
  return path.split(separator).filter((part) => part.length > 0 && part !== '.')
}

/**
 * Whether `candidate` is `root` or lies inside it, judged by segment (#428): `/a/wt-old` is not inside `/a/wt`, and a
 * name that only starts with two dots (`..cache`) is. On Windows `relative()` compares without regard to case, and
 * answers an absolute path for another drive or a UNC share, which is outside. Both are taken as given: canonicalize
 * them first (`canonicalPath`) wherever a link, a short name or a symlinked root could make one path look like two.
 * The one test of "inside" for the host; it used to be written nine times, with three ways to canonicalize.
 */
export function isInside(root: string, candidate: string, p: PlatformPath = nativePath): boolean {
  const rel = p.relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel))
}

/**
 * A path resolved through the nearest folder that exists, so a folder not made yet still compares with its parent's
 * real path. `realpathSync.native` gives the real spelling: the long name for a Windows short one (`RUNNER~1`) and the
 * case on disk on a case-insensitive volume, where the JS `realpathSync` keeps the spelling it was given.
 */
export function canonicalPath(path: string): string {
  const full = resolve(path)
  try {
    return realpathSync.native(full)
  } catch {
    const parent = dirname(full)
    return parent === full ? full : join(canonicalPath(parent), basename(full))
  }
}

function checkedParent(rootReal: string, current: string): string {
  const parent = dirname(current)
  assertInside(rootReal, parent)
  return parent
}

function assertInside(rootReal: string, candidate: string): void {
  if (!isInside(rootReal, candidate)) throw new UnsafePathError('Path is outside the project')
}

/**
 * Windows: where an entry `lstat` did not call a link really is, which has to be inside the project as well. libuv
 * calls a reparse point a link only when it can read the target, and `lstat` follows any other: a junction to a volume
 * path (`\\?\Volume{…}\outside`), which anyone can make without a privilege, came back as a plain folder, and the walk
 * went on inside it as if it were in the project while every call after the guard went where it leads. Measured on
 * Windows 11 (#849 follow-up): the file tree listed the outside folder and a dropped file was written there. A junction
 * never leads off the machine (Windows does not follow a mount point to a share), so this realpath connects nowhere.
 */
function realInside(rootReal: string, real: string): string {
  assertInside(rootReal, real)
  return real
}

/**
 * Windows: refuses a link before anything follows it, when it or a link after it leads to another machine
 * (`docs -> \\host\share`, or a chain of local links ending in one), or when where it leads cannot be checked
 * (`link-walk.ts`). `realpath` followed it to see whether it stayed inside, and following it is already the
 * connection: Windows opens the share over SMB and offers that machine the person's sign-in, so a repository could
 * plant one for the file tree to open. Measured on Windows 11 (#849 follow-up): realpath answered the share's path,
 * about a second later, before the guard refused it as outside the project.
 */
function offMachine(walk: LinkWalk): void {
  if (walk.ok) return
  throw new UnsafePathError(walk.reason === 'elsewhere' ? `Path leads off this machine (${walk.why})` : `Path cannot be checked: ${walk.why}`)
}

function isMissingFsPath(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
