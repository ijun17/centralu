import type { MailRow, MailboxRecords } from '../dev-services/store/mailbox.js'
import type { ThreadOrigin } from '../dev-services/store/mail-types.js'
import { PERSON, isPerson, parseAddress } from './address.js'
import type { DelegationOrigin, MessageService, TaskAcross } from './messages.js'
import { refusalReason } from './rules.js'
import type { MailTurns, TurnStart } from './turns.js'
import type { AcrossSent } from './across-core.js'
import type { MailAcross } from './across.js'
import { raceBound } from '../timing.js'
import { ANSWER_KEPT_CHARS, answerKept, clipped, reportWords } from './last-response.js'

/**
 * What the mailbox does when a session gives another one work through a tool whose delivery the host already makes (`ChildOwnership.delegated`,
 * docs/plans/mailbox.md §9.1): it writes a task from the caller to the child, delivered (the old path delivered the words), and the turn the task
 * started is that task's. Each delegation is its own task. Both are sessions of this host: work for a session on a linked machine crosses as a task (`LinkedTasks`).
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

/** How a task given a session on another computer stands, as its copy here says (`LinkedTasks.standing`) */
export type TaskStanding =
  | { state: 'open' }
  /** Centralu's report on it came back from the other side: how its turn ended (`TurnReport`'s facts), and to whom it was written */
  | { state: 'reported'; outcome: string; answer?: string; error?: string; reason?: string; owner: string }
  /** It ended with no report: withdrawn here, or released there (a stop, the session gone), as the other side's receipts say */
  | { state: 'ended'; why: string }

/** Why a task across did not finish, as its standing says (ended with no report, or a report that it failed or was stopped), or null */
export function unfinished(s: TaskStanding): string | null {
  if (s.state === 'ended') return `its task there ended with no report (${s.why})`
  return s.state === 'reported' && (s.outcome === 'failed' || s.outcome === 'stopped') ? (s.error ?? s.reason ?? s.outcome) : null
}

/**
 * Work a session here gives a session on another computer (#1948 step 6, docs/plans/mailbox.md §10.6): a task across the link (`MailAcross.sendTask`), which
 * that computer's delivery gives the session and its engine reports; the report comes back as a local child's, answering the copy here. What start_agent,
 * agent_session, send_to_session and ask_project read and do of it, by session id (a hub's session, on a machine, by its address)
 */
export type LinkedTasks = {
  send(callerId: string, childId: string, text: string, task: TaskAcross): Promise<AcrossSent>
  /** The caller's newest task to the child that is not settled, by id */
  open(callerId: string, childId: string): string | undefined
  standing(taskId: string): TaskStanding
  /** Waits up to `boundMs` for the task to stand otherwise than open, or for `until`: `bound` past it, `aborted` when `signal` ends the wait */
  settled(taskId: string, boundMs: number, o?: { signal?: AbortSignal | undefined; until?: Promise<void> }): Promise<'settled' | 'bound' | 'aborted'>
  /**
   * The caller's ask_project tasks, newest first: open, or reported to a caller not given the report yet. The session each went to by its id as this host
   * names it (a linked machine's `<machine>.<id>`, a hub's `<hub>.<id>`), and its name
   */
  asks(callerId: string): { taskId: string; sessionId: string; name: string }[]
  /** Why work cannot go to a linked machine's session now (`MailAcross.taskRefusal`), or null */
  refusal(childId: string): string | null
  /** On a machine: the copy of the task a hub wrote for the caller's ask (`HubAskResult.taskId`) to its session `to`, so the report it sends answers it */
  keep(callerId: string, to: string, taskId: string, text: string): void
  /** As `MailAcross.holdReports` */
  holdReports(taskId: string): (carried: boolean) => void
  /** On a hub: the asks not given yet of the sessions whose ids start with `prefix` (a machine's, `<machine>.`) are withdrawn, as its switch goes off (#550). How many */
  withdrawAsks(prefix: string): number
  /** The answer the newest report on the caller's tasks to the child kept, if one came back */
  lastAnswer(callerId: string, childId: string): string | undefined
  /** The caller withdraws its open tasks to the child (`agent_session stop`); the withdrawal crosses by the receipts. How many */
  withdraw(callerId: string, childId: string): number
  /** The child is gone for good with its machine (removed from Centralu): its tasks are released `gone`, so the stop notice tells their senders */
  gone(childId: string): void
}

/** How many of the latest messages to or from a linked child `lastAnswer` reads for the caller's newest task */
const LAST_ANSWER_SCAN = 50

