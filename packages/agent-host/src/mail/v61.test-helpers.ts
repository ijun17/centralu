import type Database from 'better-sqlite3'
import type { Store } from '../dev-services/store.js'

/** A receipt as an older build left it in the v61 tables */
export type OldReceipt = { recipient: string; deliveredAt?: number | null; readAt?: number | null; handledAt?: number | null; held?: string | null }
export type OldMessage = { id: string; sender: string; kind: string; body: string; replyTo?: string; facts?: Record<string, unknown>; receipts: OldReceipt[] }

/**
 * A thread an older build left in the v61 tables, written straight into them as that build stored it (docs/plans/mailbox.md §6.3): what the move reads
 * at ready. Plain SQL, so a test of the switch reads no code of this build's thread service
 */
export function oldThread(
  store: Store,
  t: { id: string; owner: string; assignee?: string; subject?: string; origin?: string; projectId?: string | null; at: number },
  messages: readonly OldMessage[],
): void {
  const db = (store as unknown as { db: Database.Database }).db
  db.prepare(
    `INSERT INTO mail_threads (id, home, project_id, subject, origin, state, owner, assignee, created_at, updated_at, state_since)
     VALUES (?, 'hub-aaaaaaaa', ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
  ).run(t.id, t.projectId ?? null, t.subject ?? t.id, t.origin ?? 'mail', t.owner, t.assignee ?? null, t.at, t.at, t.at)
  const message = db.prepare(
    `INSERT INTO mail_messages (id, thread_id, seq, home_seq, sender, kind, reply_to, body, facts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const receipt = db.prepare(`INSERT INTO mail_receipts (message_id, recipient, due_at, delivered_at, read_at, handled_at, held) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  for (const [i, m] of messages.entries()) {
    const at = t.at + i
    message.run(m.id, t.id, i + 1, i + 1, m.sender, m.kind, m.replyTo ?? null, m.body, JSON.stringify(m.facts ?? {}), at)
    for (const r of m.receipts) receipt.run(m.id, r.recipient, at, r.deliveredAt ?? null, r.readAt ?? null, r.handledAt ?? null, r.held ?? null)
  }
}

/** A session row as the store keeps it, the orchestrator or not, trashed or not: what the move asks of a recipient */
export function oldSession(store: Store, id: string, s: { orchestrator?: boolean; trashedAt?: number; projectId?: string | null }): void {
  const db = (store as unknown as { db: Database.Database }).db
  db.prepare(`INSERT INTO sessions (id, project_id, tool, name, is_orchestrator, created_at, deleted_at) VALUES (?, ?, 'claude', ?, ?, 0, ?)`).run(
    id,
    s.projectId ?? null,
    id,
    s.orchestrator ? 1 : 0,
    s.trashedAt ?? null,
  )
}
