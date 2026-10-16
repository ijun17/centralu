import { constants } from 'node:fs'
import { open, readdir, readlink, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, sep, win32, type PlatformPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMAGE_PREVIEW_MAX_BYTES, type MessageImage, type MessageImageRefusal } from '@cc/protocol'

/**
 * A local image an agent wrote into a reply (`messages.image`, docs/security-boundaries.md "Images a reply names").
 *
 * The window cannot load `![shot](/Users/me/out/shot.png)` itself: its origin is the app and its CSP takes images from
 * `data:` and `blob:` only, so WKWebView drew a broken-image mark. The host reads the file instead, and since that file
 * can be anywhere on the machine (the owner's decision, 2026-10-07: an agent saves screenshots wherever its task put
 * them), what keeps this from being a general file reader is three checks, each on its own:
 *
 *   1. the path is one this session's own replies wrote (`mentions`, asked by the manager before anything is touched)
 *   2. the bytes are PNG, JPEG, GIF or WebP (`sniffImage`), whatever the name says
 *   3. at most IMAGE_PREVIEW_MAX_BYTES
 *
 * The path is resolved once (`realpath`), and that resolved string is the one opened, with O_NOFOLLOW, once; the type,
 * the size and the magic bytes are all read through that one descriptor. So what was checked is what is sent.
 */

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)

/** The formats a reply's image may be, by their first bytes. SVG is not one: see `sniffImage` */
export const MESSAGE_IMAGE_KINDS = 'PNG, JPEG, GIF or WebP'

/**
 * The image type its first bytes say, or null.
 *
 * Only formats with a fixed signature are taken, because the signature is the check: a text file named `.png` is not
 * an image here. SVG is refused for two reasons. It has no signature, so deciding "this is an SVG" means parsing XML,
 * and any text file that contains `<svg` would pass, which turns check 2 above into "any text file". And an SVG is a
 * document that can carry script and external references; `<img>` does not run them, but the window would be taking a
 * document it did not choose on the strength of an agent's sentence. The file viewer still shows a project's SVGs.
 */
export function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, k) => b[i + k] === x)
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  // GIF87a / GIF89a
  if (b.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif'
  // RIFF....WEBP
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}

/**
 * The spellings of `written` a reply may hold. The window sends the path decoded (Markdown percent-encodes a
 * destination, so `한글.png` arrives as `%ED%95%9C…` and is decoded back); an agent that wrote `a%20b.png` itself
 * wrote the encoded form, which `encodeURI` gives back.
 */
export function writtenForms(written: string): string[] {
  let encoded = written
  try {
    encoded = encodeURI(written)
  } catch {
    // A lone surrogate: only the string as sent can match
  }
  return encoded === written ? [written] : [written, encoded]
}

