import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Only one host per data folder.
 *
 * If two hosts held the same store.db, each would carry its own session list in memory while
 * writing to the same file. Neither knows about a session the other created, so **the "already
 * loaded" check disagrees and the same conversation ends up twice on the list** — a real
 * duplicate-session incident traces back to exactly this shape. SQLite's own lock contention
 * comes on top of that.
 *
 * So this is blocked with a single lock file, and the reason for the block is stated plainly.
 *
 * **The lock file records the pid together with that process's start time** (#184). The lock is
 * only released on the `exit` event, so it is left behind after a SIGKILL (when the host does not
 * finish within 3 seconds of the app quitting) or a power loss. Recording only the pid would
 * reject startup the moment some process unrelated to Centralu reuses that number, and with no
 * window to close, the person would have no way to know how to get unstuck. The same pid with a
 * different start time belongs to someone else.
 */

export type LockResult = { ok: true; release: () => void } | { ok: false; heldByPid: number; lockPath: string }

/** The lock file's contents. A file an older host wrote is just a bare pid number */
type Holder = { pid: number; started: string | null }

/** Whether that pid is still alive (signal 0 only confirms existence) */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it belongs to someone else, but it is **alive** — this must not read as dead
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * That pid's start time. null if it is unknown.
 *
 * The shape of `ps -o lstart=` follows the locale (in a Korean locale, "2026년 9월 27일 …"). If
 * the host that wrote the lock and the host reading it have different locales, the same process
 * would be misread as someone else's and its lock stolen, so this is pinned to C.
 */
export function processStartTime(pid: number): string | null {
  if (process.platform === 'win32') return null
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim()
    return out || null
  } catch {
    return null
  }
}

function parseHolder(raw: string): Holder {
  const text = raw.trim()
  if (/^\d+$/.test(text)) return { pid: Number(text), started: null }
  try {
    const v = JSON.parse(text) as { pid?: unknown; started?: unknown }
    return {
      pid: typeof v.pid === 'number' ? v.pid : NaN,
      started: typeof v.started === 'string' ? v.started : null,
    }
  } catch {
    return { pid: NaN, started: null }
  }
}

/**
 * Whether the recorded owner is still that process.
 *
 * If a start time was recorded and that pid's current start time can be read, the two are
 * compared. If either side is unknown (an old file, ps failing), only whether it is alive is
 * checked — when in doubt, blocking is safer than stealing the lock.
 */
function stillHeld(holder: Holder, startOf: (pid: number) => string | null): boolean {
  if (!alive(holder.pid) || holder.pid === process.pid) return false
  if (holder.started === null) return true
  const now = startOf(holder.pid)
  return now === null || now === holder.started
}

export function acquireInstanceLock(
  dbPath: string,
  startOf: (pid: number) => string | null = processStartTime,
): LockResult {
  // an in-memory database is never shared
  if (dbPath === ':memory:') return { ok: true, release: () => {} }

  const lockPath = join(dirname(dbPath), 'host.lock')

  try {
    const held = parseHolder(readFileSync(lockPath, 'utf8'))
    if (stillHeld(held, startOf)) return { ok: false, heldByPid: held.pid, lockPath }
    // a file left by a dead owner (or someone else who just shares the number) is simply taken over (when the app was force-quit)
  } catch {
    // no file means this is the first one to acquire it
  }

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: startOf(process.pid) }))
  let released = false
  return {
    ok: true,
    release: () => {
      if (released) return
      released = true
      try {
        // this is deleted only when it is our own — clearing someone else's lock would defeat the whole point of the block
        if (parseHolder(readFileSync(lockPath, 'utf8')).pid === process.pid) unlinkSync(lockPath)
      } catch {
        // nothing to do if it is already gone
      }
    },
  }
}

/** The message shown when blocked by the lock. Names the lock file's location so even a person with no window to close can get unstuck (#184) */
export function lockConflictMessage(heldByPid: number, lockPath: string): string {
  return (
    `[agent-host] Another Centralu is already using this data (pid ${heldByPid}).\n` +
    `  Two hosts on the same folder will desync session lists.\n` +
    `  Close the running window first, or use pnpm app:dev while developing (it uses a separate data folder).\n` +
    `  Lock file: ${lockPath}`
  )
}
