import { waitedAt, type InboxItem } from '@cc/core'
import type { MailHeldRow, MailThreadRow } from '@cc/protocol/client'

/**
 * What the inbox draws, in the order it draws it (owner, 2026-11-12, #2213): mail that could not be delivered pinned on
 * top, then what waits on the person, newest first, sessions and mail threads in one list, and under "Earlier" the
 * threads with nothing unread. Derived on every read from the two lists the host and the window keep
 * (docs/state-management.md §3); nothing here is stored.
 *
 * `items` is already newest first (`buildInbox`). The keys' cursor walks this one list, mail rows included.
 */
export type WaitingRow = { kind: 'session'; item: InboxItem } | { kind: 'mail'; thread: MailThreadRow }

/** What names a row for the cursor: a session's id, or `mail:` and a thread's. The cursor follows the row, not its place, as rows arrive above it */
export const rowKeyOf = (row: WaitingRow): string => (row.kind === 'session' ? row.item.id : `mail:${row.thread.id}`)

/**
 * Where the cursor stands in `rows`: on the row it names, and when that row has left (Done, answered) at the place it
 * was, kept on the last row when that was the last.
 */
export function cursorIndex(rows: readonly WaitingRow[], at: { key: string | null; row: number }): number {
  const found = at.key === null ? -1 : rows.findIndex((r) => rowKeyOf(r) === at.key)
  return found >= 0 ? found : Math.min(at.row, Math.max(rows.length - 1, 0))
}

export type InboxList = {
  /** Mail that waits for the person to say what happens to it, the one most recently held first */
  held: MailHeldRow[]
  waiting: WaitingRow[]
  /** Threads with nothing unread: read, or finished, newest first */
  earlier: MailThreadRow[]
}

type Mail = { threads: readonly MailThreadRow[]; held: readonly MailHeldRow[] } | null

export function arrangeInbox(items: readonly InboxItem[], mail: Mail): InboxList {
  const threads = mail?.threads ?? []
  const rows: { at: number; row: WaitingRow }[] = [
    ...items.map((item) => ({ at: waitedAt(item), row: { kind: 'session', item } as const })),
    ...threads.filter((t) => t.unread > 0).map((thread) => ({ at: thread.updatedAt, row: { kind: 'mail', thread } as const })),
  ]
  return {
    held: [...(mail?.held ?? [])].sort((a, b) => b.since - a.since),
    // A stable sort: a tie keeps the sessions first, in their own order
    waiting: rows.sort((a, b) => b.at - a.at).map((r) => r.row),
    earlier: threads.filter((t) => t.unread === 0).sort((a, b) => b.updatedAt - a.updatedAt),
  }
}
