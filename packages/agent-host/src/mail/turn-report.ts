import type { MailFacts, MailRow, MailboxRecords } from '../dev-services/store/mailbox.js'

/** How a turn of delegated work ended, as Centralu reports it on the task (docs/plans/mailbox.md §9.3, `MessageService.report`) */
export type TurnReport = {
  outcome: 'finished' | 'failed' | 'stopped' | 'paused' | 'waiting'
  body: string
  answer?: string
  error?: string
  reason?: string
  paused?: number
  waitingOn?: number
  personNote?: boolean
  /** When the turn that ended began, for the tasks its report covers (§9.3): the turn has ended by the time the old path reports it */
  startedAt?: number
  /**
   * A pause's update (#1540): a later turn of the paused work ended with a new answer while its own background work still runs. Where that turn
   * began in the child's stored conversation, read where its end was seen, which grows with each turn: the same turn's end told twice is one update
   */
  update?: number
}

/**
 * A pause's update that is no report of its own (#1540, §9.3): the stored update stands for it. The end of the same turn told again, or of an
 * older one (a replay after a restart, once a newer update was written over it), is that update as stored. An update the owner has not read
 * yet is written over with this one's words and task count, and wakes nobody again (`rewritten`); once read, the next one is a report of its
 * own, which wakes. None: this is a report of its own
 */
export function updateInPlace(
  records: Pick<MailboxRecords, 'reportsOn' | 'recipient' | 'rewrite'>,
  taskId: string,
  owner: string,
  input: TurnReport,
): { message: MailRow; rewritten: boolean } | undefined {
  if (input.update === undefined) return undefined
  const last = records.reportsOn(taskId).filter((r) => r.facts.update !== undefined).at(-1)
  if (!last) return undefined
  if (input.update <= (last.facts.update ?? 0)) return { message: last, rewritten: false }
  if (records.recipient(last.id, owner)?.readAt !== null) return undefined
  const { answer: _answer, personNote: _note, ...kept } = last.facts
  const facts: MailFacts = { ...kept, paused: input.paused ?? 0, update: input.update, ...(input.answer ? { answer: input.answer } : {}), ...(input.personNote ? { personNote: true } : {}) }
  return { message: records.rewrite(last.id, input.body, facts) ?? last, rewritten: true }
}