export function linkedTasksOf(mail: MessageService, records: MailboxRecords, across: Pick<MailAcross, 'sendTask' | 'taskRefusal' | 'keepAsk' | 'holdReports'>, changes: (listener: () => void) => () => void): LinkedTasks {
  const tasksTo = (caller: string, child: string) => records.watchedFrom(caller).filter((r) => r.recipient === child && records.message(r.messageId)?.kind === 'task')
  const standing = (taskId: string): TaskStanding => {
    const report = records.reportsOn(taskId).at(-1)
    if (report) {
      const f = report.facts
      const [answer, error, reason] = [f.answer, f.error, f.reason]
      return {
        state: 'reported', outcome: typeof f.outcome === 'string' ? f.outcome : 'finished', owner: records.recipients(report.id)[0]?.recipient ?? '',
        ...(typeof answer === 'string' ? { answer } : {}), ...(typeof error === 'string' ? { error } : {}), ...(typeof reason === 'string' ? { reason } : {}),
      }
    }
    // A task across has one recipient, the session there; none once a held one was dropped or refused
    const row = records.recipients(taskId)[0]
    if (row && row.settled === null && row.releasedAt === null) return { state: 'open' }
    return { state: 'ended', why: row?.releasedWhy ?? row?.settled ?? 'gone' }
  }
  return {
    send: (callerId, childId, text, task) => across.sendTask(callerId, mail.sessionAddress(childId), text, task),
    open: (callerId, childId) => records.newestTask(mail.sessionAddress(callerId), childId.startsWith('session:') ? childId : mail.sessionAddress(childId))?.id,
    standing,
    settled: async (taskId, boundMs, o = {}) => {
      let end!: () => void
      const ended = new Promise<void>((resolve) => (end = resolve))
      const check = () => {
        if (standing(taskId).state !== 'open') end()
      }
      // Told inside the write that changed a row: read once it is done
      const off = changes(() => queueMicrotask(check))
      check()
      try {
        const r = await raceBound(o.until ? Promise.race([ended, o.until]) : ended, boundMs, o.signal)
        return r === 'bound' || r === 'aborted' ? r : 'settled'
      } finally {
        off()
      }
    },
    asks: (callerId) => {
      const caller = mail.sessionAddress(callerId)
      const here = parseAddress(caller)
      const ask = (id: string | null) => {
        const m = id === null ? undefined : records.message(id)
        const to = m?.kind === 'task' && m.origin === 'ask_project' && m.sender === caller ? records.recipients(m.id)[0]?.recipient : undefined
        const p = to ? parseAddress(to) : null
        if (!m || !to || p?.kind !== 'session' || here?.kind !== 'session') return []
        return [{ taskId: m.id, sessionId: p.host === here.host ? p.sessionId : `${p.host}.${p.sessionId}`, name: mail.labelOf(to), at: m.createdAt }]
      }
      const found = [
        ...records.watchedFrom(caller).flatMap((r) => ask(r.messageId)),
        ...records.pendingFor(caller, Number.MAX_SAFE_INTEGER).flatMap((p) => (p.message.kind === 'report' ? ask(p.message.replyTo) : [])),
      ]
      return found.filter((a, i) => found.findIndex((b) => b.taskId === a.taskId) === i).sort((a, b) => b.at - a.at).map(({ at: _at, ...a }) => a)
    },
    refusal: (childId) => across.taskRefusal(mail.sessionAddress(childId))?.text ?? null,
    keep: (callerId, to, taskId, text) => across.keepAsk(mail.sessionAddress(callerId), to, taskId, text),
    holdReports: (taskId) => across.holdReports(taskId),
    withdrawAsks: (prefix) => {
      const from = mail.sessionAddress(prefix)
      const waiting = records.dueRecipients().flatMap((r) => records.pendingFor(r, Number.MAX_SAFE_INTEGER).map((p) => p.message))
      return waiting.filter((m) => m.kind === 'task' && m.origin === 'ask_project' && m.sender.startsWith(from)).reduce((n, m) => n + mail.done(m.sender, m.id).settled, 0)
    },
    lastAnswer: (callerId, childId) => {
      const [caller, child] = [mail.sessionAddress(callerId), mail.sessionAddress(childId)]
      const task = records.feedOf(child, { limit: LAST_ANSWER_SCAN }).find((m) => m.kind === 'task' && m.sender === caller)
      const answer = task ? records.reportsOn(task.id).at(-1)?.facts.answer : undefined
      return typeof answer === 'string' ? answer : undefined
    },
    withdraw: (callerId, childId) => {
      const caller = mail.sessionAddress(callerId)
      return tasksTo(caller, mail.sessionAddress(childId)).reduce((n, r) => n + mail.done(caller, r.messageId).settled, 0)
    },
    gone: (childId) => mail.stops.partyGone(mail.sessionAddress(childId)),
  }
}


