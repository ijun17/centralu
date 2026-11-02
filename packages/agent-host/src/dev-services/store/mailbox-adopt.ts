import type Database from 'better-sqlite3'
import { parseAddress } from '../../mail/address.js'
import { wakes } from '../../mail/rules.js'
import { DELEGATION_ORIGINS, toMessage, type MessageKind, type MessageRow, type MessageSql } from './mail.js'
import { factsFrom, RECIPIENT_HOLD_WORDS, type MailFacts, type MailKind } from './mailbox.js'

/*
 * The v61 thread tables read by the build that has the v65 ones (docs/plans/mailbox.md §6.3): mail an older build left
 * pending is moved, and an old thread's history is read. These are the only v61 readers this design keeps until M7.
 */

/** v61 mail older than this is not moved: retention would not have kept it waiting (§6.4) */
const MOVE_WITHIN_MS = 180 * 24 * 60 * 60 * 1000

/**
 * v61 holds carried by a move: the recipient holds but `policy`, which is judged again at drain (§7.4), and the person's
 * `released` (sent as it is, never held again)
 */
const CARRIED_HOLDS = new Set<string>([...RECIPIENT_HOLD_WORDS.filter((w) => w !== 'policy'), 'released'])

type PendingSql = MessageSql & {
  r_recipient: string
  r_due_at: number
  r_attempt_at: number | null
  r_delivered_at: number | null
  r_read_at: number | null
  r_held: string | null
  r_attempts: number
  r_last_error: string | null
  t_project_id: string | null
  t_owner: string
  t_origin: string
}

/** A v61 message's kind in the v65 tables, and whether it waits for an answer */
function kindOf(m: MessageRow, threadOrigin: string): { kind: MailKind; needsReply: boolean } {
  const kinds: Record<MessageKind, MailKind> = { assign: 'message', question: 'message', answer: 'message', note: 'message', report: 'report', notice: 'notice', event: 'notice' }
  if (m.kind === 'assign' && (threadOrigin === 'person' || DELEGATION_ORIGINS.some((o) => o === threadOrigin))) return { kind: 'task', needsReply: false }
  return { kind: kinds[m.kind], needsReply: m.kind === 'question' }
}

/**
 * Moves the v61 receipts still pending into the v65 tables, and marks each old one handled, in one transaction (§6.3):
 * delivered or not, a receipt moved is handled in the old tables, so an older build serving again never delivers it, and
 * a second run finds nothing, and marked read, so the older build's readers of unread mail (`hasMailInHand`, the review
 * clause of `openChildren`) do not count it as work in hand for good. Pending is: not handled, not dismissed by the person, sent within retention, and either not
 * delivered or an unread `question` or `assign`. Each message is copied once under its own id, its rows settled `legacy`
 * (never awaited). Returns how many messages and rows were written
 */
export function movePendingThreadMail(db: Database.Database, now: number): { messages: number; recipients: number } {
  return db
    .transaction(() => {
      const pending = db
        .prepare<[number], PendingSql>(
          `SELECT m.*, r.recipient AS r_recipient, r.due_at AS r_due_at, r.attempt_at AS r_attempt_at, r.delivered_at AS r_delivered_at,
                  r.read_at AS r_read_at, r.held AS r_held, r.attempts AS r_attempts, r.last_error AS r_last_error,
                  t.project_id AS t_project_id, t.owner AS t_owner, t.origin AS t_origin
             FROM mail_receipts r JOIN mail_messages m ON m.id = r.message_id JOIN mail_threads t ON t.id = m.thread_id
            WHERE r.handled_at IS NULL AND COALESCE(r.held, '') <> 'dismissed' AND m.created_at >= ?
              AND (r.delivered_at IS NULL OR (r.read_at IS NULL AND m.kind IN ('question', 'assign')))
            ORDER BY m.thread_id, m.seq, r.recipient`,
        )
        .all(now - MOVE_WITHIN_MS)
      const rootOf = db.prepare<[string], { root_id: string }>(`SELECT root_id FROM mail WHERE id = ?`)
      const insertMail = db.prepare(
        `INSERT OR IGNORE INTO mail (id, sender, sender_project, kind, needs_reply, reply_to, root_id, urgent, body, facts, origin, legacy_thread, created_at)
         VALUES (@id, @sender, @senderProject, @kind, @needsReply, @replyTo, @rootId, @urgent, @body, @facts, @origin, @legacyThread, @createdAt)`,
      )
      const insertRow = db.prepare(
        `INSERT OR IGNORE INTO mail_recipients (message_id, recipient, due_at, attempt_at, delivered_at, read_at, held, attempts, last_error, settled, settled_at)
         VALUES (@messageId, @recipient, @dueAt, @attemptAt, @deliveredAt, @readAt, @held, @attempts, @lastError, 'legacy', @now)`,
      )
      const handled = db.prepare(
        `UPDATE mail_receipts SET handled_at = @now, delivered_at = COALESCE(delivered_at, @now), read_at = COALESCE(read_at, @now) WHERE message_id = @id AND recipient = @recipient`,
      )
      let messages = 0
      let recipients = 0
      for (const p of pending) {
        const m = toMessage(p)
        const sender = parseAddress(m.sender)
        const target = m.replyTo === null ? undefined : rootOf.get(m.replyTo)
        const { kind, needsReply } = kindOf(m, p.t_origin)
        const facts: MailFacts = {
          ...factsFrom(m.facts),
          legacyKind: p.kind,
          ...(wakes(sender?.kind ?? 'session', m) ? {} : { quiet: true }),
          ...(m.needsOwner ? { needsOwner: true } : {}),
        }
        messages += insertMail.run({
          id: m.id,
          sender: m.sender,
          senderProject: m.sender === p.t_owner && sender?.kind === 'session' ? p.t_project_id : null,
          kind,
          needsReply: needsReply ? 1 : 0,
          replyTo: target ? m.replyTo : null,
          rootId: target?.root_id ?? m.id,
          urgent: m.urgent ? 1 : 0,
          body: m.body,
          facts: JSON.stringify(facts),
          origin: m.seq === 1 ? p.t_origin : 'mail',
          legacyThread: m.threadId,
          createdAt: m.createdAt,
        }).changes
        recipients += insertRow.run({
          messageId: m.id,
          recipient: p.r_recipient,
          dueAt: p.r_due_at,
          attemptAt: p.r_attempt_at,
          deliveredAt: p.r_delivered_at,
          readAt: p.r_read_at,
          held: p.r_held !== null && CARRIED_HOLDS.has(p.r_held) ? p.r_held : null,
          attempts: p.r_attempts,
          lastError: p.r_last_error,
          now,
        }).changes
        handled.run({ now, id: m.id, recipient: p.r_recipient })
      }
      return { messages, recipients }
    })
    .immediate()
}

/** A v61 thread's messages before `before` (a `seq`; all when undefined), the last `limit` of them, oldest first: its history, read-only (§6.3) */
export function legacyChain(db: Database.Database, threadId: string, before: number | undefined, limit: number): MessageRow[] {
  return db
    .prepare<[string, number, number], MessageSql>(`SELECT * FROM (SELECT * FROM mail_messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`)
    .all(threadId, before ?? Number.MAX_SAFE_INTEGER, limit)
    .map(toMessage)
}
