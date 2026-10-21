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

/** What a call gave back: the child's last response, or that its turn did not finish, with the kind of the error (a word of Centralu's) */
export type AnswerGiven = { ok: true; text: string } | { ok: false; error: string }

/** The most of the answer a call returned that the thread keeps: the child's own words, as its message, read with the tool */
const ANSWER_KEPT = 600

/**
 * What the mailbox does when a call returns the answer of work a session gave another (§8.1): the call is the report. The reports of the
 * thread that still wait for the caller are read and handled, and a thread that is still `running` is reported on in it (told, with what
 * the call returned) and goes to `review`: the owner decides. Nothing wakes the owner for news a call already gave. A call that only
 * read where the work stands, or an answer of a turn that left background work running, reports nothing new
 */
export function answerRecorder(mail: MailService, records: MailRecords): (callerId: string, childId: string, how?: AnswerGiven) => void {
  return (callerId, childId, how) => {
    const owner = mail.sessionAddress(callerId)
    const child = mail.sessionAddress(childId)
    mail.reportsAnswered(owner, child)
    const thread = records.latestBetween(owner, child)
    if (!how || !thread || thread.state !== 'running') return
    const read = `read_session(sessionId="${childId}")`
    // Centralu's words are its own: how it ended, the id, the kind of error. The session's last response is its own message, behind them
    mail.reportTurn(thread.id, {
      to: owner,
      about: child,
      outcome: how.ok ? 'finished' : 'failed',
      body: how.ok
        ? `[Centralu] The assigned work finished.\nid: ${childId}\n\nIts last response is that session's own words: it is the message above in this thread, and ${read} reads more.`
        : `[Centralu] The assigned work did not finish.\nid: ${childId}\n\nIts tool's error, by kind: ${how.error}. Its words are its tool's, not Centralu's, so they are not repeated here: ${read} shows them.`,
      ...(how.ok ? { answer: how.text.length > ANSWER_KEPT ? `${how.text.slice(0, ANSWER_KEPT)}…` : how.text } : { error: how.error }),
      then: 'review',
      told: true,
    })
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
