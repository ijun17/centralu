import { readFile, stat } from 'node:fs/promises'
import type { NormalizedEvent } from '@cc/protocol'
import { bytesText } from '../bytes-text.js'
import { asObj } from '../json-value.js'

/**
 * Turns an image that arrived carrying only a path (#40, imageView) into an event the screen can draw.
 *
 * normalize is a pure function and cannot read files — the IO happens here. An event goes out
 * regardless of what fails: a box with a reason beats a silent blank (a failure should be visible).
 */

/** The formats the window draws, by extension: a file named otherwise is told apart from a picture by its bytes only */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

const startsWith = (buf: Buffer, bytes: number[], at = 0): boolean => bytes.every((b, i) => buf[at + i] === b)

/**
 * What the bytes are, by their own signature, and whether the whole file is there (#1464). The extension says what the
 * agent hoped for: a screenshot read while the tool is still writing it, or a file that is not the format its name says,
 * arrives whole to the window and is drawn as an empty framed box (WebKit paints nothing for a picture it cannot
 * decode, not even the alt text). The mime comes from the bytes, so a `.png` that is a JPEG is still drawn.
 *
 * `complete: false` is a file cut short, told by the end each format closes with: PNG's `IEND` chunk, JPEG's end of
 * image marker, GIF's trailer byte, and the size the RIFF (WebP) and BMP headers state. A picture is never held back
 * for what follows its end: a PNG saved over a longer one, a JPEG with a trailer or a video after it (a phone's motion
 * photo) and a GIF with padding all draw, so the end is looked for from the back, not only at the last byte.
 */
/**
 * Whether a GIF's blocks run to its trailer byte. Walked block by block, as a byte search cannot tell the trailer from a
 * 0x3b inside the data, and the bytes after the trailer (padding) are not looked at, as a browser draws such a file.
 */
function gifReachesTrailer(buf: Buffer): boolean {
  const n = buf.length
  const at = (i: number): number => buf[i] ?? 0
  // A colour table follows when the flag bit (0x80) is set: 3 bytes for each of 2^(size+1) colours
  const table = (flags: number): number => (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0)
  // Sub-blocks: a length byte and that many bytes, until a length of 0
  const skipSubBlocks = (from: number): number => {
    let i = from
    while (i < n && at(i) !== 0) i += at(i) + 1
    return i + 1
  }
  let i = 13 + table(at(10))
  while (i < n) {
    const b = at(i)
    if (b === 0x3b) return true
    if (b === 0x21) i = skipSubBlocks(i + 2)
    else if (b === 0x2c) i = skipSubBlocks(i + 11 + table(at(i + 9)))
    // Not a block of GIF: the file is damaged, not cut short, and a browser draws what it has
    else return true
  }
  return false
}

export function sniffImage(buf: Buffer): { mime: string; complete: boolean } | null {
  const n = buf.length
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', complete: buf.lastIndexOf('IEND', n, 'latin1') >= 8 }
  }
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', complete: buf.lastIndexOf(Buffer.from([0xff, 0xd9])) > 2 }
  const head = buf.subarray(0, 6).toString('latin1')
  if (head === 'GIF87a' || head === 'GIF89a') return { mime: 'image/gif', complete: gifReachesTrailer(buf) }
  if (head.startsWith('RIFF') && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', complete: buf.readUInt32LE(4) + 8 <= n }
  }
  // A BMP has two reserved words of zero in its 14-byte header and a DIB header of one of a few sizes after it: a text file that starts with "BM" has neither
  if (startsWith(buf, [0x42, 0x4d]) && n >= 26 && buf.readUInt32LE(6) === 0 && [12, 40, 52, 56, 64, 108, 124].includes(buf.readUInt32LE(14))) return { mime: 'image/bmp', complete: buf.readUInt32LE(2) <= n }
  return null
}

const SIGNATURES = [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0xff, 0xd8, 0xff], [...Buffer.from('GIF89a')], [...Buffer.from('RIFF')], [0x42, 0x4d]]

/**
 * The one check of picture bytes for every image the window is sent, from disk or inline: what it is, or why it is not
 * drawn. Nothing, or the first bytes of a signature, is a file still being written, so it gets the cut-short reason too.
 */
