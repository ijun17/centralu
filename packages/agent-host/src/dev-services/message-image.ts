import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
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
 * the session's folder. Null for a URL that names another host (`file://server/share`).
 */
export function resolveWrittenPath(written: string, cwd: string, home: string = homedir()): string | null {
  if (/^file:/i.test(written)) {
    try {
      return fileURLToPath(written)
    } catch {
      return null
    }
  }
  if (written === '~') return home
  if (written.startsWith('~/') || (process.platform === 'win32' && written.startsWith('~\\'))) return resolve(home, written.slice(2))
  return resolve(cwd, written)
}

const refuse = (reason: MessageImageRefusal, message: string, file?: string): MessageImage =>
  file === undefined ? { ok: false, reason, message } : { ok: false, reason, message, file }

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`

/** Reads `abs` as a reply's image: checks 2 and 3 of the module comment, on one descriptor */
export async function readMessageImage(abs: string, max: number = IMAGE_PREVIEW_MAX_BYTES): Promise<MessageImage> {
  let file: string
  try {
    file = await realpath(abs)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') return refuse('unreadable', `Centralu may not read ${abs}`)
    return refuse('not_found', `There is no file at ${abs}`)
  }
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
