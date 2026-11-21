import type { MailboxRecords, RecipientRow } from '../dev-services/store/mailbox.js'
import { senderKind } from './address.js'
import { bodyLimit } from './rules.js'
import type { TurnReport } from './turn-report.js'

/**
 * The most of a session's last response a report keeps as its answer: as long as a message a session may send, so reading the
 * report shows the whole of almost any answer. Past it the answer ends in "…" and the report's words say so
 * (`lastResponseLine`)
 */
export const ANSWER_KEPT_CHARS = bodyLimit('session')
/** The most of a last response quoted where a preview is all there is room for: a stop notice's quote and the report relayed to a seat without mail */
export const PREVIEW_CHARS = 600

/** `text` cut to `max` characters, the cut marked by "…" */
export function clipped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Whether a report's answer is whole or was cut at its most (`clipped`), or there is none: what its words say of it (`lastResponseLine`) */
export type AnswerKept = 'none' | 'whole' | 'cut'

/** `AnswerKept` of an answer whose most is `max` */
export function answerKept(answer: string | undefined, max: number): AnswerKept {
  if (!answer) return 'none'
  return answer.length >= max && answer.endsWith('…') ? 'cut' : 'whole'
}

/** How a report's turn ended, in Centralu's words: the report's first line and the inbox's line on it say it alike (#2358 item 1) */
export const OUTCOME_WORDS = {
  finished: 'ended its turn',
  failed: 'did not finish',
  stopped: 'stopped before finishing',
  paused: 'paused for its background work',
  waiting: 'is waiting on other work',
} as const satisfies Record<TurnReport['outcome'], string>

/**
 * A session's last response, as the tasks it did not answer by a reply are answered with it (docs/plans/mailbox.md §10.6.3):
 * Centralu's words for each sender beside the session's own, and what decides which open tasks it answers
 */
export type LastResponse = {
  /** Centralu's words for the sender (an address): how the session's turn ended and where its words are read, in that sender's form of the calls */
  body: (sender: string) => string
  /** The session's last response, its own words, kept on the report as its `answer` */
  answer?: string
  /** When that response was stored: a task delivered after it is told so (`after`, docs/plans/turn-owned-by-no-one.md Q4) */
  writtenAt?: number
  /**
   * Whether tasks a stop released are answered too. Only a turn that ended after the release answers them: the settle after the
   * session's own background work ended and the host's start do not, since the turn before them may be the very one that
   * stopped
   */
  released: boolean
  /** Whose tasks a last response answers, by sender address */
  answers: (sender: string) => boolean
  /** The messages the tool holds queued for a turn after (`MailDelivery.queuedFor`): that turn answers them */
  queued?: ReadonlySet<string>
}

/**
 * The tasks a session at rest answers with its last response, oldest first: open (delivered, not settled, not held), not queued
 * in its tool for a turn after, and with no task it handed on in that work still open (that work is not done; the turn that
 * work's answer starts ends it)
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
 * Answers the open tasks of a session at rest with its last response (§10.6.3): one report per giver at a turn's end (the
 * owner's decision of 2026-11-18). The report replies to that giver's newest open task, the one the turn ended on, and covers
 * the others (`facts.covers`), settling them all `reported`. `report` writes it (`MessageService.report`). Returns the tasks
 * replied to. None goes to a giver the session asked a question (`facts.question`) still unanswered, asked after the giver's
 * newest task came (`MailboxRecords.unansweredTo` with `asked`): the question reached it already and its tasks stay open. The
 * question settling ends the hold: an answer goes to the session and the turn it starts answers them; marked handled with no
 * answer, the session answers at once (`MessageService.questionSettled`). Only a session giver: the person's own work always
 * gets its report (`asksAnswerTurnEnd`).
 */
