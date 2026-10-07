import type { MessageImage } from '@cc/protocol'

/**
 * Local images in an agent's reply: which destinations are files, and the answers the host gave for them.
 *
 * The window cannot load `![shot](/Users/me/out/shot.png)` itself (its origin is the app, and the desktop CSP takes
 * images from `data:` and `blob:` only), so such an image is asked of the session's host (`messages.image`) and drawn
 * from the bytes it sends back. A web address stays an ordinary `<img>`, as it always was.
 */

/**
 * The path a Markdown image destination names, or null when it is not a file: a web address (`https:`, `//host`), or
 * any other scheme (`data:`, `javascript:`), which the renderer's own URL rule keeps out of the page as before.
 *
 * Markdown percent-encodes a destination (`한글.png` reaches here as `%ED%95%9C…`, `<a b.png>` as `a%20b.png`), so the
 * path is decoded back to what the reply wrote; the host matches either spelling against the reply.
 */
export function localImagePath(src: string): string | null {
  const s = src.trim()
  if (!s || s.startsWith('//')) return null
  // A scheme is two characters or more, so a Windows drive (`C:\shots\a.png`) stays a path
  if (/^[a-z][a-z0-9+.-]+:/i.test(s) && !/^file:/i.test(s)) return null
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * The answers already given, per session and path, so a row the conversation's virtual list draws again (scrolled out
 * and back, a grid panel resized) does not ask the host again. Bounded by count and by bytes: an image can be up to
 * 10 MB, and a long session can name many.
 */
const MAX_ENTRIES = 64
const MAX_BYTES = 96_000_000

type Entry = { promise: Promise<MessageImage>; bytes: number }
const cache = new Map<string, Entry>()
let cachedBytes = 0

const keyOf = (sessionId: string, path: string) => `${sessionId}\u0000${path}`

function evict(): void {
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_ENTRIES && cachedBytes <= MAX_BYTES) return
    cache.delete(key)
    cachedBytes -= entry.bytes
  }
}

/**
 * The host's answer for one image, asked once.
 *
 * Not kept: a failed call (the host was away, or is a build without `messages.image`), and "not found", which an agent
 * that names a picture before it saves it turns into a picture a moment later. Everything else stands for the session.
 */
export function loadReplyImage(
  ask: (sessionId: string, path: string) => Promise<MessageImage>,
  sessionId: string,
  path: string,
): Promise<MessageImage> {
  const key = keyOf(sessionId, path)
  const hit = cache.get(key)
  if (hit) {
    // Most recently used goes last, so eviction takes the oldest
    cache.delete(key)
    cache.set(key, hit)
    return hit.promise
  }
  const entry: Entry = { promise: ask(sessionId, path), bytes: 0 }
  cache.set(key, entry)
  entry.promise.then(
    (r) => {
      if (cache.get(key) !== entry) return
      if (!r.ok && r.reason === 'not_found') {
        cache.delete(key)
        return
      }
      entry.bytes = r.ok ? r.data.length : 0
      cachedBytes += entry.bytes
      evict()
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key)
    },
  )
  evict()
  return entry.promise
}

/** For tests: forget every answer */
export function clearReplyImages(): void {
  cache.clear()
  cachedBytes = 0
}
