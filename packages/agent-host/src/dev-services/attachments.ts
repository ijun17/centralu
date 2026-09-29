import { mkdir, writeFile, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { isSessionId, type Attachment } from '@cc/protocol'
import { dataRoot } from '../data-dir.js'

/**
 * Attachment storage (D-1).
 *
 * An image is never put into the database as base64 — the conversation record would balloon and
 * the FTS index would get polluted. It is saved as a file, and only the path is passed around.
 * Deleting the session cleans it up along with it.
 */
// **This is a function.** Deciding this at module load time would bake in the value from before
// the host has settled on a data folder
const root = () => join(dataRoot(), 'attachments')

/**
 * A session's folder — here, the id has to be **exactly one segment** (#94).
 *
 * This is the only file that uses a session id as a directory name, and that directory is
 * deleted whole. Given `"../../Documents"`, `rm(..., { recursive: true })` actually deleted that
 * folder under the user's home. The protocol already filters the same thing at its boundary
 * (`SessionId`), but the side building the path checks it again itself — these functions are
 * called without going through the RPC layer too (`saveAttachment(m.id, 'agent-image', …)` is one
 * example, and future callers will be too).
 *
 * Why `path-guard` is not used here: it answers "does a multi-segment relative path stay inside
 * the root," following symlinks along the way, and that requires the root to already exist on
 * disk — the attachments root is created for the first time inside this very call, and the
 * cleanup side runs even before the root exists. What has to be asked here is not containment but
 * **"is this even an id in the first place."** With exactly one segment, there is no path that
 * could express leaving, which is a stronger guarantee than a containment check.
 */
function sessionDir(sessionId: string): string {
  if (!isSessionId(sessionId)) {
    throw Object.assign(new Error(`Not a session id: ${sessionId}`), { code: 'internal' })
  }
  return join(root(), sessionId)
}

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

export async function saveAttachment(
  sessionId: string,
  name: string,
  mime: string,
  dataBase64: string,
): Promise<Attachment> {
  const dir = sessionDir(sessionId)
  await mkdir(dir, { recursive: true })
  const ext = extname(name) || EXT[mime] || ''
  const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
  const buf = Buffer.from(dataBase64, 'base64')
  await writeFile(file, buf)
  return { kind: mime.startsWith('image/') ? 'image' : 'file', path: file, name, mime, bytes: buf.length }
}

/** Removed with the session when it is deleted for good from the trash (#204) — moving it to the trash keeps them */
export async function clearAttachments(sessionId: string): Promise<void> {
  await rm(sessionDir(sessionId), { recursive: true, force: true })
}

/** How much one session's attachments take — the trash shows what it holds (#204). 0 when there are none */
export async function attachmentBytes(sessionId: string): Promise<number> {
  const { readdir, lstat } = await import('node:fs/promises')
  const dir = sessionDir(sessionId)
  const names = await readdir(dir).catch(() => [] as string[])
  let total = 0
  for (const name of names) {
    // lstat: a link counts as itself — the folder is ours, and nothing here should follow a link out of it
    const s = await lstat(join(dir, name)).catch(() => null)
    if (s?.isFile()) total += s.size
  }
  return total
}

/** The cap on total size — once images started persisting (#40), they could accumulate without limit. The owner's decision: 500MB */
export const ATTACHMENTS_MAX_BYTES = 500 * 1048576

/**
 * Once the cap is exceeded, **the oldest files are deleted first.** The database's path reference
 * survives — a deleted image becomes a "cleaned up" box on screen, and that box is what tells the
 * person this policy exists.
 */
export async function sweepAttachments(maxBytes: number = ATTACHMENTS_MAX_BYTES): Promise<number> {
  const { readdir, stat, rm: rmFile } = await import('node:fs/promises')
  const files: { path: string; size: number; mtime: number }[] = []
  let dirs: string[]
  try {
    dirs = await readdir(root())
  } catch {
    return 0 // the folder does not exist yet — nothing to delete
  }
  for (const d of dirs) {
    const dir = join(root(), d)
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      const p = join(dir, name)
      const s = await stat(p).catch(() => null)
      if (s?.isFile()) files.push({ path: p, size: s.size, mtime: s.mtimeMs })
    }
  }
  let total = files.reduce((a, f) => a + f.size, 0)
  if (total <= maxBytes) return 0
  files.sort((a, b) => a.mtime - b.mtime)
  let removed = 0
  for (const f of files) {
    if (total <= maxBytes) break
    await rmFile(f.path, { force: true }).catch(() => {})
    total -= f.size
    removed++
  }
  return removed
}