/**
 * A send to a session that cannot take it now (docs/plans/mailbox.md §10.6.2): a task from the caller to the session, not delivered yet, which the
 * delivery gives it as a turn of its own once it is free; a `note` (#2258) at rest too. Returns the message's id
 */
export function taskSender(mail: MessageService): (callerId: string, childId: string, origin: ThreadOrigin, task: string, note?: boolean, depth?: number) => string {
  return (callerId, childId, origin, task, note, depth) =>
    mail.task(mail.sessionAddress(callerId), mail.sessionAddress(childId), { text: task, origin: delegationOrigin(origin), delivered: false, ...(note ? { note } : {}), ...(depth ? { depth } : {}) }).id
}

/**
 * The parties with a task open between them and `address` (delivered, not settled, not released): its tasks' senders (`to`; `PERSON` for the person's
 * own work), or its own tasks' receivers (`from`). The one definition of open work by party (`MailHooks.openTasks`, a card's givers, docs/plans/mailbox.md §10.6.4).
 * A session of another computer that gave work here (#1948 step 6) is no session here, whatever its id: left out, or with `across` named by its address
 */
export function openTaskParties(records: MailboxRecords, address: string, side: 'to' | 'from', o: { across?: boolean } = {}): string[] {
  const rows = side === 'to' ? records.watchedTo(address) : records.watchedFrom(address)
  const here = parseAddress(address)
  return [...new Set(rows.flatMap((r) => {
    const m = r.deliveredAt === null || r.releasedAt !== null ? undefined : records.message(r.messageId)
    const party = m?.kind === 'task' ? (side === 'to' ? m.sender : r.recipient) : ''
    const other = parseAddress(party)
    if (other?.kind === 'person') return [PERSON]
    if (other?.kind !== 'session' || here?.kind !== 'session') return []
    if (other.host === here.host) return [other.sessionId]
    // The person of a hub that links this host is the person (`isPerson`)
    return !o.across ? [] : isPerson(party) ? [PERSON] : [party]
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

/** What a call gave back: the child's last response, or that its turn did not finish, with the kind of the error (a word of Centralu's) */
export type AnswerGiven = { ok: true; text: string } | { ok: false; error: string }

/**
 * What the mailbox does when a call returns the answer of work a session gave another, or reads where it stands (§9.6): the reports on the caller's
 * tasks to the child are read. A call that returned how the turn ended is the report: it is written on the task as told (delivered and read), which
 * settles it, so nothing wakes the caller for news the call already gave
 */
export function answerRecorder(mail: MessageService, records: MailboxRecords): (callerId: string, childId: string, how?: AnswerGiven) => void {
  return (callerId, childId, how) => {
    const owner = mail.sessionAddress(callerId)
    // A hub's session a machine asked (`LinkedTasks.keep`), by its address
    const child = childId.startsWith('session:') ? childId : mail.sessionAddress(childId)
    const now = Date.now()
    const reports = records.unreadFor(owner).filter((p) => p.message.kind === 'report' && reportOnTaskTo(records, p.message, owner, child)).map((p) => p.message.id)
    records.markDelivered(owner, reports, now, null)
    records.markRead(owner, reports, now)
    const task = records.newestTask(owner, child)
    // Work the child handed on in it is still open (§9.4): the task stays open, and the turn that work's answer starts answers it (§10.6.3)
    if (!how || !task || (how.ok && records.handedOn(task.id).length > 0)) return
    const outcome = how.ok ? ('finished' as const) : ('failed' as const)
    const answer = how.ok ? clipped(how.text, ANSWER_KEPT_CHARS) : undefined
    const written = mail.report(task.id, {
      outcome,
      body: reportWords(childId, { outcome, answer: answerKept(answer, ANSWER_KEPT_CHARS), ...(how.ok ? {} : { kind: how.error }) }),
      ...(how.ok ? { answer } : { error: how.error }),
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
    const personWork = (): string | null => (turn.ownerId || turn.unowned ? null : (records.newestTask(PERSON, child)?.id ?? null))
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

