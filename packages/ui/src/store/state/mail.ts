import type { MailDelivered, MailHeldRow, MailMessage, MailTaskRow, MailThreadRow, MailThreadView, UnreachedMachine, WatchView } from '@cc/protocol/client'

/** A mail line folded open (#2333): the delivered messages still kept, with their chain's subject, and how many are gone */
export type DeliveredMail = { messages: { message: MailMessage; subject: string; threadId: string }[]; gone: number }

/** The person's mailbox (#1347): the threads the Inbox lists among its rows and the thread open in it. */
export type MailSlice = {
  /** The host's mailbox answer, read again on `mail_changed`; `waiting`: sleeping sessions waiting for the person's word. */
  mail: { threads: MailThreadRow[]; held: MailHeldRow[]; waiting: number } | null
  /**
   * `mail.tasks` for the Inbox's Tasks (#1577), read on opening and on `mail_changed` while open. Null until answered
   * and again after a reconnect. A hub lists linked machines' work too; `unreached` names those missing (#2268).
   */
  mailTasks: { tasks: MailTaskRow[]; capped: number | null; unreached: UnreachedMachine[] } | null
  /** Keeps the last list on a failure */
  loadTasks: () => Promise<void>
  /** The thread open in the Inbox (`mail.thread`); null when the list shows */
  mailThread: MailThreadView | null
  /** Keeps the last list on a failure; quiet for a host with no mailbox */
  loadMail: () => Promise<void>
  /** Reading it marks it read for the person */
  openMailThread: (threadId: string) => Promise<void>
  /**
   * A conversation's mail line (#2333), read as a look in that marks nothing read: it is the session's mail, not the
   * person's. A chain no longer kept counts as gone; a read the link lost throws.
   */
  readDeliveredMail: (delivered: MailDelivered[]) => Promise<DeliveredMail>
  /** A long thread opens at its end; this reads the page before */
  loadOlderMail: () => Promise<void>
  closeMailThread: () => void
  /**
   * To the open thread, or `threadId`'s (a pick on the list's card); false, with the host's words toasted, when refused.
   * `answers`: the question a pick answers (#1630). A failed pick reads the thread again, since another window may have
   * answered or the host may have taken it before the link dropped.
   */
  replyMail: (text: string, kind?: 'note' | 'answer' | 'question', answers?: string, threadId?: string) => Promise<boolean>
  /**
   * The open thread, or `threadId`'s (the list's Done). A session working on it is stopped and told (the host's close,
   * 3.10). False, with the host's words toasted, when it did not close.
   */
  closeMail: (outcome?: 'finished' | 'failed' | 'stopped' | 'dropped', threadId?: string) => Promise<boolean>
  /** Sends held mail now, or lets it go */
  heldMail: (action: 'release' | 'dismiss', row: Pick<MailHeldRow, 'recipient' | 'messageId'>) => Promise<boolean>
  /** Lifts a pause for a thread's turns */
  resumeMail: (target: { threadId: string }) => Promise<boolean>
  /** Answers "N sessions have mail from while Centralu was off" */
  wakeMail: (wake: boolean) => Promise<boolean>
  /** Each session's watches for its header (#1324), read again on `watches_changed`; unlisted: no entry, no badge. */
  watches: Record<string, WatchView[]>
  /** Quiet on failure, keeping what it had */
  loadWatches: (sessionId: string) => Promise<void>
  /** false, with the host's words toasted, when it could not */
  cancelWatch: (sessionId: string, id: string) => Promise<boolean>
}
