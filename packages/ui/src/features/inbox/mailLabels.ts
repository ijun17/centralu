import { partyName } from '@cc/core'
import type { MailHeldRow, MailMessage, MailParty, MailThreadRow, MailThreadView } from '@cc/protocol/client'

/**
 * How the Inbox words the mailbox (#1347, docs/plans/mailbox.md §10.1). The host names the parties and states why mail is held;
 * these only turn those words into the screen's, so a word this build does not know is shown as the host wrote it.
 */

/** The thread's state as a word, with how it ended when it is done; a thread that waits on the person's answer says so (#2229) */
export function threadStateLabel(t: Pick<MailThreadRow, 'state' | 'outcome' | 'ask'>): string {
  if (t.state === 'done') return t.outcome && t.outcome !== 'finished' ? `Done (${t.outcome})` : 'Done'
  if (t.ask) return 'Waiting on you'
  switch (t.state) {
    case 'open':
      return 'Open'
    case 'running':
      return 'Running'
    case 'review':
      return 'In review'
    default:
      return t.state
  }
}

/**
 * Why mail waits for the person and what the button that frees it says. A pause (`loop`, `budget`) is lifted with Resume on the
 * thread or the session; the rest is sent now with `release`.
 */
export function heldLabel(reason: string): { why: string; action: string; kind: 'resume-thread' | 'resume-session' | 'release' } {
  switch (reason) {
    case 'loop':
      return { why: 'Paused: these messages started many turns without a word from you', action: 'Resume', kind: 'resume-thread' }
    case 'budget':
      return { why: 'Paused: this session has used its share of turns started by mail', action: 'Resume', kind: 'resume-session' }
    case 'policy':
      return { why: 'Held: this session runs without asking, and this is from a session or an app it has no work with', action: 'Release', kind: 'release' }
    case 'uncertain':
      return { why: 'It may already have reached the session, and the session may already have run it', action: 'Send again', kind: 'release' }
    case 'failed':
      return { why: 'It could not be delivered', action: 'Retry', kind: 'release' }
    default:
      return { why: reason, action: 'Send now', kind: 'release' }
  }
}

/** What the held mail row does when its main button is pressed, as the store's call */
export function heldResume(row: Pick<MailHeldRow, 'reason' | 'threadId' | 'recipient'>): { sessionId: string } | { threadId: string } | null {
  const kind = heldLabel(row.reason).kind
  if (kind === 'resume-thread') return { threadId: row.threadId }
  if (kind === 'resume-session') return row.recipient.sessionId ? { sessionId: row.recipient.sessionId } : null
  return null
}

/** "2 sessions have mail from while Centralu was off" */
export function crowdText(n: number): string {
  return `${n === 1 ? '1 session has' : `${n} sessions have`} mail from while Centralu was off`
}

/** Whether the person's words in a thread are an answer: the last thing anyone else said in it was a question */
export function replyKind(messages: readonly { sender: MailParty; kind: string }[]): 'answer' | 'note' {
  const last = messages.findLast((m) => m.sender.kind !== 'person' && m.sender.kind !== 'centralu' && m.kind !== 'event')
  return last?.kind === 'question' ? 'answer' : 'note'
}

/**
 * Whether closing this thread would stop the turn going on it, so it is asked first. Only a host of an older build does: it stops the turn
 * and says nothing of `canReply`, which a host of this build always sends and which closes without stopping anything
 */
export function closeStopsWork(view: Pick<MailThreadView, 'canReply'> & { thread: Pick<MailThreadRow, 'working'> }): boolean {
  return view.canReply === undefined && view.thread.working === true
}

/** The person's answer to a question: their message that names it (`replyTo`), a choice pressed or words of their own */
export function answerTo(messages: readonly MailMessage[], question: MailMessage): MailMessage | null {
  return messages.find((m) => m.sender.kind === 'person' && m.replyTo === question.id) ?? null
}

/** What the list of a question's choices says it is: to pick from, then what became of it */
export function choicesLabel(answered: boolean, picked: boolean, open: boolean): string {
  if (picked) return 'You chose'
  if (answered) return 'Answered'
  return open ? 'Choose one' : 'Not answered'
}

/**
 * The questions to the person in a thread that wait for their answer (#2191): a session's question that none of their messages names (`answerTo`), oldest first.
 * A reply box offers a choice of which one its words answer when there is more than one; with one, the words answer it as before
 */
export function openQuestions(messages: readonly MailMessage[]): MailMessage[] {
  return messages.filter((m) => m.kind === 'question' && m.sender.kind === 'session' && answerTo(messages, m) === null)
}

/** A question as one line, for the person to tell which is which: the session that asked it and its words */
export function questionLine(m: Pick<MailMessage, 'sender' | 'body'>): string {
  return `${partyName(m.sender)} · “${m.body.replace(/\s+/g, ' ').trim()}”`
}
