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

export async function imageEventFromDisk(
  sessionId: string,
  path: string,
  maxBytes: number = IMAGE_MAX_BYTES,
): Promise<NormalizedEvent> {
  const fail = (note: string): NormalizedEvent => ({ type: 'message_image', sessionId, mime: '', data: '', path, note })
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const mime = IMAGE_MIMES[ext]
  if (!mime) return fail(`Cannot display this format (.${ext})`)
  try {
    const s = await stat(path)
    if (s.size > maxBytes) return fail(`Image is too large (${Math.round(s.size / 1048576)}MB)`)
    const buf = await readFile(path)
    return { type: 'message_image', sessionId, mime, data: buf.toString('base64'), path }
  } catch (err) {
    // The file may already have been deleted — even so, what happened is left visible on screen
    return fail(`Failed to read image: ${(err as Error).message}`)
  }
}
