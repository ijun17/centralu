import type { MailHeldRow, MailTaskRow, MailThreadRow, MailThreadView, UnreachedMachine, WatchView } from '@cc/protocol/client'

/** The person's side of the mailbox (#1347, docs/plans/mailbox.md §10.1, docs/protocol.md §3, §5) */
export interface MailPort {
  list(): Promise<{ threads: MailThreadRow[]; held: MailHeldRow[]; waiting: number }>
  tasks(): Promise<{ tasks: MailTaskRow[]; capped: number | null; unreached: UnreachedMachine[] }>
  /**
   * Read for the person from where they last read (or `after`, or `all`). `tail`: the last that many (at most 100),
   * read to the end; with `before`, the page before (`older`: more). `lookIn`: read for nobody (#2333)
   */
  thread(threadId: string, opts?: { after?: number; all?: boolean; tail?: number; before?: number; lookIn?: boolean }): Promise<MailThreadView>
  reply(threadId: string, text: string, kind?: 'note' | 'answer' | 'question', answers?: string): Promise<MailThreadView>
  close(threadId: string, outcome?: 'finished' | 'failed' | 'stopped' | 'dropped'): Promise<MailThreadRow>
  held(action: 'release' | 'dismiss', recipient: string, messageIds: string[]): Promise<{ changed: number }>
  resume(target: { threadId: string }): Promise<void>
  wake(wake: boolean): Promise<void>
  /** For the session's header (#1324, docs/plans/mailbox.md §18.8); changes: `watches_changed`. Older hosts reject */
  watches(sessionId: string): Promise<WatchView[]>
  /** false when it had ended already */
  cancelWatch(id: string): Promise<boolean>
}
