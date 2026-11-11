import type { MailRow, MailboxRecords } from '../dev-services/store/mailbox.js'
import type { ThreadOrigin } from '../dev-services/store/mail-types.js'
import { PERSON } from './address.js'
import type { DelegationOrigin, MessageService } from './messages.js'
import type { TurnReport } from './turn-report.js'
import { refusalReason } from './rules.js'
import type { MailTurns, TurnStart } from './turns.js'

/**
 * What the mailbox does when a session gives another one work through a tool whose delivery the host already makes (`ChildOwnership.delegated`,
 * docs/plans/mailbox.md §9.1): it writes a task from the caller to the child, delivered (the old path delivered the words), and the turn the task
 * started is that task's. Each delegation is its own task. Both are sessions of this host: a child on a linked machine keeps the old path (§14).
 */
export function delegationRecorder(mail: MessageService, turns?: MailTurns): (callerId: string, childId: string, origin: ThreadOrigin, task: string) => void {
  return (callerId, childId, origin, task) => {
    const written = mail.task(mail.sessionAddress(callerId), mail.sessionAddress(childId), { text: task, origin: delegationOrigin(origin), delivered: true })
    turns?.attach(childId, written.id, callerId)
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

/** The caller withdraws what it sent the session and the session has not been given yet (`agent_session stop`): how many tasks */
export function taskWithdrawer(mail: MessageService, records: MailboxRecords): (callerId: string, childId: string) => number {
  return (callerId, childId) => {
    const caller = mail.sessionAddress(callerId)
    const waiting = records.pendingFor(mail.sessionAddress(childId), Number.MAX_SAFE_INTEGER).filter((p) => p.message.sender === caller && p.message.kind === 'task')
    return waiting.reduce((n, p) => n + mail.done(caller, p.message.id).settled, 0)
  }
}

/** The old path's word for where work came from, as a task's origin (§5.2) */
function delegationOrigin(origin: ThreadOrigin): DelegationOrigin {
  return origin === 'start_agent' || origin === 'agent_session' || origin === 'send_to_session' || origin === 'create_session' || origin === 'ask_project' ? origin : 'send_to_session'
}

/**
 * A session a script or the RPC started with a first message (§9.6): the work is the person's, a task from the person whose report lands in their
 * Inbox. Written before the first message goes in, so the turn it starts is reported
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

/** Whether the person has work with the session whose turn is reported to them: an unsettled task from the person */
export function personOwes(mail: MessageService, records: MailboxRecords): (sessionId: string) => boolean {
  return (sessionId) => records.newestTask(PERSON, mail.sessionAddress(sessionId)) !== undefined
}

/** The end of a turn of work the person owns: Centralu's report on the person's task (§9.6); false when there is no such task or it was refused */
export function personReportRecorder(
  mail: MessageService,
  records: MailboxRecords,
  /** The work the session handed on in the person's work that is still owed (§9.4): a turn that ends while it is, is `waiting` */
  waitingOn: (sessionId: string) => number = () => 0,
): (sessionId: string, draft: Pick<ReportDraft, 'outcome' | 'body' | 'answer' | 'error' | 'paused' | 'then'>) => boolean {
  return (sessionId, draft) => {
    const task = records.newestTask(PERSON, mail.sessionAddress(sessionId))
    if (!task) return false
    const owed = draft.then === 'review' && draft.outcome === 'finished' ? waitingOn(sessionId) : 0
    try {
      mail.report(task.id, turnReport(owed > 0 ? { ...draft, outcome: 'paused', then: 'running' } : draft, owed))
      return true
    } catch (e) {
      if (refusalReason(e) !== undefined) return false
      throw e
    }
  }
}

/**
 * The first line of a report on a turn that completed: all the host knows is that the turn ended. Whether the work is done is for the session's own
 * last response to say, or the outcome it recorded itself, so Centralu never says "finished" for it (#1902): a child that gave up says so in its
 * words, and the report must not contradict them
 */
export const TURN_ENDED = "[Centralu] The session ended its turn. Its last response says whether the work is done."

/** What a call gave back: the child's last response, or that its turn did not finish, with the kind of the error (a word of Centralu's) */
export type AnswerGiven = { ok: true; text: string } | { ok: false; error: string }

/** The most of the answer a call returned that the report keeps */
const ANSWER_KEPT = 600

/**
 * What the mailbox does when a call returns the answer of work a session gave another, or reads where it stands (§9.6): the reports on the caller's
 * tasks to the child are read. A call that returned how the turn ended is the report: it is written on the task as told (delivered and read), which
 * settles it, so nothing wakes the caller for news the call already gave
 */
export function answerRecorder(
  mail: MessageService,
  records: MailboxRecords,
  turns?: Pick<MailTurns, 'latest'>,
  /** The work the child handed on in this work that is still owed (§9.4): an answer given while it is, is `waiting`, and the task stays open */
  waitingOn: (ownerId: string, childId: string) => number = () => 0,
): (callerId: string, childId: string, how?: AnswerGiven) => void {
  return (callerId, childId, how) => {
    const owner = mail.sessionAddress(callerId)
    const child = mail.sessionAddress(childId)
    const now = Date.now()
    const reports = records.unreadFor(owner).filter((p) => p.message.kind === 'report' && reportOnTaskTo(records, p.message, owner, child)).map((p) => p.message.id)
    records.markDelivered(owner, reports, now, null)
    records.markRead(owner, reports, now)
    const task = records.newestTask(owner, child)
    if (!how || !task) return
    const read = `read_session(sessionId="${childId}")`
    const waiting = how.ok ? waitingOn(callerId, childId) : 0
    const startedAt = turns?.latest(childId)?.startedAt
    const written = mail.report(task.id, {
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(waiting > 0 ? { outcome: 'waiting' as const, waitingOn: waiting } : { outcome: how.ok ? ('finished' as const) : ('failed' as const) }),
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
 * A turn's end as the mailbox is told it (docs/plans/mailbox.md §9.3): Centralu's own words for the task's sender, with the facts a wake carries
 */
export type ReportDraft = {
  /** One word of Centralu's: finished, failed, limit_reached, network, interrupted, quit, stopped, paused, settled, swapped */
  outcome: string
  /** The report in Centralu's words alone: how it ended, the id, the kind of error, how to go on, and where the session's words are read (#1186) */
  body: string
  /** The session's last response, its own words: kept on the report as its `answer`, never in Centralu's */
  answer?: string
  /** The kind of error the turn ended in */
  error?: string
  /** How many background tasks of the session's own the turn left running */
  paused?: number
  /** A pause's update (#1540): a later turn of the paused work ended with a new answer; where that turn began (`TurnReport.update`) */
  update?: number
  /** The person wrote into the turn */
  personNote?: boolean
  /** What the work is now: reported (`review`), or still going (`running`: paused over its own work or work it handed on) */
  then: 'review' | 'running'
  /** The session is being archived, and archiving stopped the turn this reports: that end is not the work's, and the task is left to `partyGone` */
  archiving?: boolean
  /** The owner is in a turn now: a relayed notice joins it and starts none */
  ownerInTurn?: boolean
  /** How the owner is told: by the mailbox (`wake`), or by the old relayed message (it cannot read mail, `old`) */
  delivery: ReportDelivery
}

/**
 * `wake`: the owner reads mail, so the mailbox tells it: at rest it is woken, in a turn the mail waits for the turn's end. `old`: its seat cannot read
 * mail (a coordinator, a builder, an app's agent), so the old way tells, and holds the notice if it cannot be delivered
 */
export type ReportDelivery = 'wake' | 'old'

/**
 * What the mailbox did with a draft (§9.3): `mailed`, the report is written and the mailbox tells the owner; `closed`, the owner has been told
 * already or needs not be; `none`, there is no task for this work, and the old way tells; an object, the report is written and the old way tells too:
 * when that message is delivered `settle` marks the report delivered, so the mailbox does not wake the owner for it. `keep`: hold the notice if it
 * cannot be delivered
 */
export type ReportedAs = 'mailed' | 'closed' | 'none' | { settle: () => void; keep: boolean }

/** The old path's outcome word as a report's (§5.4), and the word itself as the reason when the two differ */
function outcomeOf(draft: Pick<ReportDraft, 'outcome'>): { outcome: TurnReport['outcome']; reason?: string } {
  const word = draft.outcome
  const outcome: TurnReport['outcome'] =
    word === 'finished' || word === 'settled' ? 'finished' : word === 'failed' || word === 'limit_reached' ? 'failed' : 'stopped'
  return { outcome, ...(word !== outcome ? { reason: word } : {}) }
}

/** A draft as the report the message service writes; `waitingOn` is the work it handed on still owed (§9.4) */
function turnReport(draft: Pick<ReportDraft, 'outcome' | 'body' | 'answer' | 'error' | 'paused' | 'update' | 'personNote' | 'then'>, waitingOn: number): TurnReport {
  const base = { body: draft.body, ...(draft.answer ? { answer: draft.answer } : {}), ...(draft.error ? { error: draft.error } : {}), ...(draft.personNote ? { personNote: true } : {}) }
  if (draft.then === 'running' && draft.paused) return { ...base, outcome: 'paused', paused: draft.paused, ...(draft.update !== undefined ? { update: draft.update } : {}) }
  if (draft.then === 'running') return { ...base, outcome: 'waiting', waitingOn: Math.max(1, waitingOn) }
  return { ...base, ...outcomeOf(draft) }
}

/**
 * The end of the Assistant's turn on a session's request, in Centralu's words (S12). The asking session gets back what the Assistant sent it
 * and nothing else of the turn: not its last response, which may be addressed to the person, nor anything the person wrote into the turn
 */
function askedReportBody(draft: Pick<ReportDraft, 'outcome'>): string {
  return draft.outcome === 'finished'
    ? '[Centralu] The Assistant ended its turn on your request. What it sent you in reply is its answer; if it sent nothing, it had none to give. Its other words in that turn are not passed on.'
    : `[Centralu] The Assistant's turn on your request did not finish (${draft.outcome}). What it sent you in reply, if anything, has reached you. Ask again, or ask the person.`
}

/**
 * Which message a turn's end reports (§9.2): the turn's work message when it is the owner's task to the child or the owner's request to the
 * assistant; else the newest unsettled task from the owner to the child. None: the old path tells
 */
function reportedWork(records: MailboxRecords, turns: Pick<MailTurns, 'latest'>, owner: string, child: string, childId: string): { work: MailRow; request: boolean } | undefined {
  const turnWork = turns.latest(childId)?.messageId
  const work = turnWork == null ? undefined : records.message(turnWork)
  if (work && work.sender === owner && records.recipient(work.id, child)) {
    if (work.kind === 'task') return { work, request: false }
    if (work.kind === 'message') return { work, request: true }
  }
  const task = records.newestTask(owner, child)
  return task && { work: task, request: false }
}

/**
 * What the mailbox does with the end of a turn of delegated work (§9.3): Centralu's report on the task the turn was the work of, for its sender, who
 * is told as mail when it can read it, and the `ReportedAs` the old path acts on. The old path decides that a report is due (D18); this writes it.
 * The end of the Assistant's turn on a request is reported to its asker the same way (S12), and settles that turn's requests (§7.6)
 */
export function reportRecorder(
  mail: MessageService,
  records: MailboxRecords,
  turns: Pick<MailTurns, 'latest'>,
  /** The work the child handed on in this work that is still owed (§9.4): a turn that ends while it is, is `waiting` */
  waitingOn: (ownerId: string, childId: string) => number = () => 0,
): (ownerId: string, childId: string, draft: ReportDraft) => ReportedAs {
  return (ownerId, childId, draft) => {
    const owner = mail.sessionAddress(ownerId)
    const child = mail.sessionAddress(childId)
    const found = reportedWork(records, turns, owner, child, childId)
    if (!found) return 'none'
    // Archiving stopped the turn: the task is `partyGone`'s, which settles it and tells its sender
    if (draft.archiving) return 'closed'
    const { work, request } = found
    let written
    try {
      // A request's report carries none of the Assistant's other words (S12)
      const { answer: _answer, ...unanswered } = draft
      const startedAt = turns.latest(childId)?.startedAt
      const report = request ? { ...turnReport(unanswered, 0), body: askedReportBody(draft) } : turnReport(draft, waitingOn(ownerId, childId))
      written = mail.report(work.id, startedAt === undefined ? report : { ...report, startedAt })
    } catch (e) {
      if (refusalReason(e) !== undefined) return 'none'
      throw e
    }
    // The request turn's end settles every request of that asker it carried (§7.6)
    const seq = turns.latest(childId)?.seq
    if (request && seq !== undefined && draft.then !== 'running') mail.requestTurnEnded(child, owner, seq)
    if ('settledAlready' in written || written.duplicate) return 'closed'
    if (draft.delivery === 'wake') return 'mailed'
    // A later pause does not wake (it is read at the owner's next turn): the old way would start a turn of an owner at rest, so only an owner in a turn is told
    if (!written.first && !draft.ownerInTurn) return 'closed'
    const reportId = written.message.id
    return {
      keep: true,
      settle: () => {
        const now = Date.now()
        records.markDelivered(owner, [reportId], now, null)
        records.markRead(owner, [reportId], now)
      },
    }
  }
}