export function answerAtRest(
  records: MailboxRecords,
  recipient: string,
  last: LastResponse,
  report: (taskId: string, input: TurnReport) => unknown,
  personAt: number | undefined,
): string[] {
  const byGiver = new Map<string, { row: RecipientRow; sender: string }[]>()
  for (const t of tasksAtRest(records, recipient, last)) byGiver.set(t.sender, [...(byGiver.get(t.sender) ?? []), t])
  return [...byGiver].flatMap(([sender, tasks]) => {
    const newest = tasks.at(-1)
    if (!newest) return []
    const given = newest.row.deliveredAt ?? 0
    // A question after the giver's newest task came (one given after it still gets its answer), still waiting for the giver's answer
    if (asksAnswerTurnEnd(sender) && records.unansweredTo(sender, { from: recipient, since: given }).length > 0) return []
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
 * Whether a session's question to this giver holds the giver's report: a session giver's yes, it reads its mail and the
 * question woke it. The person's no: their Inbox thread reads In review from the report, and the wake this saves is a session's
 */
function asksAnswerTurnEnd(giver: string): boolean {
  return senderKind(giver) === 'session'
}

/**
 * The first line of a report on a turn that completed: all the host knows is that the turn ended. Whether the work is done is
 * for the session's own last response to say, or the outcome it recorded itself, so Centralu never says "finished" for it: a
 * child that gave up says so in its words and the report must not contradict them
 */
export const TURN_ENDED = `[Centralu] The session ${OUTCOME_WORDS.finished}. Its last response says whether the work is done.`
/** The same line for the person, on their own work: one line, with nothing to call (§10.6.3) */
export const PERSON_TURN_ENDED = `[Centralu] The session you started ${OUTCOME_WORDS.finished}. Its last response says whether the work is done.`

/**
 * Centralu's words on a report of work given the session read as `childId`, from how it ended alone: a call that returned that
 * end (`answerRecorder`) and a report another computer sends on work given there (`MailAcross.reportFrom`). Nothing the
 * session, its tool or that computer wrote goes in (#120): its answer, error and reason are the report's facts, never these
 * words. `kind`: the kind of its tool's error, a word of this host's (`errorKind`), which a report from another computer never
 * brings
 */
export function reportWords(childId: string, r: { outcome: TurnReport['outcome']; kind?: string; personSince?: boolean; after?: boolean; answer?: AnswerKept }): string {
  const read = `read_session(sessionId="${childId}")`
  const lines =
    r.outcome === 'finished'
      ? [`${TURN_ENDED}\nid: ${childId}\n\n${lastResponseLine(read, r.answer ?? 'none')}`]
      : [
          `[Centralu] The assigned work ${r.outcome === 'failed' ? OUTCOME_WORDS.failed : OUTCOME_WORDS.stopped}.\nid: ${childId}\n\n` +
            `${r.kind ? `Its tool's error, by kind: ${r.kind}. ` : ''}Its words are its tool's, not Centralu's, so they are not repeated here: ${read} shows them.`,
        ]
  return [...lines, ...(r.personSince ? [PERSON_SINCE] : []), ...(r.after ? [AFTER] : [])].join('\n')
}

/** On a last response the person may have been answering (docs/plans/turn-owned-by-no-one.md §2.4, Q2) */
const PERSON_SINCE = 'The person also wrote in this session after your task was given, so this last response may be an answer to them.'
/** On a last response written before the task arrived (Q4) */
const AFTER = 'Your task arrived after this response was written.'

/**
 * The line of a turn-ended report on where the session's last response is (`read`: the read_session call that shows its turn):
 * its answer is the report's fact, which reading the report shows (`MailTool`), never these words (#120); cut, read_session
 * reads the rest; or that it wrote none
 */
export function lastResponseLine(read: string, answer: AnswerKept): string {
  if (answer === 'none') return `It wrote no response: ${read} shows its turn.`
  return `Its last response is that session's own words: reading this report shows ${answer === 'cut' ? `its start, and ${read} reads the rest` : 'it'}.`
}
