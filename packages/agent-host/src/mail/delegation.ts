import { CENTRALU, PERSON, parseAddress } from './address.js'
import type { MailRecords, ThreadOrigin, ThreadRow } from '../dev-services/store/mail.js'
import { refusalReason } from './rules.js'
import type { ClosingHooks, MailService } from './service.js'
import type { MailTurns, TurnStart } from './turns.js'

/**
 * What the mailbox does when a session gives another one work through a tool whose delivery the host already makes
 * (`ChildOwnership.delegated`, docs/plans/mailbox.md §8.1): it writes the task down as a thread the caller owns, beside the old
 * path, which stays the way the task reaches the child. Both are sessions of this host: a child on a linked machine keeps the
 * old path until slice 4 and never reaches here.
 */
export function delegationRecorder(
  mail: MailService,
  sessionOf: (id: string) => { projectId?: string | null; /** The agent depth it was started at (#867) */ depth?: number } | undefined,
  /** The turns the child runs: the one the task started (it began before the thread existed) belongs to the thread from here */
  turns?: MailTurns,
): (callerId: string, childId: string, origin: ThreadOrigin, task: string) => void {
  return (callerId, childId, origin, task) => {
    // Handed on in the middle of the work of a thread of its own: this thread is that one's child (§6)
    const parentId = turns?.current(callerId)?.threadId ?? null
    const { thread } = mail.recordDelegation(mail.sessionAddress(callerId), {
      assignee: mail.sessionAddress(childId),
      task,
      origin,
      projectId: sessionOf(childId)?.projectId || null,
      parentId,
      depth: sessionOf(childId)?.depth ?? 0,
    })
    turns?.attach(childId, thread.id, callerId)
  }
}

/**
 * A session a script or the RPC started with a first message (`create_session` by a connection with the limited credential, §8.1): the work is the
 * person's, whose Inbox the report lands in. Written before the first message goes in, so the turn it starts is reported
 */
export function personWorkRecorder(
  mail: MailService,
  sessionOf: (id: string) => { projectId?: string | null; depth?: number } | undefined,
): (sessionId: string, text: string, fromScript?: { credential: string }) => void {
  return (sessionId, text, fromScript) => {
    mail.recordDelegation(PERSON, {
      ...(fromScript ? { fromScript } : {}),
      assignee: mail.sessionAddress(sessionId),
      task: text,
      origin: 'create_session',
      projectId: sessionOf(sessionId)?.projectId || null,
      depth: sessionOf(sessionId)?.depth ?? 0,
    })
  }
}

/** The end of a turn of work the person owns is a report in their thread (Centralu's words, the session's own beside them), and the thread goes where the draft says */
export function personReportRecorder(mail: MailService, records: MailRecords): (sessionId: string, draft: Pick<ReportDraft, 'outcome' | 'body' | 'answer' | 'error' | 'paused' | 'then'>) => boolean {
  return (sessionId, draft) => {
    const assignee = mail.sessionAddress(sessionId)
    const thread = records.latestBetween(PERSON, assignee)
    if (!thread || thread.state !== 'running') return false
    // The same pause on the same background work is said once: a second turn that leaves as many tasks running tells the person nothing new
    const last = draft.then === 'running' && draft.paused ? records.lastReportBy(thread.id, CENTRALU) : undefined
    if (last && last.facts.outcome === 'paused' && last.facts.paused === draft.paused) return true
    try {
      mail.reportTurn(thread.id, {
        to: PERSON,
        about: assignee,
        outcome: draft.outcome,
        body: draft.body,
        ...(draft.answer ? { answer: draft.answer } : {}),
        ...(draft.error ? { error: draft.error } : {}),
        ...(draft.paused ? { paused: draft.paused } : {}),
        then: draft.then,
      })
      return true
    } catch (e) {
      if (refusalReason(e) !== undefined) return false
      throw e
    }
  }
}

/**
 * What the host does when a thread whose work was going is closed by the person or its owner (3.10, MB): `turnRunning` is whether `mail_turns` says
 * a turn going in the assignee belongs to this thread, and `closed` stops that turn and tells the helper (`SessionManager.workClosed`)
 */
