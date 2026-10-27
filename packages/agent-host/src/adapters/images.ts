import { readFile, stat } from 'node:fs/promises'
import { errorMessage, type NormalizedEvent } from '@cc/protocol'
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
 * image marker (looked for in the last bytes, as a file may carry padding after it), GIF's trailer byte, and the size
 * the RIFF (WebP) and BMP headers state.
 */
export function sniffImage(buf: Buffer): { mime: string; complete: boolean } | null {
  const n = buf.length
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', complete: n >= 20 && buf.subarray(n - 8, n - 4).toString('latin1') === 'IEND' }
  }
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    const tail = buf.subarray(Math.max(0, n - 64))
    return { mime: 'image/jpeg', complete: tail.includes(Buffer.from([0xff, 0xd9])) }
  }
  if (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a') {
    return { mime: 'image/gif', complete: buf[n - 1] === 0x3b }
  }
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', complete: n >= 12 && buf.readUInt32LE(4) + 8 <= n }
  }
  if (startsWith(buf, [0x42, 0x4d]) && n >= 14) return { mime: 'image/bmp', complete: buf.readUInt32LE(2) <= n }
  return null
}

/** 8MB — an event is a payload that travels over WS all the way to the UI. For a large file, the path is already on screen */
export const IMAGE_MAX_BYTES = 8 * 1048576

type ImageEvent = Extract<NormalizedEvent, { type: 'message_image' }>

/** The note of an image left undrawn for its size, the same words whichever way it arrived */
const tooLarge = (bytes: number): string => `too large (${Math.round(bytes / 1048576)}MB)`

/**
 * An image a tool answered with inline, as base64 (#40, #843): a Claude tool result's image block, an MCP tool's
 * image content on either tool. Held to the same ceiling as an image read from disk; over it, the box says why.
 */
export function inlineImageEvent(sessionId: string, mime: string, data: string): ImageEvent {
  const bytes = Math.floor((data.length * 3) / 4)
  if (bytes > IMAGE_MAX_BYTES) return { type: 'message_image', sessionId, mime, data: '', note: tooLarge(bytes) }
  return { type: 'message_image', sessionId, mime: mime || 'image/png', data }
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

/** Why a read failed, in words for the card: the system's message names the whole path, which the card already shows */
function readFailure(err: unknown): string {
  const code = asObj(err).code
  if (code === 'ENOENT') return 'the file is gone'
  if (code === 'EACCES' || code === 'EPERM') return 'no permission to read it'
  if (code === 'EISDIR') return 'it is a folder'
  return errorMessage(err)
}

export async function imageEventFromDisk(
  sessionId: string,
  path: string,
  maxBytes: number = IMAGE_MAX_BYTES,
): Promise<NormalizedEvent> {
  const fail = (note: string): ImageEvent => ({ ...undrawnImageEvent(sessionId, note), path })
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  try {
    const s = await stat(path)
    if (s.size > maxBytes) return fail(tooLarge(s.size))
    const buf = await readFile(path)
    const seen = sniffImage(buf)
    if (!seen) return fail(IMAGE_EXTENSIONS.has(ext) ? `the file is not a valid .${ext} image` : `the .${ext} format cannot be shown`)
    if (!seen.complete) return fail(`the file is cut short (${buf.length} bytes): it may still be being written`)
    return { type: 'message_image', sessionId, mime: seen.mime, data: buf.toString('base64'), path }
  } catch (err) {
    // The file may already have been deleted — even so, what happened is left visible on screen
    return fail(readFailure(err))
  }
}
