import type Database from 'better-sqlite3'
import type { Store } from '../store.js'
import type { MailboxRecords, TurnRecord } from './mailbox.js'

/** A session's turns in `mail_turns`, oldest first, read straight from the table: what a test checks `MailTurns` wrote */
export function turnsOf(of: Store | MailboxRecords, sessionId: string): TurnRecord[] {
  const db = ('mailbox' in of ? of.mailbox : of) as unknown as { db: Database.Database }
  return db.db
    .prepare<[string], { session_id: string; turn_seq: number; message_id: string | null; starter_id: string | null; started_by: string; started_at: number; ended_at: number | null; outcome: string | null }>(
      `SELECT * FROM mail_turns WHERE session_id = ? ORDER BY turn_seq`,
    )
    .all(sessionId)
    .map((r) => ({ sessionId: r.session_id, turnSeq: r.turn_seq, messageId: r.message_id, starterId: r.starter_id, startedBy: r.started_by, startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome }))
}
