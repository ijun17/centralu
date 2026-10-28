import type { MailHeldRow, MailThreadRow, MailThreadView } from '@cc/protocol/client'

/**
 * The person's side of the mailbox (#1347, docs/plans/mailbox.md §10.1): what the Inbox lists and shows, the person's words in a
 * thread, and the acts that are theirs. A thread that changes is announced on the event stream as `mail_changed`
 * (`AgentPort.subscribe`), naming the thread; the Inbox reads `list` or `thread` again.
 *
 * Whatever the person writes is theirs by who is asking, not by a field of the call. A rule that says no arrives as an error with
 * the code `refused` and `data.reason` (docs/protocol.md §5). A host from before the mailbox answers "Unknown method".
 */
export interface MailPort {
  /** The threads the person is in (unread first), the mail held for them, and how many sleeping sessions wait for their word */
  list(): Promise<{ threads: MailThreadRow[]; held: MailHeldRow[]; waiting: number }>
  /**
   * One thread from where the person last read (or `after`, or from the start with `all`), read for them. With `tail`, its last that many
   * messages (at most 100), read to the end; with `before` as well, the earlier page of them, whose `older` says whether there is more
   */
  thread(threadId: string, opts?: { after?: number; all?: boolean; tail?: number; before?: number }): Promise<MailThreadView>
  /** The person's words in a thread; answers the new message */
  reply(threadId: string, text: string, kind?: 'note' | 'answer' | 'question'): Promise<MailThreadView>
  close(threadId: string, outcome?: 'finished' | 'failed' | 'stopped' | 'dropped'): Promise<MailThreadRow>
  /** Gives the work to another session, with the words that go with it */
  reassign(threadId: string, sessionId: string, text: string): Promise<MailThreadView>
  /** Resolves a blocker of the thread */
  unblock(threadId: string, n: number): Promise<MailThreadRow>
  /** Sends held mail now (`release`: Release, Resend, Retry) or lets it go undelivered (`dismiss`) */
  held(action: 'release' | 'dismiss', recipient: string, messageIds: string[]): Promise<{ changed: number }>
  /** Lifts a pause: a session whose mail stopped for its budget, or a thread whose mail stopped for its turns (§7.9) */
  resume(target: { sessionId: string } | { threadId: string }): Promise<void>
  /** Answers "N sessions have mail from while Centralu was off": wake them, or leave them for their next turn (§7.9) */
  wake(wake: boolean): Promise<void>
}
