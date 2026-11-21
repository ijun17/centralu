import { realOs } from '../os/real.js'
import { treeBytes } from './entry-sizes.js'

/**
 * The size of a per-session data folder (attachments, worktree recovery snapshots, handoff notes), which the session
 * archive shows (#204). **Regular files only, never through a link:** a link points outside the host's folders, and a
 * dangling one would throw. An entry that vanishes mid-walk (a concurrent purge or sweep) or cannot be read is skipped:
 * the number is an estimate for a person, never a reason to delete. `treeBytes` without its deadline or cap.
 */
export async function dataBytes(path: string): Promise<number> {
  return (await treeBytes(path, Infinity, Infinity)) ?? 0
}

/**
 * Removes a data folder (or file) for good. A missing one is already removed. On Windows, where a file another process
 * just closed (an indexer, an antivirus scan, a viewer) can still refuse removal for a moment, the `Os` tries it again
 * (os/held.ts).
 */
export async function removeData(path: string): Promise<void> {
  await realOs().files.promises.rm(path, { recursive: true, force: true })
}

/** `removeData` without an await, for a write that must not yield (`writeHandoffNoteSync`) */
export function removeDataSync(path: string): void {
  realOs().files.rmSync(path, { recursive: true, force: true })
}

/**
 * Removes a leftover that nothing depends on, and never throws: a refusal (EBUSY, EPERM or ENOTEMPTY that outlasts the
 * retries, on Windows) is written to the host's log instead. For cleanup that runs beside a result or an error the
 * caller must keep (a staging folder after a failed import, a temp folder after a snapshot) and in places no one is
 * there to catch it (a timer). `prefix` is the caller's log tag (`[apps]`), so this shared file names no one; `remove` is injectable so tests can make it throw.
 */
export function removeDataQuietly(path: string, prefix: string, remove: (path: string) => void = removeDataSync): void {
  try {
    remove(path)
  } catch (e) {
    console.error(`${prefix} could not remove ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
