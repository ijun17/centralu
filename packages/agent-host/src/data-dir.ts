import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DATA_DIR } from '@cc/protocol'

/**
 * Moves the pre-rename data folder to its new name (`~/.control-center` → `~/.centralu`). (legacy-name)
 *
 * **Call exactly once, before opening the DB.** Moving it after opening leaves the open file
 * handle out of sync with the path.
 *
 * This is a `rename`, not a copy — on the same filesystem it completes instantly, and **there is
 * no state where it gets interrupted halfway and leaves half of it behind.** This property matters
 * because a real-world DB of 24MB comes with a folder that also carries WAL and SHM files. A copy
 * would create a state of "a conversation history moved only halfway."
 *
 * @returns true if it actually moved something
 */
export function migrateLegacyDataDir(from: string, to: string): boolean {
  /*
   * **Leave both alone if both exist.**
   *
   * The new folder already existing means either the move already happened or this is a fresh
   * start. Merging the two is not ours to decide — we do not know which conversation history is
   * the real one. The old folder is left in place so the user can go look at it directly.
   */
  if (!existsSync(from) || existsSync(to)) return false
  try {
    renameSync(from, to)
    return true
  } catch {
    // Even if the move fails, the app still has to start — it starts empty with the new folder,
    // and the old one is left behind undamaged.
    // (This happens when they are on different filesystems, or there is no permission. Better than
    // dying silently.)
    return false
  }
}

/**
 * The root of the data folder — attachments, the orchestrator home, and worktrees all live under
 * this.
 *
 * **Why it can be overridden by an environment variable:** otherwise tests would write into the
 * user's real home. We actually hit this — a single `pnpm verify` created
 * `~/.centralu/orchestrator`, and that empty folder then tripped the "leave it alone if the new
 * folder already exists" safeguard, **blocking the move of the real data.** Being blocked silently
 * is the worse failure.
 *
 * At startup, the host pins this value as its own data folder (dev and prod diverge here).
 */
export function dataRoot(): string {
  return process.env.CC_DATA_DIR || join(homedir(), DATA_DIR)
}
