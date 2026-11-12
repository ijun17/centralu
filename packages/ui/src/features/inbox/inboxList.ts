import type { InboxItem } from '@cc/core'
import type { MailHeldRow, MailThreadRow } from '@cc/protocol/client'

/**
 * What the inbox draws, in the order it draws it (owner, 2026-11-12, #2213): mail that could not be delivered pinned on
 * top, then what waits on the person, newest first, sessions and mail threads in one list, and under "Earlier" the
 * threads with nothing unread. Derived on every read from the two lists the host and the window keep
 * (docs/state-management.md §3); nothing here is stored.
 *
 * `items` is already newest first (`buildInbox`); a row of the list that is a session keeps its place among the
 * sessions, so the keys' cursor, which counts sessions, and "next waiting" agree with what is on screen.
 */
export type WaitingRow = { kind: 'session'; item: InboxItem; index: number } | { kind: 'mail'; thread: MailThreadRow }

export type InboxList = {
  /** Mail that waits for the person to say what happens to it, the one most recently held first */
  held: MailHeldRow[]
  waiting: WaitingRow[]
  /** Threads with nothing unread: read, or finished, newest first */
  earlier: MailThreadRow[]
}

type Mail = { threads: readonly MailThreadRow[]; held: readonly MailHeldRow[] } | null

/** When a row's wait began: a session row with no start time (a proposal, an app that arrived) came just now */
const sessionAt = (it: InboxItem): number => it.waitingSince ?? Number.MAX_SAFE_INTEGER

export function arrangeInbox(items: readonly InboxItem[], mail: Mail): InboxList {
  const threads = mail?.threads ?? []
  const rows: { at: number; row: WaitingRow }[] = [
    ...items.map((item, index) => ({ at: sessionAt(item), row: { kind: 'session', item, index } as const })),
    ...threads.filter((t) => t.unread > 0).map((thread) => ({ at: thread.updatedAt, row: { kind: 'mail', thread } as const })),
  ]
  return {
    held: [...(mail?.held ?? [])].sort((a, b) => b.since - a.since),
    // A stable sort: a tie keeps the sessions first, in their own order
    waiting: rows.sort((a, b) => b.at - a.at).map((r) => r.row),
    earlier: threads.filter((t) => t.unread === 0).sort((a, b) => b.updatedAt - a.updatedAt),
  }
}
