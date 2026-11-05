import type Database from 'better-sqlite3'
import { RECIPIENT_HOLDS } from './mailbox.js'
import { toMessage, type MessageRow, type MessageSql } from './mail-types.js'
import { updateRecipientRows } from './rows.js'

/**
 * The few statements of the v64 build's thread mail (`MailRecords`) that `store-mailbox-adopt.test.ts` plays as the older host of a swap: they
 * write and read the old thread tables as that build did, so the test can check what the next build moved and what the older one still reads.
 * Nothing else runs them; the rest of `MailRecords` and its retention sweep went with the thread world's last callers.
 */

type ReceiptSql = {
  message_id: string
  recipient: string
  due_at: number
  attempt_at: number | null
  delivered_at: number | null
  read_at: number | null
  handled_at: number | null
  held: string | null
  attempts: number
  last_error: string | null
}

export type V64Thread = {
  id: string
  home: string
  projectId: string | null
  subject: string
  origin: string
  depth: number
  parentId: string | null
  follows: string[]
  state: string
  owner: string
  assignee: string | null
  next: string | null
  links: Record<string, unknown>
}

export type V64NewMessage = Omit<MessageRow, 'seq' | 'homeSeq'>

export class V64Mail {
  constructor(private readonly db: Database.Database) {}

  insertThread(t: V64Thread, now: number): void {
    this.db
      .prepare(
        `INSERT INTO mail_threads (id, home, project_id, subject, origin, depth, parent_id, follows, state, outcome, owner, assignee, next_step, links, rev,
                                   created_at, updated_at, state_since)
         VALUES (@id, @home, @projectId, @subject, @origin, @depth, @parentId, @follows, @state, NULL, @owner, @assignee, @next, @links, 0, @now, @now, @now)`,
      )
      .run({ ...t, follows: t.follows.length > 0 ? JSON.stringify(t.follows) : null, links: JSON.stringify(t.links), now })
  }

  insertMessage(m: V64NewMessage): MessageRow {
    const next = this.db.prepare<[string], { n: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM mail_messages WHERE thread_id = ?`).get(m.threadId)
    const seq = next?.n ?? 1
    this.db
      .prepare(
        `INSERT INTO mail_messages (id, thread_id, seq, home_seq, sender, kind, urgent, needs_owner, wake, reply_to, body, facts, dedupe_key, created_at)
         VALUES (@id, @threadId, @seq, @seq, @sender, @kind, @urgent, @needsOwner, @wake, @replyTo, @body, @facts, @dedupeKey, @createdAt)`,
      )
      .run({ ...m, seq, urgent: m.urgent ? 1 : 0, needsOwner: m.needsOwner ? 1 : 0, facts: JSON.stringify(m.facts) })
    return { ...m, seq, homeSeq: seq }
  }

  insertReceipt(messageId: string, recipient: string, dueAt: number): void {
    this.db.prepare(`INSERT INTO mail_receipts (message_id, recipient, due_at) VALUES (?, ?, ?)`).run(messageId, recipient, dueAt)
  }

  receiptsOf(messageId: string): ReceiptSql[] {
    return this.db.prepare<[string], ReceiptSql>(`SELECT * FROM mail_receipts WHERE message_id = ? ORDER BY recipient`).all(messageId)
  }

  messagesTail(threadId: string, n: number): MessageRow[] {
    return this.db
      .prepare<[string, number, number], MessageSql>(`SELECT * FROM (SELECT * FROM mail_messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`)
      .all(threadId, Number.MAX_SAFE_INTEGER, n)
      .map(toMessage)
  }

  releaseHeld(recipient: string, messageIds: readonly string[], to: null | 'released' | 'dismissed', dueAt: number): number {
    return updateRecipientRows(
      this.db,
      'mail_receipts',
      `delivered_at = CASE WHEN held IN ('policy', 'budget') THEN NULL ELSE delivered_at END,
               held = CASE WHEN ? IS NULL AND held IN ('policy', 'budget') THEN 'released' ELSE ? END, attempt_at = NULL, last_error = NULL, attempts = 0, due_at = ?`,
      [to, to, dueAt],
      recipient,
      messageIds,
      `held IN ${RECIPIENT_HOLDS}`,
    )
  }

  heldReceipts(): ReceiptSql[] {
    return this.db
      .prepare<[], ReceiptSql>(`SELECT * FROM mail_receipts WHERE held IS NOT NULL AND held NOT IN ('released', 'dismissed') AND read_at IS NULL AND handled_at IS NULL ORDER BY due_at`)
      .all()
  }

  /** The ids of what `recipient` has not read or handled and not yet been delivered, oldest first, as the v64 build's delivery read them */
  pendingIds(recipient: string, now: number): string[] {
    return this.db
      .prepare<[string, number], { message_id: string }>(
        `SELECT r.message_id FROM mail_receipts r JOIN mail_messages m ON m.id = r.message_id JOIN mail_threads t ON t.id = m.thread_id
          WHERE r.recipient = ? AND r.read_at IS NULL AND r.handled_at IS NULL AND (r.held IS NULL OR r.held = 'released') AND r.due_at <= ?
            AND r.delivered_at IS NULL
          ORDER BY m.created_at, m.thread_id, m.seq`,
      )
      .all(recipient, now)
      .map((r) => r.message_id)
  }
}
