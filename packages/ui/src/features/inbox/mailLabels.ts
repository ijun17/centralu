import type { MailHeldRow, MailParty, MailThreadRow } from '@cc/protocol/client'

/**
 * How the Inbox words the mailbox (#1347, docs/plans/mailbox.md §10.1). The host names the parties and states why mail is held;
 * these only turn those words into the screen's, so a word this build does not know is shown as the host wrote it.
 */

/** A party as the screen names it: the person is "You", a session or an app by its name, one that is gone by what it was */
export function partyName(p: MailParty): string {
  switch (p.kind) {
    case 'person':
      return 'You'
    case 'centralu':
      return 'Centralu'
    case 'session':
      return p.name ?? 'A session that is gone'
    case 'app':
      return p.name ?? 'An app'
    default:
      return p.name ?? p.address
  }
}

/** The thread's state as a word, with how it ended when it is done */
export function threadStateLabel(t: Pick<MailThreadRow, 'state' | 'outcome'>): string {
  if (t.state === 'done') return t.outcome && t.outcome !== 'finished' ? `Done (${t.outcome})` : 'Done'
  switch (t.state) {
    case 'open':
      return 'Open'
    case 'running':
      return 'Running'
    case 'review':
      return 'In review'
    case 'blocked':
      return 'Blocked'
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
      return { why: 'Paused: this thread started many turns without a word from you', action: 'Resume', kind: 'resume-thread' }
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

/**
 * Whether the host would take work given to this session (§9.3, §9.1): a session of this computer that is an ordinary one in a project
 * (it has the mail tool), not the orchestrator, a coordinator, a builder or an app's agent, and not one of another machine
 */
export function canGiveWorkTo(s: { kind: string; projectId?: string | null; appId?: string | null; machine?: string | null }): boolean {
  return s.kind === 'worker' && !!s.projectId && !s.appId && !s.machine
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
