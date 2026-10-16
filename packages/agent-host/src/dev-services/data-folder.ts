import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The folders the host keeps per session in its data folder (attachments, worktree recovery
 * snapshots, handoff notes), sized and removed one way (#850 item 19). The trash shows what a
 * session holds on this machine (#204) from these sizes.
 *
 * **Sizing counts regular files only, and never follows a link.** The folders are the host's own,
 * and a link in one points somewhere that is not: following it counted a file outside (or a whole
 * tree) as the session's, and a link to nothing made the recovery size throw, which the trash then
 * showed as 0 for every byte of the snapshot beside it. An entry that vanishes while it is being read
 * (a purge or a sweep running at the same time) or cannot be read is skipped, not allowed to cost the
 * sum: the number is an estimate shown to a person, never a reason to delete.
 */
export async function dataBytes(path: string): Promise<number> {
  const s = await lstat(path).catch(() => null)
  if (!s) return 0
  if (s.isFile()) return s.size
  if (!s.isDirectory()) return 0
  const names = await readdir(path).catch(() => [] as string[])
  const sizes = await Promise.all(names.map((name) => dataBytes(join(path, name))))
  return sizes.reduce((a, b) => a + b, 0)
}

/**
 * Removes a data folder (or file) for good. A missing one is already removed. `maxRetries` is for
 * Windows, where a file another process just closed (an indexer, an antivirus scan, a viewer) can
 * still refuse removal for a moment with EBUSY or EPERM; Node retries those, waiting a little longer each time.
 */
export async function removeData(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3 })
}
