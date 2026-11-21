import { partyName } from '@cc/core'
import { plainLine } from '@cc/protocol/client'
import type { MailHeldRow, MailMessage, MailParty, MailTaskRow, MailThreadRow, MailThreadView } from '@cc/protocol/client'

/**
 * How the Inbox words the mailbox (#1347, docs/plans/mailbox.md §10.1). The host names the parties and states why mail is held;
 * these only turn those words into the screen's, so a word this build does not know is shown as the host wrote it.
 */

/** The host's state words as the screen says them, for a thread and a task alike; a word this build does not know is shown as the host wrote it */
const STATE_WORDS = new Map([
  ['open', 'Open'],
  ['running', 'Running'],
  ['held', 'Held'],
  ['review', 'In review'],
  ['released', 'Released'],
])
/** How work ends as work ends: finished, answered, reported, marked done. Any other end is said beside Done */
const PLAIN_ENDS = ['finished', 'answered', 'reported', 'done']

/** A state as a word: Done with how it ended, Waiting on you when it waits on the person's answer, else the state's word */
function stateWord(state: string, outcome: string | null, waitsOnYou: boolean): string {
  if (state === 'done') return outcome && !PLAIN_ENDS.includes(outcome) ? `Done (${outcome})` : 'Done'
  if (waitsOnYou) return 'Waiting on you'
  return STATE_WORDS.get(state) ?? state
}

/** The thread's state as a word, with how it ended when it is done; a thread that waits on the person's answer says so (#2229) */
export function threadStateLabel(t: Pick<MailThreadRow, 'state' | 'outcome' | 'ask'>): string {
  return stateWord(t.state, t.outcome, t.ask !== null)
}

/** A task's state as a word (#1577), in the thread's words; a question to the person not answered yet waits on them */
export function taskStateLabel(t: Pick<MailTaskRow, 'state' | 'outcome' | 'assignee'>): string {
  return stateWord(t.state, t.outcome, t.state === 'open' && t.assignee.kind === 'person')
}

/**
 * Why mail waits for the person and what the button that frees it says. A pause (`loop`) is lifted with Resume on the thread; the rest
 * is sent now with `release`.
 */
export function heldLabel(reason: string): { why: string; action: string; kind: 'resume-thread' | 'release' } {
  switch (reason) {
    case 'loop':
      return { why: 'Paused: these messages started many turns without a word from you', action: 'Resume', kind: 'resume-thread' }
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
export function heldResume(row: Pick<MailHeldRow, 'reason' | 'threadId'>): { threadId: string } | null {
  return heldLabel(row.reason).kind === 'resume-thread' ? { threadId: row.threadId } : null
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
 * The thread's questions waiting on the person (#2191) that this view holds, oldest first, as the host names them
 * (`thread.ask.open`, its one rule for what can still be answered and what the person may read)
 */
export function openQuestions(view: Pick<MailThreadView, 'thread' | 'messages'>): MailMessage[] {
  const open = view.thread.ask?.open ?? []
  return view.messages.filter((m) => open.includes(m.id))
}

/**
 * The question the reply box's words answer (the newest by default; no target with only one), and the open ones to
 * switch between. A named question stays named until the words are sent: if another window answered it meanwhile, the
 * host refuses them ("answered", in a toast), so they never go to another question unseen
 */
export function answeringTarget(view: Pick<MailThreadView, 'thread' | 'messages'>, chosen: string | null): { questions: MailMessage[]; target: MailMessage | undefined } {
  const questions = openQuestions(view)
  const named = chosen === null ? undefined : view.messages.find((m) => m.id === chosen)
  return { questions, target: named ?? (questions.length > 1 ? questions.at(-1) : undefined) }
}

/** A question as one line, for the person to tell which is which: the session that asked it and its words */
export function questionLine(m: Pick<MailMessage, 'sender' | 'body'>): string {
  return `${partyName(m.sender)} · “${plainLine(m.body, 120)}”`
}
