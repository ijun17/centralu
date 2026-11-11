import type { MailRow, MailboxRecords } from '../dev-services/store/mailbox.js'
import type { ThreadOrigin } from '../dev-services/store/mail-types.js'
import { PERSON, parseAddress } from './address.js'
import type { DelegationOrigin, MessageService } from './messages.js'
import { refusalReason } from './rules.js'
import type { MailTurns, TurnStart } from './turns.js'

/**
 * What the mailbox does when a session gives another one work through a tool whose delivery the host already makes (`ChildOwnership.delegated`,
 * docs/plans/mailbox.md §9.1): it writes a task from the caller to the child, delivered (the old path delivered the words), and the turn the task
 * started is that task's. Each delegation is its own task. Both are sessions of this host: a child on a linked machine keeps the old path (§14).
 * Returns how to withdraw the task when its words could not go in after all (start_agent writes it before they go in, §10.6.3).
 */
export function delegationRecorder(mail: MessageService, turns?: MailTurns): (callerId: string, childId: string, origin: ThreadOrigin, task: string) => () => void {
  return (callerId, childId, origin, task) => {
    const caller = mail.sessionAddress(callerId)
    const written = mail.task(caller, mail.sessionAddress(childId), { text: task, origin: delegationOrigin(origin), delivered: true })
    turns?.attach(childId, written.id, callerId)
    return () => void mail.done(caller, written.id)
  }
}

/**
 * A child this host started on a linked machine is gone with notes the hub held for it (#2114, `RemoteAgents.forget`): each is written as the task
 * it was, never delivered, and the child's mail is released `gone` in the same write, so the stop notice tells the caller (mailbox.md §10.6.1)
 */
export function linkedGoneRecorder(mail: MessageService, records: MailboxRecords): (childId: string, callerId: string, notes: readonly string[]) => void {
  return (childId, callerId, notes) =>
    records.transaction(() => {
      for (const text of notes) mail.task(mail.sessionAddress(callerId), mail.sessionAddress(childId), { text, origin: 'agent_session', delivered: false })
      mail.stops.partyGone(mail.sessionAddress(childId))
    })
}

/**
 * A send to a session that cannot take it now (docs/plans/mailbox.md §10.6.2): a task from the caller to the session, not delivered yet, which the
 * delivery gives it as a turn of its own once it is free. Returns the task's id
 */
export function taskSender(mail: MessageService): (callerId: string, childId: string, origin: ThreadOrigin, task: string) => string {
  return (callerId, childId, origin, task) => mail.task(mail.sessionAddress(callerId), mail.sessionAddress(childId), { text: task, origin: delegationOrigin(origin), delivered: false }).id
}

/**
 * The parties with a task open between them and `address` (delivered, not settled, not released): its tasks' senders (`to`; `PERSON` for the person's
 * own work), or its own tasks' receivers (`from`). The one definition of open work by party (`MailHooks.openTasks`, a card's givers, docs/plans/mailbox.md §10.6.4)
 */
export function openTaskParties(records: MailboxRecords, address: string, side: 'to' | 'from'): string[] {
  const rows = side === 'to' ? records.watchedTo(address) : records.watchedFrom(address)
  return [...new Set(rows.flatMap((r) => {
    const m = r.deliveredAt === null || r.releasedAt !== null ? undefined : records.message(r.messageId)
    const other = m?.kind === 'task' ? parseAddress(side === 'to' ? m.sender : r.recipient) : null
    return other?.kind === 'session' ? [other.sessionId] : other?.kind === 'person' ? [PERSON] : []
  }))]
}

/** The caller withdraws what it sent the session and the session has not been given yet (`agent_session stop`): how many tasks */
export function taskWithdrawer(mail: MessageService, records: MailboxRecords): (callerId: string, childId: string) => number {
  return (callerId, childId) => {
    const caller = mail.sessionAddress(callerId)
    const waiting = records.pendingFor(mail.sessionAddress(childId), Number.MAX_SAFE_INTEGER).filter((p) => p.message.sender === caller && p.message.kind === 'task')
    return waiting.reduce((n, p) => n + mail.done(caller, p.message.id).settled, 0)
  }
}

/** The old path's word for where work came from, as a task's origin (§5.2) */
function delegationOrigin(origin: string | null): DelegationOrigin {
  return origin === 'start_agent' || origin === 'agent_session' || origin === 'send_to_session' || origin === 'create_session' || origin === 'ask_project' ? origin : 'send_to_session'
}