export function judgeImage(buf: Buffer): { mime: string } | { note: string } | null {
  const seen = sniffImage(buf)
  if (seen?.complete) return { mime: seen.mime }
  if (seen || buf.length < 8 && SIGNATURES.some((sig) => buf.every((b, i) => i >= sig.length || b === sig[i]))) {
    return { note: `the file is cut short (${buf.length} bytes): it may still be being written` }
  }
  return null
}

/** 8MB — an event is a payload that travels over WS all the way to the UI. For a large file, the path is already on screen */
export const IMAGE_MAX_BYTES = 8 * 1048576

type ImageEvent = Extract<NormalizedEvent, { type: 'message_image' }>

/** The note of an image left undrawn for its size, the same words whichever way it arrived */
const tooLarge = (bytes: number): string => `too large (${bytesText(bytes)})`

/**
 * An image a tool answered with inline, as base64 (#40, #843): a Claude tool result's image block, an MCP tool's
 * image content on either tool. Held to the same ceiling as an image read from disk; over it, the box says why.
 */
export function inlineImageEvent(sessionId: string, mime: string, data: string): ImageEvent {
  const bytes = Math.floor((data.length * 3) / 4)
  if (bytes > IMAGE_MAX_BYTES) return { type: 'message_image', sessionId, mime, data: '', note: tooLarge(bytes) }
  // Bytes cut short draw as an empty box too (#1464); bytes of no known format are left to the window, which handles an error
  const judged = judgeImage(Buffer.from(data, 'base64'))
  if (judged && 'note' in judged) return undrawnImageEvent(sessionId, judged.note)
  return { type: 'message_image', sessionId, mime: judged?.mime ?? (mime || 'image/png'), data }
}

/** An image the screen cannot draw, with the reason (a failure should be visible) */
export function undrawnImageEvent(sessionId: string, note: string): ImageEvent {
  return { type: 'message_image', sessionId, mime: '', data: '', note }
}

/**
 * The images in an MCP tool's answer (MCP `CallToolResult.content`: `{type: 'image', data, mimeType}`), the
 * shape Codex passes through on an `mcpToolCall` item's `result.content`. Codex kept only the text of that content, so
 * an MCP tool's screenshot (a browser's, say) never reached the screen, where the same tool under Claude showed it.
 */
export function mcpImageEvents(sessionId: string, content: unknown): NormalizedEvent[] {
  if (!Array.isArray(content)) return []
  const out: NormalizedEvent[] = []
  for (const raw of content) {
    const part = asObj(raw)
    if (part.type !== 'image') continue
    const data = typeof part.data === 'string' ? part.data : ''
    const mime = typeof part.mimeType === 'string' ? part.mimeType : ''
    out.push(data ? inlineImageEvent(sessionId, mime, data) : undrawnImageEvent(sessionId, 'the tool sent it with no data'))
  }
  return out
}

/** Why a read failed, in words for the card */
function readFailure(err: unknown): string {
  const code = asObj(err).code
  if (code === 'ENOENT') return 'the file is gone'
  if (code === 'EACCES' || code === 'EPERM') return 'no permission to read it'
  if (code === 'EISDIR') return 'it is a folder'
  // Not the message: it names the path, which the card already shows (and the system's wording is not the person's)
  return typeof code === 'string' ? `the system refused the read (${code})` : 'the read failed'
}

export async function imageEventFromDisk(
  sessionId: string,
  path: string,
  maxBytes: number = IMAGE_MAX_BYTES,
): Promise<NormalizedEvent> {
  const fail = (note: string): ImageEvent => ({ ...undrawnImageEvent(sessionId, note), path })
  const file = path.split(/[\\/]/).pop() ?? path
  const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1).toLowerCase() : ''
  try {
    const s = await stat(path)
    if (s.size > maxBytes) return fail(tooLarge(s.size))
    const buf = await readFile(path)
    const seen = judgeImage(buf)
    if (!seen) return fail(!ext ? 'the file is not a picture' : IMAGE_EXTENSIONS.has(ext) ? `the file is not a valid .${ext} image` : `the .${ext} format cannot be shown`)
    if ('note' in seen) return fail(seen.note)
    return { type: 'message_image', sessionId, mime: seen.mime, data: buf.toString('base64'), path }
  } catch (err) {
    // The file may already have been deleted — even so, what happened is left visible on screen
    return fail(readFailure(err))
  }
}
