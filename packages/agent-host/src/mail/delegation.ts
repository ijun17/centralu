import type { ThreadOrigin } from '../dev-services/store/mail.js'
import type { MailRecords } from '../dev-services/store/mail.js'
import type { MailService } from './service.js'
import type { MailTurns, TurnStart } from './turns.js'

/**
 * What the mailbox does when a session gives another one work through a tool whose delivery the host already makes
 * (`ChildOwnership.delegated`, docs/plans/mailbox.md §8.1): it writes the task down as a thread the caller owns, beside the old
 * path, which stays the way the task reaches the child. Both are sessions of this host: a child on a linked machine keeps the
 * old path until slice 4 and never reaches here.
 */
export function delegationRecorder(
  mail: MailService,
  sessionOf: (id: string) => { projectId?: string | null } | undefined,
  /** The turns the child runs: the one the task started (it began before the thread existed) belongs to the thread from here */
  turns?: MailTurns,
): (callerId: string, childId: string, origin: ThreadOrigin, task: string) => void {
  return (callerId, childId, origin, task) => {
    const { thread } = mail.recordDelegation(mail.sessionAddress(callerId), { assignee: mail.sessionAddress(childId), task, origin, projectId: sessionOf(childId)?.projectId || null })
    turns?.attach(childId, thread.id, callerId)
  }
}

/**
 * What the mailbox does when a turn starts that it did not start (§6): it records whose the turn is and which thread it belongs to,
 * so the turn's end can be told as that thread's. The person's own turn belongs to none, except when they chose to add their message
 * to the task. A caller's message starts a turn of the thread that caller owns with the session; so does the CLI running on after the
 * background work of the turn that paused (the caller is the one a report is still owed to)
 */
export function turnRecorder(mail: MailService, records: MailRecords, turns: MailTurns): (sessionId: string, turn: TurnStart) => void {
  return (sessionId, turn) => {
    const thread = turn.ownerId && (turn.by === 'work' || turn.added) ? records.latestBetween(mail.sessionAddress(turn.ownerId), mail.sessionAddress(sessionId)) : undefined
    const threadId = thread && thread.state !== 'done' ? thread.id : null
    if (turn.by === 'person') turns.beginOther(sessionId, 'person', null)
    else if (turn.added) turns.beginOther(sessionId, 'person', threadId, turn.ownerId)
    // A report or notice about another session starts a turn of its own kind, not of a caller's send (§6 keeps `caller` for that)
    else if (turn.source === 'report') turns.beginOther(sessionId, 'report', null)
    else if (turn.source === 'app') turns.beginOther(sessionId, 'app', null)
    else turns.beginOther(sessionId, turn.cli ? 'cli' : 'caller', threadId, turn.ownerId)
  }
}