/**
 * A session a script or the RPC started with a first message (§9.6): the work is the person's, a task from the person, answered in their Inbox as any
 * task is (docs/plans/mailbox.md §10.6.3). Written before the first message goes in, so the turn it starts is that task's
 */
export function personWorkRecorder(mail: MessageService): (sessionId: string, text: string, fromScript?: { credential: string }) => void {
  return (sessionId, text, fromScript) => {
    mail.task(PERSON, mail.sessionAddress(sessionId), { text, origin: fromScript ? 'script' : 'create_session', delivered: true, ...(fromScript ? { fromScript } : {}) })
  }
}

/** The work a script started never began: its first message could not go in (#1463). The person's task is withdrawn, so their Inbox does not show it running */
export function personWorkWithdrawer(mail: MessageService, records: MailboxRecords): (sessionId: string) => void {
  return (sessionId) => {
    const task = records.newestTask(PERSON, mail.sessionAddress(sessionId))
    if (task) mail.done(PERSON, task.id)
  }
}

/**
 * The first line of a report on a turn that completed: all the host knows is that the turn ended. Whether the work is done is for the session's own
 * last response to say, or the outcome it recorded itself, so Centralu never says "finished" for it (#1902): a child that gave up says so in its
 * words, and the report must not contradict them
 */
export const TURN_ENDED = "[Centralu] The session ended its turn. Its last response says whether the work is done."
/** The same line for the person, on their own work: one line, with nothing to call (§10.6.3) */
export const PERSON_TURN_ENDED = '[Centralu] The session you started ended its turn. Its last response says whether the work is done.'

/** What a call gave back: the child's last response, or that its turn did not finish, with the kind of the error (a word of Centralu's) */
export type AnswerGiven = { ok: true; text: string } | { ok: false; error: string }

/** The most of the answer a call returned that the report keeps */
const ANSWER_KEPT = 600

/**
 * What the mailbox does when a call returns the answer of work a session gave another, or reads where it stands (§9.6): the reports on the caller's
 * tasks to the child are read. A call that returned how the turn ended is the report: it is written on the task as told (delivered and read), which
 * settles it, so nothing wakes the caller for news the call already gave
 */
export function answerRecorder(mail: MessageService, records: MailboxRecords): (callerId: string, childId: string, how?: AnswerGiven) => void {
  return (callerId, childId, how) => {
    const owner = mail.sessionAddress(callerId)
    const child = mail.sessionAddress(childId)
    const now = Date.now()
    const reports = records.unreadFor(owner).filter((p) => p.message.kind === 'report' && reportOnTaskTo(records, p.message, owner, child)).map((p) => p.message.id)
    records.markDelivered(owner, reports, now, null)
    records.markRead(owner, reports, now)
    const task = records.newestTask(owner, child)
    // Work the child handed on in it is still open (§9.4): the task stays open, and the turn that work's answer starts answers it (§10.6.3)
    if (!how || !task || (how.ok && records.handedOn(task.id).length > 0)) return
    const read = `read_session(sessionId="${childId}")`
    const written = mail.report(task.id, {
      outcome: how.ok ? ('finished' as const) : ('failed' as const),
      body: how.ok
        ? `${TURN_ENDED}\nid: ${childId}\n\nIts last response is that session's own words, so it is not repeated here: ${read} reads it.`
        : `[Centralu] The assigned work did not finish.\nid: ${childId}\n\nIts tool's error, by kind: ${how.error}. Its words are its tool's, not Centralu's, so they are not repeated here: ${read} shows them.`,
      ...(how.ok ? { answer: how.text.length > ANSWER_KEPT ? `${how.text.slice(0, ANSWER_KEPT)}…` : how.text } : { error: how.error }),
    })
    if ('message' in written) {
      records.markDelivered(owner, [written.message.id], now, null)
      records.markRead(owner, [written.message.id], now)
    }
  }
}

/** Whether `report` is Centralu's report on a task `owner` gave `child` */
function reportOnTaskTo(records: MailboxRecords, report: MailRow, owner: string, child: string): boolean {
  const task = report.replyTo === null ? undefined : records.message(report.replyTo)
  return task?.kind === 'task' && task.sender === owner && records.recipient(task.id, child) !== undefined
}

