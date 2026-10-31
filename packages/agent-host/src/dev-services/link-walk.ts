import { errnoCode } from '../os/errors.js'
import { lstatSync, readdirSync, readlinkSync, type Dirent } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { win32 } from 'node:path'

/**
 * Where the links along a Windows path lead, judged before anything follows them (#849).
 *
 * A local link can lead to another machine: `shot.png -> \\host\share\x.png`, or a folder link earlier in the path.
 * `realpath`, `stat` and `open` follow it, and following it is already the connection: Windows opens the share over SMB
 * and offers that machine the person's sign-in. So the path is walked from its drive, one name at a time, and what each
 * name is comes from its folder's listing: libuv lists every reparse point as a link, while `lstat` follows one whose
 * target it cannot read (a junction to `\??\Volume{…}\…`). A link's target is read with `readlink` and followed by hand
 * only if `localLinkTarget` takes it. A junction never leads to a share (Windows refuses to follow a mount point to a
 * remote target, measured on Windows 11), but a symlink does, and so does a chain of local links ending in one.
 *
 * Used by a reply's image (`message-image.ts`) and by the project path guard (`path-guard.ts`) before either follows a
 * link. Windows only: elsewhere a path names nothing on another machine unless a mount the person made puts it there.
 *
 * A short name (`RUNNER~1`, how Windows hands out a temp folder, and how a link's target may be written) is not in its
 * folder's listing: it is matched to the entry it names by file identity (`shortNameEntry`), asked of `lstat`, which
 * never follows a link it can read. It used to be refused, which refused every link under a temp folder reached by its
 * short name (CI's Windows runner, review of #1072).
 *
 * This fails closed: a link whose target cannot be read, a folder that cannot be listed, a name its folder's listing
 * does not hold and that names no entry of it (a trailing dot or space, a stream) and more than MAX_LINK_HOPS links
 * are all refused. A name that is simply not there is not: whatever follows the walk then stops at it, reaching
 * nothing.
 */
export type LinkWalk = { ok: true } | { ok: false; reason: 'elsewhere' | 'unchecked'; why: string }

/** A Windows path on a drive letter: the only kind the walk takes */
export const DRIVE_PATH = /^[A-Za-z]:[\\/]/

/** Links followed before the walk gives up, and the path is refused rather than left to realpath */
const MAX_LINK_HOPS = 64

/**
 * Whether the walk may follow a link with this target (as `readlink` gives it) by hand: a path on a drive letter, or
 * one relative to the link's folder. Everything else is refused, not resolved: `\\server\share`, `\\?\…`, `\??\…`, and
 * the NT spellings of a share (`\Device\Mup\…`, `\GLOBAL??\UNC\…`, `\DosDevices\UNC\…`), which `win32.resolve` reads
 * as a folder on the current drive that does not exist, while the system follows them to the network. A target
 * starting with one separator, one relative to a drive's current folder (`C:a.png`) and one with a stream in it are
 * refused with them: none says plainly where it leads.
 */
export function localLinkTarget(target: string): boolean {
  if (DRIVE_PATH.test(target)) return !target.slice(2).includes(':')
  return target !== '' && !/^[\\/]/.test(target) && !target.includes(':')
}

/**
 * The share a path is on, as its root (`\\host\share\`), or undefined for any other path: a drive path, and the device
 * spellings `\\?\…` and `\\.\…`. A project opened from a share (on purpose, a mapped drive whose real path is the share,
 * `\\wsl.localhost\…`) is walked on that share: its own links stay there.
 */
export function shareRoot(path: string): string | undefined {
  const m = SHARE.exec(path)
  return m ? `\\\\${m[1]}\\${m[2]}\\` : undefined
}

/** `\\host\share`, either slash; not `\\?\…` or `\\.\…`, whose first name is not a host */
const SHARE = /^[\\/]{2}([^\\/?.][^\\/]*)[\\/]([^\\/]+)(?:[\\/]|$)/

/**
 * Whether `path` is on the share `home` (`shareRoot`), compared without regard to case as Windows compares host and
 * share names. A path on another host or another share of the same host is not, and neither is a stream on it.
 */
function onShare(path: string, home: string | undefined): boolean {
  if (home === undefined) return false
  const root = shareRoot(path)
  return root !== undefined && root.toLowerCase() === home.toLowerCase() && !path.slice(2).includes(':')
}

/** What the walk asks of the file system; answered by `walkLinks` (async) or `walkLinksSync` */
type Ask = { list: string } | { readlink: string } | { identity: string }
/** A failed answer: the error's code */
type Failed = { failed: string | undefined }
/** A file's identity, as `lstat` gives it (bigint: an NTFS file id is above 2^53, path-guard.ts) */
type Identity = { dev: bigint; ino: bigint }
type Answer = Dirent[] | string | Identity | Failed

