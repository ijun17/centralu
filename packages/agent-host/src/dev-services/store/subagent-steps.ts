import { oneRow } from './rows.js'
import type Database from 'better-sqlite3'
import { stampAfter } from './archive-stamp.js'

/** What one session's subagent steps take (#418), in or out of the trash: `listHeld` and `listTrashed` */
export type SubagentStepsRow = {
  sessionId: string
  name: string
  tool: string
  projectId: string | null
  projectName: string | null
  /** The launch cards whose steps these are */
  runs: number
  steps: number
  bytes: number
}

/** A session's subagent steps in the trash (#418): `deletedAt` is the latest move */
export type TrashedSubagentStepsRow = SubagentStepsRow & { deletedAt: number }

/**
 * One chunk of moving, restoring or deleting a session's subagent steps. The measured case (#418) is 20,689 steps of
 * one session holding 37.7 MB of payload: an UPDATE rewrites each row with its payload, so the whole of it in one
 * transaction would hold the host for as long as writing that takes. 250 rows is the chunk the session's own purge
 * uses (`DELETE_CHUNK` in trash.ts, #179).
 */
const CHUNK = 250

/** The part of a statement that sums what a step holds, as the trash counts a session's messages (`listTrash`) */
const STEP_BYTES = `COALESCE(SUM(LENGTH(CAST(sm.payload AS BLOB))), 0)`

/**
 * A session's subagent steps on their way to the trash and back (#418), without the session.
 *
 * The steps of the native subagents a session launched (#222, `subagent_messages`) are often most of what a long
 * session holds: the measured store kept 46 MB of them, all from one session still in use, and the only way to let
 * them go was to delete the conversation. Here they go to the trash on their own: `trashed_at` (v58) is set, the
 * launch cards stop reading them (`loadSubagentMessages`), and Settings lists them as a trash entry of their own until
 * the person restores them or deletes them for good.
 *
 * Only steps of a session that is live are listed or moved. A session in the trash holds all of its steps in its own
 * entry, and its purge takes them (`TrashRecords.purgeSession`); restored, its trashed steps are an entry again.
 */
export class SubagentStepRecords {
  /** The last time a move was stamped, so two sessions' moves never share one (`trash`) */
  private lastMovedAt = 0

  constructor(private readonly db: Database.Database) {}

  /** The steps each live session holds under its cards, largest first; a session with none is not listed */
  listHeld(): SubagentStepsRow[] {
    return this.list<SubagentStepsRow>(`sm.trashed_at IS NULL`, '')
  }

  /** The steps in the trash, one entry per live session, most recently moved first */
  listTrashed(): TrashedSubagentStepsRow[] {
    return this.list<TrashedSubagentStepsRow>(`sm.trashed_at IS NOT NULL`, ', MAX(sm.trashed_at) as deletedAt')
  }

  private list<Row extends SubagentStepsRow>(which: string, more: string): Row[] {
    return this.db
      .prepare<unknown[], Row>(
        `SELECT s.id as sessionId, s.name, s.tool, s.project_id as projectId, p.name as projectName,
                COUNT(DISTINCT sm.parent_call_id) as runs, COUNT(*) as steps, ${STEP_BYTES} as bytes${more}
           FROM subagent_messages sm
           JOIN sessions s ON s.id = sm.session_id AND s.deleted_at IS NULL
           LEFT JOIN projects p ON p.id = s.project_id
          WHERE ${which}
          GROUP BY s.id
          ORDER BY ${more ? 'deletedAt DESC' : 'bytes DESC'}, s.rowid DESC`,
      )
      .all()
  }

