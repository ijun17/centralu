import { readdirSync, readlinkSync, type Dirent } from 'node:fs'
import { readdir, readlink } from 'node:fs/promises'
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
 * This fails closed: a link whose target cannot be read, a folder that cannot be listed, a name its folder's listing
 * does not hold (a short name such as `SHOTS~1`, a trailing dot or space) and more than MAX_LINK_HOPS links are all
 * refused. A name that is simply not there is not: whatever follows the walk then stops at it, reaching nothing.
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

/** What the walk asks of the file system; answered by `walkLinks` (async) or `walkLinksSync` */
type Ask = { list: string } | { readlink: string }
/** A failed answer: the error's code */
type Failed = { failed: string | undefined }

function* walkSteps(abs: string): Generator<Ask, LinkWalk, Dirent[] | string | Failed> {
  let path = abs
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
    const { root } = win32.parse(path)
    if (!DRIVE_PATH.test(root)) return { ok: false, reason: 'elsewhere', why: path }
    const parts = path.slice(root.length).split(/[\\/]+/).filter(Boolean)
    let current = root
    let next: string | null = null
    for (const [i, part] of parts.entries()) {
      const listed = yield { list: current }
      if (!Array.isArray(listed)) {
        const code = (listed as Failed).failed
        if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true }
        return { ok: false, reason: 'unchecked', why: `${current} cannot be listed (${code})` }
      }
      // The name on disk: Windows names ignore case, and a folder that does not may hold both spellings
      const entry = listed.find((e) => e.name === part) ?? listed.find((e) => e.name.toLowerCase() === part.toLowerCase())
      if (!entry) {
        // A short name, or a name Windows trims (a trailing dot or space), names something the listing spells otherwise
        if (/[~:]|[. ]$/.test(part)) return { ok: false, reason: 'unchecked', why: `${win32.join(current, part)} is not a name in its folder` }
        return { ok: true }
      }
      const candidate = win32.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        const target = yield { readlink: candidate }
        if (typeof target !== 'string') return { ok: false, reason: 'unchecked', why: `the target of ${candidate} cannot be read` }
        if (!localLinkTarget(target)) return { ok: false, reason: 'elsewhere', why: target }
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

const failed = (e: unknown): Failed => ({ failed: (e as NodeJS.ErrnoException).code })

export async function walkLinks(abs: string): Promise<LinkWalk> {
  const steps = walkSteps(abs)
  let step = steps.next()
  while (!step.done) {
    const ask = step.value
    const answer = await ('list' in ask ? readdir(ask.list, { withFileTypes: true }) : readlink(ask.readlink)).catch(failed)
    step = steps.next(answer)
  }
  return step.value
}

export function walkLinksSync(abs: string): LinkWalk {
  const steps = walkSteps(abs)
  let step = steps.next()
  while (!step.done) {
    const ask = step.value
    let answer: Dirent[] | string | Failed
    try {
      answer = 'list' in ask ? readdirSync(ask.list, { withFileTypes: true }) : readlinkSync(ask.readlink)
    } catch (e) {
      answer = failed(e)
    }
    step = steps.next(answer)
  }
  return step.value
}
