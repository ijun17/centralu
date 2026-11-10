import type Database from 'better-sqlite3'
import { parseAddress } from '../../mail/address.js'
import { wakes } from '../../mail/rules.js'
import { DELEGATION_ORIGINS, toMessage, type MessageKind, type MessageRow, type MessageSql } from './mail-types.js'
import { factsFrom, RECIPIENT_HOLD_WORDS, ROLE_VIA, type MailFacts, type MailKind } from './mailbox.js'

/*
 * The v61 thread tables read by the build that has the v65 ones (docs/plans/mailbox.md §6.3): mail an older build left
 * pending is moved, and an old thread's history is read. These are the only v61 readers this design keeps until M7.
 */

/** v61 mail older than this is not moved: retention would not have kept it waiting (§6.4) */
const MOVE_WITHIN_MS = 180 * 24 * 60 * 60 * 1000

/** v61 holds carried by a move: every recipient hold, so the move lets nothing held go, and the person's `released` (sent as it is, never held again) */
const CARRIED_HOLDS = new Set<string>([...RECIPIENT_HOLD_WORDS, 'released'])

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
  t_assignee: string | null
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
 * clause of `openChildren`) do not count it as work in hand for good. Pending is: not handled, not dismissed by the person, sent within retention, and
 * not delivered, not read, or a `question` (read and not answered). Each message is copied once under its own id, its rows settled `legacy` (never
 * awaited). A row to the Assistant in a session's request (the old thread's assignee, the Assistant or a trashed one) is sent to the role
 * (`via`), so the next Assistant takes it (`moveRole`); a task to a trashed session is settled `gone` (its sender was told so). A row the person
 * released is never held again (`releasedTo`). A session's message carries its sender's project (`projectOf`; the old tool left its threads' project empty), so the one hold judges it
 * at drain. Returns how many messages and rows were written
 */
export function movePendingThreadMail(db: Database.Database, now: number, projectOf: (address: string) => string | null): { messages: number; recipients: number } {
  return db
    .transaction(() => {
      const pending = db
        .prepare<[number], PendingSql>(
          `SELECT m.*, r.recipient AS r_recipient, r.due_at AS r_due_at, r.attempt_at AS r_attempt_at, r.delivered_at AS r_delivered_at,
                  r.read_at AS r_read_at, r.held AS r_held, r.attempts AS r_attempts, r.last_error AS r_last_error,
                  t.project_id AS t_project_id, t.owner AS t_owner, t.assignee AS t_assignee, t.origin AS t_origin
             FROM mail_receipts r JOIN mail_messages m ON m.id = r.message_id JOIN mail_threads t ON t.id = m.thread_id
            WHERE r.handled_at IS NULL AND COALESCE(r.held, '') <> 'dismissed' AND m.created_at >= ?
              AND (r.delivered_at IS NULL OR r.read_at IS NULL OR m.kind = 'question')
            ORDER BY m.thread_id, m.seq, r.recipient`,
        )
        .all(now - MOVE_WITHIN_MS)
      const rootOf = db.prepare<[string], { root_id: string }>(`SELECT root_id FROM mail WHERE id = ?`)
      const insertMail = db.prepare(
        `INSERT OR IGNORE INTO mail (id, sender, sender_project, kind, needs_reply, reply_to, root_id, urgent, body, facts, origin, legacy_thread, created_at)
         VALUES (@id, @sender, @senderProject, @kind, @needsReply, @replyTo, @rootId, @urgent, @body, @facts, @origin, @legacyThread, @createdAt)`,
      )
      const insertRow = db.prepare(
        `INSERT OR IGNORE INTO mail_recipients (message_id, recipient, via, due_at, attempt_at, delivered_at, read_at, held, attempts, last_error, settled, settled_at)
         VALUES (@messageId, @recipient, @via, @dueAt, @attemptAt, @deliveredAt, @readAt, @held, @attempts, @lastError, @settled, @now)`,
      )
      /*
       * `is_orchestrator`, not `is_assistant` (#2133): every build that can open a store of v69 writes both equal, and
       * this move also runs on a store from before v68, which has only the old column
       */
      const sessionRow = db.prepare<[string], { assistant: number; trashed: number }>(
        `SELECT is_orchestrator = 1 AND (project_id IS NULL OR deleted_at IS NOT NULL) AS assistant, deleted_at IS NOT NULL AS trashed FROM sessions WHERE id = ?`,
      )
      const sessionOf = (address: string) => {
        const party = parseAddress(address)
        return party?.kind === 'session' ? sessionRow.get(party.sessionId) : undefined
      }
      // The recipients the person released each message to, carried on the message: never held again for them (§6.3)
      const releasedTo = new Map<string, string[]>()
      for (const p of pending) if (p.r_held === 'released') releasedTo.set(p.id, [...(releasedTo.get(p.id) ?? []), p.r_recipient])
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
          ...(releasedTo.has(m.id) ? { releasedTo: releasedTo.get(m.id) } : {}),
        }
        const to = sessionOf(p.r_recipient)
        messages += insertMail.run({
          id: m.id,
          sender: m.sender,
          senderProject: sender?.kind === 'session' ? (projectOf(m.sender) ?? (m.sender === p.t_owner ? p.t_project_id : null)) : null,
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
          via: p.r_recipient === p.t_assignee && to?.assistant === 1 && p.t_owner !== p.r_recipient ? ROLE_VIA : null,
          settled: kind === 'task' && to?.trashed === 1 ? 'gone' : 'legacy',
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

/**
 * What `reader` was shown of a v61 thread before the message `messageId`, the last `limit` of it, oldest first: its own words and the messages
 * delivered to it and not held (§6.3). A later message, or one held from it, is not its to read
 */
export function legacyChainFor(db: Database.Database, threadId: string, messageId: string, reader: string, limit: number): MessageRow[] {
  return db
    .prepare<{ threadId: string; messageId: string; reader: string; limit: number }, MessageSql>(
      `SELECT * FROM (SELECT m.* FROM mail_messages m
                       WHERE m.thread_id = @threadId AND m.seq < (SELECT seq FROM mail_messages WHERE id = @messageId)
                         AND (m.sender = @reader OR EXISTS (SELECT 1 FROM mail_receipts r WHERE r.message_id = m.id AND r.recipient = @reader
                                AND r.delivered_at IS NOT NULL AND COALESCE(r.held, 'released') = 'released'))
                       ORDER BY m.seq DESC LIMIT @limit) ORDER BY seq`,
    )
    .all({ threadId, messageId, reader, limit })
    .map(toMessage)
}

/** A v61 thread's messages before `before` (a `seq`; all when undefined), the last `limit` of them, oldest first: its history, read-only (§6.3) */
export function legacyChain(db: Database.Database, threadId: string, before: number | undefined, limit: number): MessageRow[] {
  return db
    .prepare<[string, number, number], MessageSql>(`SELECT * FROM (SELECT * FROM mail_messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`)
    .all(threadId, before ?? Number.MAX_SAFE_INTEGER, limit)
    .map(toMessage)
}
