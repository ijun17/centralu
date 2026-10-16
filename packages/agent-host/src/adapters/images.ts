import { readFile, stat } from 'node:fs/promises'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * Turns an image that arrived carrying only a path (#40, imageView) into an event the screen can draw.
 *
 * normalize is a pure function and cannot read files — the IO happens here. An event goes out
 * regardless of what fails: a box with a reason beats a silent blank (a failure should be visible).
 */

/** Decides the mime type from the extension — outside this list, it does not draw the image and states why */
const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/** 8MB — an event is a payload that travels over WS all the way to the UI. For a large file, the path is already on screen */
export const IMAGE_MAX_BYTES = 8 * 1048576

type ImageEvent = Extract<NormalizedEvent, { type: 'message_image' }>

/** The note of an image left undrawn for its size, the same words whichever way it arrived */
const tooLarge = (bytes: number): string => `Image is too large (${Math.round(bytes / 1048576)}MB)`

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
    const part = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (part.type !== 'image') continue
    const data = typeof part.data === 'string' ? part.data : ''
    const mime = typeof part.mimeType === 'string' ? part.mimeType : ''
    out.push(data ? inlineImageEvent(sessionId, mime, data) : undrawnImageEvent(sessionId, 'The tool sent an image with no data'))
  }
  return out
}

export async function imageEventFromDisk(
  sessionId: string,
  path: string,
  maxBytes: number = IMAGE_MAX_BYTES,
): Promise<NormalizedEvent> {
  const fail = (note: string): ImageEvent => ({ ...undrawnImageEvent(sessionId, note), path })
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const mime = IMAGE_MIMES[ext]
  if (!mime) return fail(`Cannot display this format (.${ext})`)
  try {
    const s = await stat(path)
    if (s.size > maxBytes) return fail(tooLarge(s.size))
    const buf = await readFile(path)
    return { type: 'message_image', sessionId, mime, data: buf.toString('base64'), path }
  } catch (err) {
    // The file may already have been deleted — even so, what happened is left visible on screen
    return fail(`Failed to read image: ${(err as Error).message}`)
  }
}
