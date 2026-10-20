import { rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { treeBytes } from './entry-sizes.js'

/**
 * The folders the host keeps per session in its data folder (attachments, worktree recovery
 * snapshots, handoff notes), sized and removed one way (#850 item 19). The session archive shows what a
 * session holds on this machine (#204) from these sizes.
 *
 * **Sizing counts regular files only, and never follows a link.** The folders are the host's own,
 * and a link in one points somewhere that is not: following it counted a file outside (or a whole
 * tree) as the session's, and a link to nothing made the recovery size throw, which the session archive then
 * showed as 0 for every byte of the snapshot beside it. An entry that vanishes while it is being read
 * (a purge or a sweep running at the same time) or cannot be read is skipped, not allowed to cost the
 * sum: the number is an estimate shown to a person, never a reason to delete. The walk is the one that sizes what git
 * ignores (`treeBytes`), without its deadline or its cap.
 */
export async function dataBytes(path: string): Promise<number> {
  return (await treeBytes(path, Infinity, Infinity)) ?? 0
}

/**
 * Removes a data folder (or file) for good. A missing one is already removed. `maxRetries` is for
 * Windows, where a file another process just closed (an indexer, an antivirus scan, a viewer) can
 * still refuse removal for a moment with EBUSY or EPERM; Node retries those, waiting a little longer each time.
 */
export async function removeData(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3 })
}

/**
 * `removeData` without an await, for a write that must not yield (`writeHandoffNoteSync`). `recursive` is what makes
 * Node honour `maxRetries` at all: without it the option is ignored.
 */
export function removeDataSync(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 })
}

/**
 * Removes a leftover that nothing depends on, and never throws: a refusal (EBUSY, EPERM or ENOTEMPTY that outlasts the
 * retries, on Windows) is written to the host's log instead. For cleanup that runs beside a result or an error the
 * caller must keep (a staging folder after a failed import, a temp folder after a snapshot) and in places no one is
 * there to catch it (a timer). `prefix` is the caller's log tag (`[apps]`), so this shared file names no one; `remove` is a
 * parameter for tests, which inject one that throws.
 */
export function removeDataQuietly(path: string, prefix: string, remove: (path: string) => void = removeDataSync): void {
  try {
    remove(path)
  } catch (e) {
    console.error(`${prefix} could not remove ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