// What may stand right before and right after a path in Markdown: `](…)`, `(<…>)`, `[x]: …`, quotes, a code span
const BEFORE = /[\s(<"'`]/
const AFTER = /[\s)>"'`]/

/**
 * Whether `text` names `written` as a whole path, not as part of a longer one.
 *
 * A bare substring test would let `a.png` through on the strength of a reply that wrote `/x/a.png`, and `a.png`
 * resolves against the session's folder to a different file. So the match has to stand alone: what is right before
 * and right after it is the start or end of the text, space, a bracket or a quote.
 */
export function mentions(text: string, written: string): boolean {
  for (const form of writtenForms(written)) {
    let from = 0
    for (;;) {
      const i = text.indexOf(form, from)
      if (i < 0) break
      const end = i + form.length
      if ((i === 0 || BEFORE.test(text[i - 1]!)) && (end === text.length || AFTER.test(text[end]!))) return true
      from = i + 1
    }
  }
  return false
}

/**
 * The absolute path `written` names, on this machine: a `file://` URL, `~` for the home folder, or a path relative to
 * the session's folder. Null for a path on another machine: a URL that names another host (`file://server/share`), and
 * on Windows any path that resolves to `\\…` (`\\server\share`, `//server/share`, `file://server/share`, which Node
 * turns into that UNC path there instead of refusing it, and the `\\?\` and `\\.\` device paths). Reading one would make
 * the host reach out to whichever machine a reply named, and Windows would offer that machine the person's sign-in.
 *
 * `p` is the path module of the system the host runs on; tests pass `win32` or `posix` to check either on any.
 */
export function resolveWrittenPath(
  written: string,
  cwd: string,
  home: string = homedir(),
  p: PlatformPath = sep === '\\' ? win32 : posix,
): string | null {
  const windows = p.sep === '\\'
  let abs: string
  if (/^file:/i.test(written)) {
    try {
      abs = fileURLToPath(written, { windows })
    } catch {
      return null
    }
  } else if (written === '~') abs = home
  else if (written.startsWith('~/') || (windows && written.startsWith('~\\'))) abs = p.resolve(home, written.slice(2))
  else abs = p.resolve(cwd, written)
  if (windows && abs.startsWith('\\\\')) return null
  return abs
}

/** A Windows path on a drive letter: the only kind the walk below, and the read after it, take */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/

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

type LinkWalk = { ok: true } | { ok: false; reason: 'elsewhere' | 'unchecked'; why: string }

/**
 * Where the links along `abs` lead, judged before anything follows them (Windows, #849).
 *
 * `resolveWrittenPath` refuses a path written as `\\…`, but a local link can lead there: `shot.png -> \\host\share\x.png`,
 * or a folder link earlier in the path. `realpath` follows it, and following it is already the connection: Windows
 * opens the share over SMB and offers that machine the person's sign-in. So the path is walked from its drive, one
 * name at a time, and what each name is comes from its folder's listing: libuv lists every reparse point as a link,
 * while `lstat` follows one whose target it cannot read (it would itself be the connection). A link's target is read
 * with `readlink` and followed by hand only if `localLinkTarget` takes it.
 *
 * This fails closed: a link whose target cannot be read, a folder that cannot be listed, a name its folder's listing
 * does not hold (a short name such as `SHOTS~1`), and more than MAX_LINK_HOPS links are all refused. A name that is
 * simply not there is not: realpath then stops at it, reaching nothing.
 */
export async function walkLinks(abs: string): Promise<LinkWalk> {
  let path = abs
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
    const { root } = win32.parse(path)
    if (!DRIVE_PATH.test(root)) return { ok: false, reason: 'elsewhere', why: path }
    const parts = path.slice(root.length).split(/[\\/]+/).filter(Boolean)
    let current = root
    let next: string | null = null
    for (const [i, part] of parts.entries()) {
      const listed = await readdir(current, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => e)
      if (listed instanceof Error) {
        if (listed.code === 'ENOENT' || listed.code === 'ENOTDIR') return { ok: true }
        return { ok: false, reason: 'unchecked', why: `${current} cannot be listed (${listed.code})` }
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
        const target = await readlink(candidate).catch(() => null)
        if (target === null) return { ok: false, reason: 'unchecked', why: `the target of ${candidate} cannot be read` }
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

const refuse = (reason: MessageImageRefusal, message: string, file?: string): MessageImage =>
  file === undefined ? { ok: false, reason, message } : { ok: false, reason, message, file }

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`

/** Reads `abs` as a reply's image: checks 2 and 3 of the module comment, on one descriptor */
export async function readMessageImage(abs: string, max: number = IMAGE_PREVIEW_MAX_BYTES): Promise<MessageImage> {
  const windows = sep === '\\'
  if (windows) {
    const walk = await walkLinks(abs)
    if (!walk.ok && walk.reason === 'elsewhere') return refuse('not_found', `${abs} leads to ${walk.why}, which is not on this machine`)
    if (!walk.ok) return refuse('unreadable', `Centralu cannot check where ${abs} leads: ${walk.why}`)
  }
  let file: string
  try {
    file = await realpath(abs)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') return refuse('unreadable', `Centralu may not read ${abs}`)
    return refuse('not_found', `There is no file at ${abs}`)
  }
  // Again on what realpath answered: a link swapped in since the walk is caught before the open, not after it
  if (windows && !DRIVE_PATH.test(file)) return refuse('not_found', `${abs} leads to ${file}, which is not on this machine`)
  let handle
  try {
    // The resolved path, and no other: a link put there since realpath fails here (ELOOP) rather than being followed
    handle = await open(file, OPEN_FLAGS)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') return refuse('unreadable', `Centralu may not read ${file}`, file)
    return refuse('not_found', `${file} changed or went away while it was being opened`)
  }
  try {
    const info = await handle.stat()
    if (info.isDirectory()) return refuse('not_an_image', `${file} is a folder, not an image`, file)
    if (!info.isFile()) return refuse('not_an_image', `${file} is not a regular file`, file)
    if (info.size > max) {
      return refuse('too_large', `The image is ${mb(info.size)}; a reply shows images up to ${mb(max)}`, file)
    }
    // One byte past the cap, so a file that grew since the stat is caught by what was read, not by what was said
    const buf = Buffer.allocUnsafe(Math.min(info.size, max) + 1)
    let total = 0
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > max) return refuse('too_large', `The image is over ${mb(max)}; a reply shows images up to ${mb(max)}`, file)
    const bytes = buf.subarray(0, total)
    const mime = sniffImage(bytes)
    if (!mime) return refuse('not_an_image', `${file} is not a ${MESSAGE_IMAGE_KINDS} image`, file)
    return { ok: true, mime, data: bytes.toString('base64'), file }
  } finally {
    await handle.close()
  }
}
