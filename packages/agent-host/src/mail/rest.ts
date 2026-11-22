import type { ReleaseWhy } from '../dev-services/store/mailbox.js'
import type { ReceiverState } from './delivery.js'

/**
 * "At rest" for the unanswered reminder (docs/plans/mailbox.md §10.1, D22): narrower than "can take mail". A reminder wakes a
 * session only when nothing of its own will wake it first and nobody is using it.
 */

/** What the rest rule reads of a session: the host's facts and the mailbox's record of its last turn */
export type RestFacts = {
  /** The delivery's one question about it (`MailSessions.receiver`): gone, busy (a turn, a card, a usage limit, a host that is leaving) or ready */
  receiver: ReceiverState
  /** Its state is `error`, or its last turn carries an interruption */
  error: boolean
  interrupted: boolean
  /** Its running own work (`workTasks`: not ambient, not a timer, D22) */
  work: number
  /** Whether its background work is known: false only for an adopted process whose tool has not listed it yet (`RestartPolicy.backgroundKnown`) */
  workKnown: boolean
  /** Mail that wakes it waits to be delivered: that delivery goes first */
  mailWaiting: boolean
  /** Its last turn that ended (`MailboxRecords.lastTurnEnded`): who started it, when it ended, and the stop that cut it */
  lastTurn: { startedBy: string; endedAt: number; endedHow: ReleaseWhy | null } | null
}

export type RestWhy = 'gone' | 'turn' | 'card' | 'limited' | 'error' | 'interrupted' | 'stopped' | 'mail_waiting' | 'person' | 'own_work' | 'own_work_unknown'

/** Whether the session is at rest for a reminder, or the first condition that fails, in §10.1's order */
export function restForReminder(f: RestFacts, now: number, personQuietMs: number): { atRest: true } | { atRest: false; why: RestWhy } {
  const no = (why: RestWhy) => ({ atRest: false as const, why })
  if (f.receiver.kind === 'gone') return no('gone')
  if (f.receiver.kind === 'busy') return no(f.receiver.why)
  if (f.receiver.joins) return no('turn')
  const cut = f.lastTurn?.endedHow ?? null
  if (cut === 'stopped') return no('stopped')
  if (f.error || cut === 'error') return no('error')
  if (f.interrupted || cut !== null) return no('interrupted')
  if (f.mailWaiting) return no('mail_waiting')
  if (f.lastTurn?.startedBy === 'person' && now - f.lastTurn.endedAt < personQuietMs) return no('person')
  if (f.work > 0) return no('own_work')
  if (!f.workKnown) return no('own_work_unknown')
  return { atRest: true }
}
