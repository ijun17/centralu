import type Database from 'better-sqlite3'
import type { Store } from '../dev-services/store.js'

/** A recipient's row of a moved message: what its receipt in the old thread said when the step ran */
export type MovedRow = { recipient: string; via?: string; deliveredAt?: number; readAt?: number; held?: string }
/** `kind` is the word the old thread stored (`question`, `answer`, `note`, `assign`, `report`), kept as `facts.legacyKind` */
export type MovedMessage = { id: string; sender: string; kind: string; body: string; replyTo?: string; to: readonly MovedRow[] }

/**
 * The messages store step v75 moved from one old thread, written as that step leaves them (docs/plans/mailbox.md §6.3): each in `mail` under
 * the thread's id (`legacy_thread`), its rows settled `legacy`, so nothing waits on them and no reminder reads them. What the step makes of
 * each old row is `store-contract-step.test.ts`'s to pin; this writes the outcome the live code reads, short of a delegation's task and a
 * message that wakes nobody, which no test here needs
 */
export function movedThread(
  w: { store: Store; reach: { projectOf(address: string): string | null } },
  t: { id: string; origin?: string; at: number },
  messages: readonly MovedMessage[],
): void {
  const settle = (w.store as unknown as { db: Database.Database }).db.prepare(`UPDATE mail_recipients SET settled = 'legacy', settled_at = ? WHERE message_id = ?`)
  for (const [i, m] of messages.entries()) {
    const at = t.at + i
    const released = m.to.filter((r) => r.held === 'released').map((r) => r.recipient)
    w.store.mailbox.insert(
      {
        id: m.id,
        sender: m.sender,
        senderProject: w.reach.projectOf(m.sender),
        kind: m.kind === 'report' ? 'report' : 'message',
        needsReply: m.kind === 'question',
        replyTo: m.replyTo ?? null,
        causeId: null,
        depth: 0,
        urgent: false,
        body: m.body,
        facts: { legacyKind: m.kind, ...(released.length > 0 ? { releasedTo: released } : {}) },
        choices: null,
        subject: null,
        dedupeKey: null,
        origin: i === 0 ? (t.origin ?? 'mail') : 'mail',
        legacyThread: t.id,
        createdAt: at,
      },
      m.to.map((r) => ({ ...r, dueAt: at })),
    )
    settle.run(at, m.id)
  }
}
