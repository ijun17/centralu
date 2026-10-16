import type Database from 'better-sqlite3'
import { asObj } from '../../json-value.js'
import { parseJson } from './json.js'

/** The predecessor a stored handoff marker names; null for any other row, or one that cannot be read */
function handoffFrom(payload: string): string | null {
  const p = asObj(parseJson(payload))
  return p.type === 'handoff' && typeof p.fromSessionId === 'string' && p.fromSessionId ? p.fromSessionId : null
}

/** What the marker messages in a conversation say: a handoff's inheritance, and the notices a session already has */
export class HandoffMarkers {
  constructor(private readonly db: Database.Database) {}

  /**
   * Handoff notes that still **have an owner** — predecessor ids that a live session has
   * recorded inheriting (#106).
   *
   * The note's file name is the predecessor's id (#104). So "the predecessor is gone, so its
   * note can go too" is **wrong**: the last step of a handoff is deleting the predecessor
   * itself, and at that moment the successor has not even opened the note yet. Only the
   * successor's marker knows which file it inherited, so that is where cleanup has to get its
   * evidence.
   *
   * What the JOIN buys: a marker whose session is gone disappears along with it — a dead
   * session cannot hold on to a note.
   */
  handoffPredecessors(): Set<string> {
    /*
     * A successor in the trash still claims its note (#204): restoring it must find the note it was handed, so
     * only deleting it for good lets the note go.
     */
    const rows = this.db
      .prepare(
        `/* includes the trash: a trashed successor keeps its note */
         SELECT m.payload as payload FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.kind = 'marker'`,
      )
      .all() as { payload: string }[]
    const out = new Set<string>()
    for (const r of rows) {
      // A row that cannot be parsed claims nothing — cleanup only holds off when there is a claim
      const from = handoffFrom(r.payload)
      if (from) out.add(from)
    }
    return out
  }

  /**
   * The sessions that inherited a handoff from this one (#738), newest first, trashed ones included with their mark:
   * where a removed session's remaining children go. The same evidence as above, the successor's handoff marker.
   */
  handoffHeirs(fromSessionId: string): { sessionId: string; trashed: boolean }[] {
    /*
     * Filtered in SQL (#740 review): a handoff marker carries its whole note, megabytes, and this runs on every delete.
     * The CASE keeps a row that is not valid JSON from failing the query; it names no heir.
     */
    const rows = this.db
      .prepare(
        `SELECT m.session_id as sessionId, MAX(m.ts) as ts, s.deleted_at IS NOT NULL as trashed
           FROM messages m JOIN sessions s ON s.id = m.session_id
          WHERE m.kind = 'marker'
            AND CASE WHEN json_valid(m.payload)
                  THEN json_extract(m.payload, '$.type') = 'handoff' AND json_extract(m.payload, '$.fromSessionId') = ?
                  ELSE 0 END
          GROUP BY m.session_id ORDER BY ts DESC`,
      )
      .all(fromSessionId) as { sessionId: string; trashed: number }[]
    return rows.map((r) => ({ sessionId: r.sessionId, trashed: !!r.trashed }))
  }

  /**
   * Whether this session already has a stored notice with this text (#304) — so a notice the tool repeats on every
   * start (`oncePerSession`, Codex's configuration warnings) is kept once. Only marker rows are read, and a session has
   * a handful of those; the text is compared after parsing, as stored.
   */
  hasNotice(sessionId: string, text: string): boolean {
    const rows = this.db
      .prepare(`SELECT payload FROM messages WHERE session_id = ? AND kind = 'marker'`)
      .all(sessionId) as { payload: string }[]
    return rows.some((r) => {
      const p = asObj(parseJson(r.payload))
      return p.type === 'notice' && p.text === text
    })
  }

  /**
   * Whether this session inherited a handoff (#142) — asked so that waking it can reopen access to the notes
   * folder it can read from. The same test as above: a handoff marker carrying `fromSessionId`. A session only
   * ever has a handful of markers, so only those are read.
   */
  inheritsHandoff(sessionId: string): boolean {
    const rows = this.db
      .prepare(`SELECT payload FROM messages WHERE session_id = ? AND kind = 'marker'`)
      .all(sessionId) as { payload: string }[]
    return rows.some((r) => handoffFrom(r.payload) !== null)
  }
}