/**
 * What the mailbox does when a turn starts that it did not start: whose the turn is and which task it is the work of, so its end can be reported as
 * that task's. The person's own turn belongs to none. A caller's message starts a turn of
 * the task that caller gave; so does the CLI running on after the background work of the turn that paused (a report is still owed to the caller)
 */
export function turnRecorder(mail: MessageService, records: MailboxRecords, turns: MailTurns): (sessionId: string, turn: TurnStart) => void {
  return (sessionId, turn) => {
    const child = mail.sessionAddress(sessionId)
    const taskId = turn.ownerId && turn.by === 'work' ? (records.newestTask(mail.sessionAddress(turn.ownerId), child)?.id ?? null) : null
    const personWork = (): string | null => (turn.ownerId ? null : (records.newestTask(PERSON, child)?.id ?? null))
    // Decided again by the input the tool named (#1639): the same turn's row is corrected, not a new one begun
    const record = (by: Parameters<MailTurns['beginOther']>[1], messageId: string | null, owner?: string) =>
      turn.again ? turns.restate(sessionId, by, messageId, owner) : turns.beginOther(sessionId, by, messageId, owner)
    if (turn.by === 'person') record('person', null)
    // A report or notice about another session starts a turn of its own kind, not of a caller's send
    else if (turn.source === 'report') record('report', null)
    else if (turn.source === 'app') record('app', null)
    // The turn the person's own work starts is that task's: work handed on in it is caused by it, and its end waits for that work (§9.4)
    else {
      // The person's work has no caller's message behind its first turn (a script's or the RPC's first message reads as the CLI's own): it is the
      // person's task's turn all the same, started by the task, so what it hands on is caused by it (§9.4)
      const person = taskId === null ? personWork() : null
      record(turn.cli && person === null ? 'cli' : 'caller', taskId ?? person, turn.ownerId)
    }
  }
}

/**
 * The end of the Assistant's turn on a session's request, in Centralu's words (S12). The asking session gets back what the Assistant sent it
 * and nothing else of the turn: not its last response, which may be addressed to the person, nor anything the person wrote into the turn
 */
const ASKED_REPORT =
  '[Centralu] The Assistant ended its turn on your request. What it sent you in reply is its answer; if it sent nothing, it had none to give. Its other words in that turn are not passed on.'

/**
 * The Assistant's turn ended as a turn does (§7.6, docs/plans/mailbox.md §10.6.3): each session whose request it carried (`requestsIn`, the store's rows
 * of that turn) is told it ended (S12), replying to its request, and its requests in the turn are settled. A stop releases them instead (the stop notice)
 */
export function requestTurnRecorder(mail: MessageService, turns: Pick<MailTurns, 'latest'>, addressOf: (sessionId: string) => string): (assistantId: string) => void {
  return (assistantId) => {
    const turn = turns.latest(assistantId)
    if (!turn) return
    const assistant = addressOf(assistantId)
    const read = { turnSeq: turn.seq, by: 'mail' as const, messageId: turn.messageId }
    for (const { asker, messageId } of mail.requestsIn(assistant, read)) {
      try {
        mail.report(messageId, { outcome: 'finished', body: ASKED_REPORT })
      } catch (e) {
        if (refusalReason(e) === undefined) throw e
      }
      mail.requestTurnEnded(assistant, asker, turn.seq)
    }
  }
}

/**
 * A handoff gives the successor the children the original gave work (docs/plans/mailbox.md §10.6.3, until step 5 moves handoffs onto `handOver`):
 * the open tasks the original gave the child are withdrawn and one task from the successor, with the newest one's words, is written delivered, so
 * the child's reply or last response answers the successor
 */
export function taskRepointer(mail: MessageService, records: MailboxRecords): (fromId: string, toId: string, childId: string) => void {
  return (fromId, toId, childId) => {
    const [from, child] = [mail.sessionAddress(fromId), mail.sessionAddress(childId)]
    records.transaction(() => {
      const open = records.watchedTo(child).flatMap((r) => {
        const m = r.deliveredAt === null ? undefined : records.message(r.messageId)
        return m?.kind === 'task' && m.sender === from ? [m] : []
      })
      const newest = open.at(-1)
      if (!newest) return
      for (const m of open) mail.done(from, m.id)
      mail.task(mail.sessionAddress(toId), child, { text: newest.body, origin: delegationOrigin(newest.origin), delivered: true })
    })
  }
}