export function closingRecorder(
  turns: MailTurns,
  host: {
    inTurn(sessionId: string): boolean
    /** The session's turn has ended but its own background work runs, and a report waits on it (`pausedReports`) */
    paused(sessionId: string, ownerId: string): boolean
    workClosed(c: { threadOwner: string; helperId: string; stopped: boolean; text: string; since?: number }): void
  },
): ClosingHooks {
  const sessionOf = (address: string): string | undefined => {
    const party = parseAddress(address)
    return party?.kind === 'session' ? party.sessionId : undefined
  }
  return {
    turnRunning: (thread) => {
      const helper = sessionOf(thread.assignee ?? '')
      if (helper === undefined) return false
      if (host.inTurn(helper)) return turns.current(helper)?.threadId === thread.id
      // Paused over its own background work for this thread's owner: that work is what is going
      const owner = sessionOf(thread.owner)
      return owner !== undefined && host.paused(helper, owner)
    },
    closed: (c) => {
      // When the turn that is stopped began: only the background work it started is stopped with it
      const since = turns.startedAt(c.helperId)
      host.workClosed({ threadOwner: sessionOf(c.thread.owner) ?? '', helperId: c.helperId, stopped: c.stopped, text: c.text, ...(since !== undefined ? { since } : {}) })
    },
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

/** What the mailbox does when a session deletes the session that did work it gave (§3.3): a thread whose work was reported is closed */
export function finishRecorder(mail: MailService): (callerId: string, childId: string) => void {
  return (callerId, childId) => mail.ownerFinished(mail.sessionAddress(callerId), mail.sessionAddress(childId))
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
    const personWork = (): string | null => {
      const mine = turn.ownerId ? undefined : records.latestBetween(PERSON, mail.sessionAddress(sessionId))
      return mine?.state === 'running' ? mine.id : null
    }
    if (turn.by === 'person') turns.beginOther(sessionId, 'person', null)
    else if (turn.added) turns.beginOther(sessionId, 'person', threadId, turn.ownerId)
    // A report or notice about another session starts a turn of its own kind, not of a caller's send (§6 keeps `caller` for that)
    else if (turn.source === 'report') turns.beginOther(sessionId, 'report', null)
    else if (turn.source === 'app') turns.beginOther(sessionId, 'app', null)
    // The turn the person's own work starts (§8.1) is that thread's: work handed on in it is a child thread of it, and its end waits for that work (§6)
    else turns.beginOther(sessionId, turn.cli ? 'cli' : 'caller', threadId ?? personWork(), turn.ownerId)
  }
}

/**
 * A turn's end as the mailbox is told it (docs/plans/mailbox.md §6, §8.1): Centralu's own words for the thread's owner, with the facts
 * a wake carries
 */
export type ReportDraft = {
  /** One word of Centralu's: finished, failed, limit_reached, network, interrupted, quit, stopped, paused, settled, swapped, took_over */
  outcome: string
  /** The report in Centralu's words alone: how it ended, the id, the kind of error, how to go on, and where the session's words are read (#1186) */
  body: string
  /** The session's last response, its own words: they are put in the thread as its message, in front of the report, never in Centralu's */
  answer?: string
  /** The kind of error the turn ended in */
  error?: string
  /** How many background tasks of the session's own the turn left running */
  paused?: number
  /** The person wrote into the turn, or added to the task */
  personNote?: boolean
  /** What the thread becomes (`TurnReport.then`) */
  then: 'review' | 'running' | 'dropped'
  /**
   * The session is being archived, and archiving stopped the turn this reports: that end is not the work's (#1445 review), and the
   * thread is left to `partyGone`, which says the session is gone and puts the work back on the board
   */
  archiving?: boolean
  /** The owner is in a turn now: a relayed notice joins it and starts none */
  ownerInTurn?: boolean
  /** How the owner is told: by the mailbox (`wake`), by the relayed message to a process that may lack the mail tool (`in-turn`), or by the old relayed message (it cannot read mail, `old`) */
  delivery: ReportDelivery
}

/**
 * `wake`: the owner reads mail, so the mailbox tells it: at rest it is woken, in a turn the mail waits for the turn's end (3.9; hooks in
 * slice 6 will bring it into the turn). `in-turn`: it reads mail, but its process may not have the tool (kept from an earlier host): the relayed
 * message goes in as it always did, and if that fails the mailbox wakes it when it can. `old`: its seat cannot read mail (a coordinator, a builder,
 * an app's agent), so the old way tells, and holds the notice if it cannot be delivered
 */
export type ReportDelivery = 'wake' | 'in-turn' | 'old'

/**
 * What the mailbox did with a draft: `mailed`, the report is in the thread and the mailbox tells the owner; `closed`, the session itself
 * closed the thread by mail and said how it ended, so the owner has been told; `none`, there is no thread for this work, and the old way
 * tells; an object, the report is in the thread and the old way tells too: when that message is delivered `settle` marks the report
 * delivered, so the mailbox does not wake the owner for it. `keep`: hold the notice if it cannot be delivered (an owner that cannot read mail;
 * an owner that can is woken by the mailbox instead)
 */
export type ReportedAs = 'mailed' | 'closed' | 'none' | { settle: () => void; keep: boolean }


/** The thread a session opened to ask the orchestrator (§9.7): a `mail` thread, which `latestBetween` does not take for a delegation's */
function askedOf(mail: MailService, records: MailRecords, owner: string, assignee: string): ThreadRow | undefined {
  const thread = records.latestBetween(owner, assignee, ['mail'])
  return thread && mail.isAsk(thread) ? thread : undefined
}

/**
 * What the mailbox does with the end of a turn of delegated work (§6, §8.1): the report goes in the thread the owner has with the session,
 * and the owner is told as mail when it can read it. A thread the session itself closed by mail, saying how it ended, takes no second
 * report (the owner has been told); a thread that is done any other way, or none at all, leaves the old way of telling
 */
export function reportRecorder(mail: MailService, records: MailRecords): (ownerId: string, childId: string, draft: ReportDraft) => ReportedAs {
  return (ownerId, childId, draft) => {
    const owner = mail.sessionAddress(ownerId)
    const child = mail.sessionAddress(childId)
    const thread = records.latestBetween(owner, child) ?? askedOf(mail, records, owner, child)
    if (!thread) return 'none'
    if (thread.state === 'done') {
      // The session's own words: the last response a report carried is in the thread as its message too, and is not it closing the work
      const theirs = records.lastWordBy(thread.id, child)
      const ours = records.lastBy(thread.id, owner)
      // The person closed it and the owner was told (3.10): the end of the turn that was still going is not a second word
      const closed = records.lastReportBy(thread.id, CENTRALU)
      if (closed?.facts.closedBy === 'person' && closed.seq > (ours?.seq ?? 0)) return 'closed'
      return theirs?.kind === 'report' && theirs.seq > (ours?.seq ?? 0) ? 'closed' : 'none'
    }
    if (draft.archiving) return 'closed'
    let posted
    try {
      posted = mail.reportTurn(thread.id, {
        to: owner,
        about: child,
        outcome: draft.outcome,
        body: draft.body,
        ...(draft.answer ? { answer: draft.answer } : {}),
        ...(draft.error ? { error: draft.error } : {}),
        ...(draft.paused ? { paused: draft.paused } : {}),
        ...(draft.personNote ? { personNote: true } : {}),
        then: draft.then,
      })
    } catch (e) {
      if (refusalReason(e) !== undefined) return 'none'
      throw e
    }
    // The same pause again (work handed on still going): nothing new to tell
    if (posted.duplicate) return 'closed'
    // A pause that does not wake starts no turn (§6, MB): recorded, and read at the owner's next turn. The old way of telling would start one
    // for an owner at rest, so only an owner in a turn is told
    if (posted.message.wake === 'no' && draft.delivery !== 'wake' && !draft.ownerInTurn) return 'closed'
    if (draft.delivery === 'wake') return 'mailed'
    const messageId = posted.message.id
    return { keep: draft.delivery === 'old', settle: () => mail.reportTold(thread.id, owner, messageId) }
  }
}
