import { errorMessage } from '@cc/protocol'
import { isObj } from '../json-value.js'
import { errnoCode } from './errno.js'
import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { hasPs } from '../os.js'

/**
 * Only one host per data folder.
 *
 * If two hosts held the same store.db, each would carry its own session list in memory while
 * writing to the same file. Neither knows about a session the other created, so **the "already
 * loaded" check disagrees and the same conversation ends up twice on the list** — a real
 * duplicate-session incident traces back to exactly this shape. SQLite's own lock contention
 * comes on top of that.
 *
 * So the start is refused, and the reason for the refusal is stated plainly.
 *
 * **Ownership itself is an exclusive SQLite lock held for the host's whole lifetime (#82).** The
 * lock file alone was check-then-write: two hosts could both read "no live owner" and both write.
 * Measured on main: 8 hosts started at once on one folder produced 2 owners; a second acquire in
 * the same process succeeded; and while an owner was alive, a missing `host.lock` let a second
 * owner in. A file left behind by a SIGKILL or a power loss also refused every later start once
 * an unrelated process reused its pid, unless the start time recorded next to it told the two
 * apart (#184). Now the owner opens `host-ownership.sqlite` and holds `BEGIN EXCLUSIVE` on it until it
 * exits. Taking that lock is atomic, a second taker gets SQLITE_BUSY at once, and the operating
 * system releases it when the process dies however it dies (SIGKILL, a crash, a power cut leaves
 * no process to hold it), so there is nothing stale to clean up. Based on the approach in #91.
 *
 * `host.lock` stays as a description only: it names the owner (pid and start time) in the conflict
 * message. Until 0.1.0-beta.16 a live, matching `host.lock` also refused the start, for hosts from
 * before #82 that knew only the file; that check went with #461, so a host that old is no longer
 * kept out by this one (nor this one by it). This is local, single-machine ownership: not a
 * distributed lease, and not meant for a data folder on a network filesystem, where advisory locks
 * are not reliable.
 */

export type LockResult = { ok: true; release: () => void } | { ok: false; heldByPid: number | null; holder: Holder | null; lockPath: string }

/** The file whose exclusive lock is the ownership */
export const OWNERSHIP_FILE = 'host-ownership.sqlite'

/**
 * Open ownership handles. A handle that is garbage-collected is closed, and closing it releases
 * the lock, so each one is kept reachable here until its release().
 */
const held = new Set<Database.Database>()

/**
 * Who started a host, as `host.lock` describes it (#1223): the desktop window (`app`), the keeper, or `centralu serve`
 * (with where it was asked for from: a hub's link names its hub, an ssh session its client's address)
 */
export type HolderDescription = { by?: 'app' | 'keeper' | 'serve'; from?: { hub?: string; ssh?: string } }

/**
 * The lock file's contents. A file an older host wrote is just a bare pid number, or `{ pid, started }`; `at` (when it
 * took the folder, as epoch milliseconds: `started` is null on Windows, which has no `ps`), `by` and `from` are
 * additive (#1223), and a field of the wrong shape is read as absent
 */
export type Holder = { pid: number; started: string | null; at?: number } & HolderDescription

/**
 * That pid's start time. null if it is unknown.
 *
 * The shape of `ps -o lstart=` follows the locale (in a Korean locale, "2026년 9월 27일 …"). If
 * the host that wrote the lock and the host reading it have different locales, the same process
 * would be misread as someone else's and its lock stolen, so this is pinned to C.
 */
export function processStartTime(pid: number): string | null {
  if (!hasPs()) return null
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim()
    return out || null
  } catch {
    return null
  }
}

const NAME_RE = /^[A-Za-z0-9._:-]{1,64}$/

function parseHolder(raw: string): Holder {
  const text = raw.trim()
  if (/^\d+$/.test(text)) return { pid: Number(text), started: null }
  try {
    const v: unknown = JSON.parse(text)
    if (!isObj(v)) return { pid: NaN, started: null }
    const holder: Holder = {
      pid: typeof v.pid === 'number' ? v.pid : NaN,
      started: typeof v.started === 'string' ? v.started : null,
    }
    if (typeof v.at === 'number' && Number.isFinite(v.at)) holder.at = v.at
    if (v.by === 'app' || v.by === 'keeper' || v.by === 'serve') holder.by = v.by
    const f = isObj(v.from) ? v.from : {}
    const from = {
      ...(typeof f.hub === 'string' && NAME_RE.test(f.hub) ? { hub: f.hub } : {}),
      ...(typeof f.ssh === 'string' && NAME_RE.test(f.ssh) ? { ssh: f.ssh } : {}),
    }
    if (from.hub || from.ssh) holder.from = from
    return holder
  } catch {
    return { pid: NaN, started: null }
  }
}

/**
 * Takes ownership of the data folder `dbPath` is in, or says who holds it. `startOf` reads a pid's
 * start time, which `host.lock` records next to the pid.
 */
