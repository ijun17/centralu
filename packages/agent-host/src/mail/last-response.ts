import type { MailboxRecords, RecipientRow } from '../dev-services/store/mailbox.js'
import { parseAddress } from './address.js'
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
 * Answers the open tasks of a session at rest with its last response (§10.6.3): each task is a request of its own and gets its own report, replying to
 * it and settling it `reported` (the owner's rule of 2026-11-05: a report attaches to a request, never to a turn or a sender). `report` writes one
 * (`MessageService.report`). Returns the tasks answered
 */
export function answerAtRest(
  records: MailboxRecords,
  recipient: string,
  last: LastResponse,
  report: (taskId: string, input: TurnReport) => unknown,
  personAt: number | undefined,
): string[] {
  return tasksAtRest(records, recipient, last).map(({ row, sender }) => {
    const given = row.deliveredAt ?? 0
    // The person reads their own work's report: it is not told they wrote
    const personSince = parseAddress(sender)?.kind === 'session' && personAt !== undefined && personAt > given
    const after = last.writtenAt !== undefined && last.writtenAt < given
    const lines = [last.body(sender), ...(personSince ? [PERSON_SINCE] : []), ...(after ? [AFTER] : [])]
    report(row.messageId, {
      outcome: 'finished',
      body: lines.join('\n'),
      ...(last.answer ? { answer: last.answer } : {}),
      ...(personSince ? { personSince: true } : {}),
      ...(after ? { after: true } : {}),
    })
    return row.messageId
  })
}

/** On a last response the person may have been answering (docs/plans/turn-owned-by-no-one.md §2.4, Q2) */
const PERSON_SINCE = 'The person also wrote in this session after your task was given, so this last response may be an answer to them.'
/** On a last response written before the task arrived (Q4) */
const AFTER = 'Your task arrived after this response was written.'
