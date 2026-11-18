import type { MailboxRecords, RecipientRow } from '../dev-services/store/mailbox.js'
import { parseAddress, senderKind } from './address.js'
import type { TurnReport } from './turn-report.js'

/**
 * A session's last response, as the tasks it did not answer by a reply are answered with it (docs/plans/mailbox.md §10.6.3, #1948 target 4): Centralu's words
 * for each sender beside the session's own, and what decides which open tasks it answers
 */
export type LastResponse = {
  /** Centralu's words for the sender (an address): how the session's turn ended and where its words are read, in that sender's form of the calls */
  body: (sender: string) => string
  /** The session's last response, its own words, kept on the report as its `answer` */
  answer?: string
  /** When that response was stored: a task delivered after it is told so (`after`, docs/plans/turn-owned-by-no-one.md Q4) */
  writtenAt?: number
  /**
   * Whether tasks a stop released are answered too. Only a turn that ended after the release answers them: the settle after the session's own background
   * work ended and the host's start do not, since the turn before them may be the very one that stopped
   */
  released: boolean
  /** Whose tasks a last response answers, by sender address */
  answers: (sender: string) => boolean
  /** The messages the tool holds queued for a turn after (`MailDelivery.queuedFor`): that turn answers them */
  queued?: ReadonlySet<string>
}

/**
 * The tasks a session at rest answers with its last response, oldest first: open (delivered, not settled, not held), not queued in its tool for a turn
 * after, and with no task it handed on in that work still open (that work is not done; the turn that work's answer starts ends it)
 */
export function tasksAtRest(records: MailboxRecords, recipient: string, last: Pick<LastResponse, 'released' | 'answers' | 'queued'>): { row: RecipientRow; sender: string }[] {
  return records.watchedTo(recipient).flatMap((row) => {
    if (row.deliveredAt === null || (row.held !== null && row.held !== 'released') || (!last.released && row.releasedAt !== null) || last.queued?.has(row.messageId)) return []
    const task = records.message(row.messageId)
    if (task?.kind !== 'task' || task.sender === recipient || !last.answers(task.sender)) return []
    return records.handedOn(task.id).length > 0 ? [] : [{ row, sender: task.sender }]
  })
}

/**
 * Answers the open tasks of a session at rest with its last response (§10.6.3): one report per giver at a turn's end (#2348, the owner's decision
 * of 2026-11-18, which replaced 2026-11-05's report per task). The report replies to that giver's newest open task, the one the turn ended on, and
 * covers the others (`facts.covers`), settling them all `reported`. `report` writes it (`MessageService.report`). Returns the tasks replied to.
 *
 * None goes to a giver the session asked something this turn and waits on (`awaitsAnswerSince`): its question is the sign the turn ended, and its tasks stay open, so the
 * turn the giver's answer starts answers them (#2329). Only a session giver: the person's own work always gets its report (`asksAnswerTurnEnd`)
 */
export function answerAtRest(
  records: MailboxRecords,
  recipient: string,
  last: LastResponse,
  report: (taskId: string, input: TurnReport) => unknown,
  personAt: number | undefined,
): string[] {
  const party = parseAddress(recipient)
  const turnAt = party?.kind === 'session' ? records.latestTurnStart(party.sessionId) : null
  const byGiver = new Map<string, { row: RecipientRow; sender: string }[]>()
  for (const t of tasksAtRest(records, recipient, last)) byGiver.set(t.sender, [...(byGiver.get(t.sender) ?? []), t])
  return [...byGiver].flatMap(([sender, tasks]) => {
    const newest = tasks.at(-1)
    if (!newest) return []
    const given = newest.row.deliveredAt ?? 0
    // Asked in this turn, after the giver's newest task came (a task given after the question still gets its answer), and still waiting for it
    if (asksAnswerTurnEnd(sender) && turnAt !== null && records.awaitsAnswerSince(recipient, sender, Math.max(turnAt, given))) return []
    // The person wrote after the first of these tasks was given (the person reads their own work's report: it is not told they wrote); the newest
    // arrived after the response was written
    const personSince = senderKind(sender) === 'session' && personAt !== undefined && personAt > (tasks[0]?.row.deliveredAt ?? given)
    const after = last.writtenAt !== undefined && last.writtenAt < given
    const lines = [last.body(sender), ...(personSince ? [PERSON_SINCE] : []), ...(after ? [AFTER] : [])]
    report(newest.row.messageId, {
      outcome: 'finished',
      body: lines.join('\n'),
      ...(last.answer ? { answer: last.answer } : {}),
      ...(personSince ? { personSince: true } : {}),
      ...(after ? { after: true } : {}),
      ...(tasks.length > 1 ? { covers: tasks.slice(0, -1).map((t) => t.row.messageId) } : {}),
    })
    return [newest.row.messageId]
  })
}

/**
 * Whether a session's question to this giver in the turn stands for the turn's end (#2348): a session giver's yes, it reads its mail and the question
 * wakes it. The person's no: their Inbox thread reads In review from the report, and the wake this saves is a session's
 */
function asksAnswerTurnEnd(giver: string): boolean {
  return senderKind(giver) === 'session'
}

/**
 * The first line of a report on a turn that completed: all the host knows is that the turn ended. Whether the work is done is for the session's own
 * last response to say, or the outcome it recorded itself, so Centralu never says "finished" for it (#1902): a child that gave up says so in its
 * words, and the report must not contradict them
 */
export const TURN_ENDED = "[Centralu] The session ended its turn. Its last response says whether the work is done."
/** The same line for the person, on their own work: one line, with nothing to call (§10.6.3) */
export const PERSON_TURN_ENDED = '[Centralu] The session you started ended its turn. Its last response says whether the work is done.'

/**
 * Centralu's words on a report of work given the session read as `childId`, from how it ended alone: a call that returned that end (`answerRecorder`)
 * and a report another computer sends on work given there (`MailAcross.reportFrom`, #1948 step 6). Nothing the session, its tool or that computer
 * wrote goes in (#120): its answer, error and reason are the report's facts, never these words. `kind`: the kind of its tool's error, a word of this
 * host's (`errorKind`), which a report from another computer never brings
 */
export function reportWords(childId: string, r: { outcome: TurnReport['outcome']; kind?: string; personSince?: boolean; after?: boolean }): string {
  const read = `read_session(sessionId="${childId}")`
  const lines =
    r.outcome === 'finished'
      ? [`${TURN_ENDED}\nid: ${childId}\n\nIts last response is that session's own words, so it is not repeated here: ${read} reads it.`]
      : [
          `[Centralu] ${r.outcome === 'failed' ? 'The assigned work did not finish.' : 'The assigned work stopped before finishing.'}\nid: ${childId}\n\n` +
            `${r.kind ? `Its tool's error, by kind: ${r.kind}. ` : ''}Its words are its tool's, not Centralu's, so they are not repeated here: ${read} shows them.`,
        ]
  return [...lines, ...(r.personSince ? [PERSON_SINCE] : []), ...(r.after ? [AFTER] : [])].join('\n')
}

/** On a last response the person may have been answering (docs/plans/turn-owned-by-no-one.md §2.4, Q2) */
const PERSON_SINCE = 'The person also wrote in this session after your task was given, so this last response may be an answer to them.'
/** On a last response written before the task arrived (Q4) */
const AFTER = 'Your task arrived after this response was written.'
