import type { MailHeldRow, MailThreadRow, MailThreadView } from '@cc/protocol/client'

/** The person's mailbox (#1347): the Inbox's Mail section and the thread open in it. */
export type MailSlice = {
  /**
   * The mailbox as the Inbox lists it: the threads the person is in (unread first), the mail held for them to act on, and how
   * many sleeping sessions wait for their word. A copy of the host's answer, read again when `mail_changed` says something
   * moved. Null until read.
   */
  mail: { threads: MailThreadRow[]; held: MailHeldRow[]; waiting: number } | null
  /** The thread open in the Inbox, with the messages read so far (`mail.thread`); null when the list shows */
  mailThread: MailThreadView | null
  /** Reads the list again; keeps the last one on a failure, and is quiet for a host that has no mailbox */
  loadMail: () => Promise<void>
  /** Opens a thread in the Inbox: reads it (which reads it for the person) and shows it */
  openMailThread: (threadId: string) => Promise<void>
  /** Reads the page of messages before the first one held (a long thread opens at its end) */
  loadOlderMail: () => Promise<void>
  /** Back to the list */
  closeMailThread: () => void
  /** The person's words in the open thread; true when it was sent, false (with the host's words in a toast) when it was refused */
  replyMail: (text: string, kind?: 'note' | 'answer' | 'question') => Promise<boolean>
  /** Closes the open thread with an outcome */
  closeMail: (outcome?: 'finished' | 'failed' | 'stopped' | 'dropped') => Promise<boolean>
  /** Resolves one blocker of the open thread */
  unblockMail: (n: number) => Promise<boolean>
  /** Gives the open thread to another session */
  reassignMail: (sessionId: string, text: string) => Promise<boolean>
  /** Sends held mail now, or lets it go */
  heldMail: (action: 'release' | 'dismiss', row: Pick<MailHeldRow, 'recipient' | 'messageId'>) => Promise<boolean>
  /** Lifts a pause for a session's budget, or a thread's turns */
  resumeMail: (target: { sessionId: string } | { threadId: string }) => Promise<boolean>
  /** The answer to "N sessions have mail from while Centralu was off" */
  wakeMail: (wake: boolean) => Promise<boolean>
}
