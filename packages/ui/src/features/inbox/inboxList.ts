import { waitedAt, type InboxItem } from '@cc/core'
import type { MailHeldRow, MailThreadRow } from '@cc/protocol/client'
import { threadWaits } from '../../store/mail.js'

/**
 * What the inbox draws, in order (#2213): undelivered mail pinned on top, then what waits on the person, sessions and
 * threads in one list newest first, cards waiting on an answer first (#2229), and under "Earlier" threads with nothing
 * unread nor asked. Derived on every read, never stored (docs/state-management.md §3); `items` is newest first already.
 */
export type WaitingRow = { kind: 'session'; item: InboxItem } | { kind: 'mail'; thread: MailThreadRow }

/** What names a row for the cursor: a session's id, or `mail:` and a thread's. The cursor follows the row, not its place, as rows arrive above it */
export const rowKeyOf = (row: WaitingRow): string => (row.kind === 'session' ? row.item.id : `mail:${row.thread.id}`)

/** The cursor: the row it names, and that row's place, which is where it stays when the row leaves */
export type InboxCursor = { key: string | null; row: number }

/** Before the list opens, and after it closes: no row named, the top one */
export const CURSOR_START: InboxCursor = { key: null, row: 0 }

/**
 * Where the cursor is after the rows changed (`keys` in order: Waiting's `rowKeyOf`, Tasks' `taskKey`); the same object
 * when nothing moved, so a caller sets state only on a change. It follows the row it names. When that row leaves (Done,
 * answered) it falls to the row now at its last settled place, or the last row, and names that one from then on: the row
 * that left does not pull it back on return. Nothing named (just opened) takes the top row; a closed list resets it.
 */
export function settleCursor(keys: readonly string[], at: InboxCursor, open: boolean): InboxCursor {
  const first = keys[0]
  if (!open || first === undefined) return at.key === null && at.row === 0 ? at : CURSOR_START
  const found = at.key === null ? -1 : keys.indexOf(at.key)
  const row = found >= 0 ? found : Math.min(at.row, keys.length - 1)
  const key = keys[row] ?? first
  return key === at.key && row === at.row ? at : { key, row }
}

/** Whether a row is a thread that waits on the person's answer: drawn as a card, above the rows */
const asksYou = (row: WaitingRow): boolean => row.kind === 'mail' && row.thread.ask !== null

export type InboxList = {
  /** Mail that waits for the person to say what happens to it, the one most recently held first */
  held: MailHeldRow[]
  waiting: WaitingRow[]
  /** Threads that do not wait on the person (`threadWaits`): read and answered, or finished, newest first */
  earlier: MailThreadRow[]
}

type Mail = { threads: readonly MailThreadRow[]; held: readonly MailHeldRow[] } | null

export function arrangeInbox(items: readonly InboxItem[], mail: Mail): InboxList {
  const threads = mail?.threads ?? []
  const rows: { at: number; row: WaitingRow }[] = [
    ...items.map((item) => ({ at: waitedAt(item), row: { kind: 'session', item } as const })),
    ...threads.filter(threadWaits).map((thread) => ({ at: thread.updatedAt, row: { kind: 'mail', thread } as const })),
  ]
  return {
    held: [...(mail?.held ?? [])].sort((a, b) => b.since - a.since),
    // A stable sort: a tie keeps the sessions first, in their own order
    waiting: rows.sort((a, b) => Number(asksYou(b.row)) - Number(asksYou(a.row)) || b.at - a.at).map((r) => r.row),
    earlier: threads.filter((t) => !threadWaits(t)).sort((a, b) => b.updatedAt - a.updatedAt),
  }
}
