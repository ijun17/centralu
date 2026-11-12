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

/** The cursor: the row it names, and that row's place, which is where it stays when the row leaves */
export type InboxCursor = { key: string | null; row: number }

/** Before the list opens, and after it closes: no row named, the top one */
export const CURSOR_START: InboxCursor = { key: null, row: 0 }

/**
 * Where the cursor is after `rows` changed, given where it was (the same object when nothing moved, so a caller sets state
 * only on a change). It is on the row it names, and its place follows that row as rows arrive above it. When the row has
 * left (Done, answered) it falls to the row now at the place it had in the list it was last settled on, the last row when
 * that was the last, and it names that row from then on: the row that left does not pull it back when it returns. No row
 * named (the list just opened) takes the top row; a list with no rows takes none, and a closed one resets it.
 */
export function settleCursor(rows: readonly WaitingRow[], at: InboxCursor, open: boolean): InboxCursor {
  const first = rows[0]
  if (!open || !first) return at.key === null && at.row === 0 ? at : CURSOR_START
  const found = at.key === null ? -1 : rows.findIndex((r) => rowKeyOf(r) === at.key)
  const row = found >= 0 ? found : Math.min(at.row, rows.length - 1)
  const key = rowKeyOf(rows[row] ?? first)
  return key === at.key && row === at.row ? at : { key, row }
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