const isIdentity = (a: Answer): a is Identity => typeof a === 'object' && !Array.isArray(a) && 'ino' in a
const isFailed = (a: Answer): a is Failed => typeof a === 'object' && !Array.isArray(a) && 'failed' in a

/** Entries a short name is looked for among, before the walk gives up and refuses it */
const MAX_SHORT_NAME_SCAN = 10_000

/**
 * The entry of `listed` (the listing of `folder`) that the short name `part` names, by file identity: `lstat` of the
 * short name against `lstat` of each entry. Entries whose name starts with the short name's first letter are asked
 * first (Windows makes a short name from the long one's first letters). Null when none is, or `part` names nothing.
 */
function* shortNameEntry(folder: string, part: string, listed: Dirent[]): Generator<Ask, Dirent | null, Answer> {
  const self = yield { identity: win32.join(folder, part) }
  if (!isIdentity(self)) return null
  const { dev, ino } = self
  const first = part.charAt(0).toLowerCase()
  const likely = (e: Dirent) => (e.name.replace(/^[. ]+/, '')[0]?.toLowerCase() === first ? 0 : 1)
  const order = [...listed].sort((a, b) => likely(a) - likely(b)).slice(0, MAX_SHORT_NAME_SCAN)
  for (const e of order) {
    const other = yield { identity: win32.join(folder, e.name) }
    if (isIdentity(other) && other.ino === ino && other.dev === dev) return e
  }
  return null
}

function* walkSteps(abs: string, home: string | undefined): Generator<Ask, LinkWalk, Answer> {
  let path = abs
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
    const { root } = win32.parse(path)
    if (!DRIVE_PATH.test(root) && !onShare(path, home)) return { ok: false, reason: 'elsewhere', why: path }
    const parts = path.slice(root.length).split(/[\\/]+/).filter(Boolean)
    let current = root
    let next: string | null = null
    for (const [i, part] of parts.entries()) {
      const listed = yield { list: current }
      if (!Array.isArray(listed)) {
        const code = isFailed(listed) ? listed.failed : undefined
        if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true }
        return { ok: false, reason: 'unchecked', why: `${current} cannot be listed (${code})` }
      }
      // The name on disk: Windows names ignore case, and a folder that does not may hold both spellings
      let entry = listed.find((e) => e.name === part) ?? listed.find((e) => e.name.toLowerCase() === part.toLowerCase())
      // A short name: the entry it names, whatever that is (a link is then judged as one)
      if (!entry && part.includes('~') && !/[:]|[. ]$/.test(part)) entry = (yield* shortNameEntry(current, part, listed)) ?? undefined
      if (!entry) {
        // A name Windows trims (a trailing dot or space), a stream, or a short name that matched no entry names
        // something the listing spells otherwise
        if (/[~:]|[. ]$/.test(part)) return { ok: false, reason: 'unchecked', why: `${win32.join(current, part)} is not a name in its folder` }
        return { ok: true }
      }
      const candidate = win32.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        const target = yield { readlink: candidate }
        if (typeof target !== 'string') return { ok: false, reason: 'unchecked', why: `the target of ${candidate} cannot be read` }
        if (!localLinkTarget(target) && !onShare(target, home)) return { ok: false, reason: 'elsewhere', why: target }
        next = win32.resolve(current, target, ...parts.slice(i + 1))
        break
      }
      current = candidate
    }
    if (next === null) return { ok: true }
    path = next
  }
  return { ok: false, reason: 'unchecked', why: `more than ${MAX_LINK_HOPS} links lead from ${abs}` }
}

const failed = (e: unknown): Failed => ({ failed: errnoCode(e) })

/**
 * `home`: the share the walk may start on and links may lead to (`shareRoot` of a project's real path), when the
 * project is on one. Every other share stays refused: a link leading off the project's own share to another host or
 * another share is the connection this walk exists to refuse.
 */
export async function walkLinks(abs: string, home?: string): Promise<LinkWalk> {
  const steps = walkSteps(abs, home)
  let step = steps.next()
  while (!step.done) {
    const ask = step.value
    const answer: Answer = await ('list' in ask
      ? readdir(ask.list, { withFileTypes: true })
      : 'readlink' in ask
        ? readlink(ask.readlink)
        : lstat(ask.identity, { bigint: true }).then(({ dev, ino }) => ({ dev, ino }))
    ).catch(failed)
    step = steps.next(answer)
  }
  return step.value
}

export function walkLinksSync(abs: string, home?: string): LinkWalk {
  const steps = walkSteps(abs, home)
  let step = steps.next()
  while (!step.done) {
    const ask = step.value
    let answer: Answer
    try {
      if ('list' in ask) answer = readdirSync(ask.list, { withFileTypes: true })
      else if ('readlink' in ask) answer = readlinkSync(ask.readlink)
      else {
        const { dev, ino } = lstatSync(ask.identity, { bigint: true })
        answer = { dev, ino }
      }
    } catch (e) {
      answer = failed(e)
    }
    step = steps.next(answer)
  }
  return step.value
}