  /**
   * Moves a live session's steps to the trash, in chunks with the event loop let go between them. Only the steps kept
   * when it starts: a subagent still running goes on writing under its card, and those steps stay there. Null when the
   * session is not live; otherwise what was moved.
   *
   * Cut short (the host stopped), part of the steps are in the trash and the rest under their cards; each half reads
   * whole, and moving again takes the rest.
   */
  async trash(sessionId: string, now = Date.now(), chunk = CHUNK): Promise<{ steps: number; bytes: number } | null> {
    if (!this.isLive(sessionId)) return null
    const { last } = oneRow(this.db.prepare<unknown[], { last: number | null }>(`SELECT MAX(rowid) as last FROM subagent_messages WHERE session_id = ?`).get(sessionId))
    if (last === null) return { steps: 0, bytes: 0 }
    /*
     * Strictly later than the session's last move, even within one millisecond: the window deletes an entry up to the
     * `deletedAt` it listed (`purge`'s `upTo`), so a move made after it read the trash must stamp above that
     */
    const { prev } = oneRow(
      this.db
        .prepare<unknown[], { prev: number | null }>(`SELECT MAX(trashed_at) as prev FROM subagent_messages WHERE session_id = ? AND trashed_at IS NOT NULL`)
        .get(sessionId),
    )
    /*
     * Also later than the last move of any session: the list is ordered by this stamp, most recently moved first, and
     * two sessions moved in one millisecond would tie. Held in memory, not read from the table: no index leads with the
     * stamp, and a restart takes longer than the millisecond that matters. Not pinned to a stamp from a clock that was
     * wrong once (`stampAfter`)
     */
    const at = Math.max(stampAfter(this.lastMovedAt, now), (prev ?? 0) + 1)
    this.lastMovedAt = at
    const pick = this.db.prepare<unknown[], { rowid: number; bytes: number }>(
      `SELECT rowid, LENGTH(CAST(payload AS BLOB)) as bytes FROM subagent_messages
        WHERE session_id = ? AND trashed_at IS NULL AND rowid <= ? LIMIT ?`,
    )
    const mark = this.db.prepare(`UPDATE subagent_messages SET trashed_at = ? WHERE rowid = ?`)
    const moved = { steps: 0, bytes: 0 }
    await this.inChunks(() => {
      const rows = pick.all(sessionId, last, chunk)
      for (const r of rows) {
        mark.run(at, r.rowid)
        moved.steps++
        moved.bytes += r.bytes
      }
      return rows.length < chunk
    })
    return moved
  }

  /** Puts a live session's trashed steps back under their cards. False when it had none in the trash */
  async restore(sessionId: string, chunk = CHUNK): Promise<boolean> {
    if (!this.hasTrashed(sessionId)) return false
    const pick = this.db.prepare<unknown[], { rowid: number }>(`SELECT rowid FROM subagent_messages WHERE session_id = ? AND trashed_at IS NOT NULL LIMIT ?`)
    const unmark = this.db.prepare(`UPDATE subagent_messages SET trashed_at = NULL WHERE rowid = ?`)
    await this.inChunks(() => {
      const rows = pick.all(sessionId, chunk)
      for (const r of rows) unmark.run(r.rowid)
      return rows.length < chunk
    })
    return true
  }

  /**
   * Deletes a live session's trashed steps for good, those moved to the trash at or before `upTo` (#418 review): the
   * `deletedAt` the window listed, so steps moved there after it read the trash are not deleted unseen. Its steps under
   * their cards and its conversation stay. False when it had none in the trash up to then. Cut short, the rest are
   * still in the trash, to be deleted again.
   */
  async purge(sessionId: string, upTo: number, chunk = CHUNK): Promise<boolean> {
    if (!this.hasTrashed(sessionId, upTo)) return false
    const pick = this.db.prepare<unknown[], { rowid: number }>(
      `SELECT rowid FROM subagent_messages WHERE session_id = ? AND trashed_at IS NOT NULL AND trashed_at <= ? LIMIT ?`,
    )
    const drop = this.db.prepare(`DELETE FROM subagent_messages WHERE rowid = ?`)
    await this.inChunks(() => {
      const rows = pick.all(sessionId, upTo, chunk)
      for (const r of rows) drop.run(r.rowid)
      return rows.length < chunk
    })
    return true
  }

  /** How many of one launch card's steps are in the trash, so the card can say where they went */
  trashedOf(sessionId: string, parentCallId: string): number {
    const row = oneRow(
      this.db
        .prepare<unknown[], { n: number }>(`SELECT COUNT(*) as n FROM subagent_messages WHERE session_id = ? AND parent_call_id = ? AND trashed_at IS NOT NULL`)
        .get(sessionId, parentCallId),
    )
    return row.n
  }

  /** A live session with steps in the trash (moved at or before `upTo`, when given): the only kind `restore` and `purge` take */
  hasTrashed(sessionId: string, upTo = Number.MAX_SAFE_INTEGER): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM subagent_messages sm JOIN sessions s ON s.id = sm.session_id AND s.deleted_at IS NULL
          WHERE sm.session_id = ? AND sm.trashed_at IS NOT NULL AND sm.trashed_at <= ? LIMIT 1`,
      )
      .get(sessionId, upTo)
  }

  private isLive(sessionId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sessions WHERE id = ? AND deleted_at IS NULL`).get(sessionId)
  }

  /** One transaction per chunk, letting the event loop go between them (#179), until `step` says it was the last */
  private async inChunks(step: () => boolean): Promise<void> {
    const once = this.db.transaction(step)
    while (!once()) await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