export function acquireInstanceLock(
  dbPath: string,
  startOf: (pid: number) => string | null = processStartTime,
  describe: HolderDescription = {},
  now: () => number = Date.now,
): LockResult {
  // an in-memory database is never shared
  if (dbPath === ':memory:') return { ok: true, release: () => {} }

  const lockPath = join(dirname(dbPath), 'host.lock')
  const readHolder = (): Holder | null => {
    try {
      return parseHolder(readFileSync(lockPath, 'utf8'))
    } catch {
      return null // no file means this is the first one to acquire it
    }
  }

  const owner = takeOwnership(join(dirname(dbPath), OWNERSHIP_FILE))
  if (!owner) {
    // Another host holds it. The file says who, when it can; the lock is the authority either way
    const holder = readHolder()
    const pid = holder && Number.isInteger(holder.pid) && holder.pid > 0 ? holder.pid : null
    return { ok: false, heldByPid: pid, holder: holder && pid !== null ? holder : null, lockPath }
  }

  // Whatever the file says, its writer no longer holds the folder: the file is overwritten
  const own: Holder = { pid: process.pid, started: startOf(process.pid), at: now() }
  if (describe.by) own.by = describe.by
  if (describe.from && (describe.from.hub || describe.from.ssh)) own.from = describe.from
  writeFileSync(lockPath, JSON.stringify(own))
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
      // Last: the file is only a description of the lock, so it goes before the lock does
      giveUp(owner)
    },
  }
}

/**
 * Takes the exclusive lock, or returns null when another connection (in this process or any other)
 * holds it.
 *
 * DELETE journal mode, because in WAL mode an exclusive transaction does not keep other
 * connections from opening and reading; in rollback mode BEGIN EXCLUSIVE takes the file's
 * EXCLUSIVE lock at once. `timeout: 0` makes a held lock an immediate SQLITE_BUSY instead of a
 * wait. Any other failure (an unreadable or corrupt file) is thrown: starting without being able
 * to check ownership is exactly what this exists to prevent.
 */
function takeOwnership(path: string): Database.Database | null {
  const db = new Database(path, { timeout: 0 })
  try {
    db.pragma('journal_mode = DELETE')
    db.exec('BEGIN EXCLUSIVE')
  } catch (err) {
    db.close()
    const code = errnoCode(err)
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return null
    throw Object.assign(new Error(`Cannot check who owns this data folder (${path}): ${errorMessage(err)}`), { cause: err })
  }
  held.add(db)
  return db
}

function giveUp(db: Database.Database): void {
  held.delete(db)
  try {
    db.close()
  } catch {
    // Closing is the release; a handle that is already gone has released already
  }
}

/**
 * The message shown when blocked by the lock. Names the lock file's location so even a person with no window to close
 * can get unstuck (#184), and who holds the folder when `host.lock` says (#1223): on a linked Windows machine the
 * holder is often the host a hub's link started, and "close the running window" sent the person looking for a window
 * that was not there. "already using this data" is matched by the window's supervisor (`is_final_refusal`): kept.
 */
export function lockConflictMessage(holder: Holder | number | null, lockPath: string): string {
  const h: Holder | null = typeof holder === 'number' ? { pid: holder, started: null } : holder
  const since = typeof h?.at === 'number' ? `, since ${new Date(h.at).toISOString().replace(/\.\d{3}Z$/, 'Z')}` : ''
  return [
    `[agent-host] Another Centralu is already using this data: ${holderName(h)} (pid ${h?.pid ?? 'unknown'}${since}).`,
    '  Two hosts on the same folder will desync session lists.',
    `  ${holderAdvice(h)}`,
    `  Lock file: ${lockPath}`,
  ].join('\n')
}

/** Who holds the folder, in words */
function holderName(h: Holder | null): string {
  if (h?.by === 'serve') {
    const link = h.from?.hub ? ` for the link from ${h.from.hub}` : ''
    const ssh = h.from?.ssh ? ` (asked for over ssh from ${h.from.ssh})` : ''
    return `the host \`centralu serve\` runs${link}${ssh}`
  }
  if (h?.by === 'app') return 'the host of the Centralu window on this computer'
  if (h?.by === 'keeper') return "the host Centralu's keeper runs on this computer"
  return 'another host'
}

/** What frees it, and what that costs */
function holderAdvice(h: Holder | null): string {
  if (h?.by === 'serve') {
    const link = h.from?.hub ? `the link from ${h.from.hub}` : 'a hub linked to this computer'
    return `A Centralu window of this version or later uses that host instead of starting its own. To free the folder, run \`centralu serve --stop\` here: ${link} loses this computer until it reconnects.`
  }
  if (h?.by === 'keeper') return 'Quit Centralu completely first, or use pnpm app:dev while developing (it uses a separate data folder).'
  return 'Close the running window first, or use pnpm app:dev while developing (it uses a separate data folder).'
}
