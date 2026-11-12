import type { MailHeldRow, MailThreadRow, MailThreadView } from '@cc/protocol/client'

/** The person's mailbox (#1347): the threads the Inbox lists among its rows and the thread open in it. */
export type MailSlice = {
  /**
   * The mailbox as the Inbox lists it: the threads the person is in, the mail held for them to act on, and how
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
  /**
   * The person's words in the open thread; true when it was sent, false (with the host's words in a toast) when it was refused. `answers`: the
   * question whose choice `text` is (a pick, #1630). A pick that fails reads the thread again, whatever the failure was (another window answered
   * first, or the link dropped after the host had taken it), so the choices show what became of the question
   */
  replyMail: (text: string, kind?: 'note' | 'answer' | 'question', answers?: string) => Promise<boolean>
  /**
   * Closes the open thread, or the one `threadId` names (the list's Done, which opens nothing): Mark done (`finished`) or Drop (`dropped`). A session working on it
   * is stopped and told (the host's close, 3.10). True when it closed; false, with the host's words in a toast, when it did not
   */
  closeMail: (outcome?: 'finished' | 'failed' | 'stopped' | 'dropped', threadId?: string) => Promise<boolean>
  /** Sends held mail now, or lets it go */
  heldMail: (action: 'release' | 'dismiss', row: Pick<MailHeldRow, 'recipient' | 'messageId'>) => Promise<boolean>
  /** Lifts a pause for a session's budget, or a thread's turns */
  resumeMail: (target: { sessionId: string } | { threadId: string }) => Promise<boolean>
  /** The answer to "N sessions have mail from while Centralu was off" */
  wakeMail: (wake: boolean) => Promise<boolean>
}
