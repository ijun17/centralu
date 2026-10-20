import { asObj } from '../json-value.js'
import { rpcError, type RpcError } from '../rpc-error.js'
import type { MessageKind, ThreadState } from '../dev-services/store/mail.js'

/**
 * The rules of the mailbox that need no store (docs/plans/mailbox.md §3.2, §3.3, §9.4): who may send which kind, who may
 * move a thread's state, how big a post may be. `MailService` asks them; they are here so each is read and tested alone.
 */

/** What a sender is, from its address */
export type SenderClass = 'session' | 'app' | 'person' | 'centralu'

/** What a sender is in a thread. `person` and `centralu` are not roles in it: they have the powers of their class */
export type Standing = 'person' | 'centralu' | 'owner' | 'assignee' | 'member'

/** Why a call was refused, for the caller to act on (the message says it in words) */
const REFUSALS = [
  'bad_address',
  'not_local',
  'not_found',
  'not_participant',
  'thread_done',
  'kind_not_allowed',
  'field_not_allowed',
  'not_allowed',
  'empty',
  'too_long',
  'too_many_blockers',
  'blockers_stand',
  'no_blocker',
  'bad_follows',
  'no_mailbox',
  'bad_value',
  'policy',
] as const
export type MailRefusal = (typeof REFUSALS)[number]

/**
 * A refusal is an error with the protocol's `refused` code and a `data.reason` word the caller can act on: the host understood
 * the call and said no, which is not a fault and not worth a retry
 */
export function refuse(reason: MailRefusal, message: string, more: Record<string, unknown> = {}): RpcError {
  return rpcError(message, 'refused', { retryable: false, data: { reason, ...more } })
}

/** The words of a refusal: `err.data.reason`, or undefined for an error that is not one */
export function refusalReason(err: unknown): MailRefusal | undefined {
  const reason = asObj(asObj(err).data).reason
  return REFUSALS.find((r) => r === reason)
}

/** A body's longest, by sender: 16,000 characters from a session or the person, 4,000 from an app, as `notify` (§3.2) */
export function bodyLimit(sender: SenderClass): number {
  return sender === 'app' ? 4_000 : 16_000
}

export const SUBJECT_MAX = 200
export const NEXT_MAX = 300
export const MAX_BLOCKERS = 5

/**
 * Whether a sender may post a kind (§3.2 and §9.4). `assign` is the owner's act on a thread (`MailService.assign`) and
 * `event` is Centralu's alone, so neither is a kind a plain post may carry
 */
export function mayPostKind(sender: SenderClass, standing: Standing, kind: MessageKind): string | null {
  switch (kind) {
    case 'event':
      return sender === 'centralu' ? null : 'only Centralu writes an event'
    case 'assign':
      return 'work is given with assign, not posted'
    case 'notice':
      return sender === 'app' || sender === 'centralu' ? null : 'a notice comes from an app or from Centralu'
    case 'report':
      return sender === 'centralu' || standing === 'assignee' ? null : 'only the assignee reports on a thread'
    case 'question':
    case 'answer':
    case 'note':
      return null
    default:
      return `unknown kind ${String(kind)}`
  }
}

/** The states a party may set with `mail update` (§3.3): the owner and the person any, the assignee the four of its own */
export function settableStates(standing: Standing): readonly ThreadState[] {
  if (standing === 'centralu' || standing === 'person' || standing === 'owner') return ['open', 'running', 'review', 'blocked', 'done']
  if (standing === 'assignee') return ['running', 'review', 'blocked', 'done']
  return []
}

/** May this party change the task's other fields (next step, links, subject, blockers)? */
export function mayEditTask(standing: Standing): boolean {
  return standing !== 'member'
}

/** What a thread goes back to when its last blocker is resolved: `running` if a turn of it is going, else `open` (§3.3) */
export function stateAfterUnblocked(turnGoing: boolean): ThreadState {
  return turnGoing ? 'running' : 'open'
}

/** Whether a post by this party sends a `review` thread back to `running`: the owner or the person sends more (§3.3) */
export function reopensReview(standing: Standing, kind: MessageKind): boolean {
  return (standing === 'owner' || standing === 'person') && (kind === 'note' || kind === 'question' || kind === 'answer')
}

/**
 * Words that flow down (§7.3): an assign, note or answer from the thread's owner, a session, to its assignee, and anything
 * from the person. An app's words never do, whatever its place in the thread
 */
export function flowsDown(senderIsPerson: boolean, senderIsOwnerSession: boolean, recipientIsAssignee: boolean, kind: MessageKind): boolean {
  if (senderIsPerson) return true
  return senderIsOwnerSession && recipientIsAssignee && (kind === 'assign' || kind === 'note' || kind === 'answer')
}

/**
 * Whether a message wakes a receiver at rest (§3.2, §9.5). Mail from a session, the person or Centralu does; an app's notice does
 * not unless the app marked it `needsOwner` (or asked for it), and an app can ask for no wake at all. An `event` is never mail
 */
export function wakes(sender: SenderClass, m: { kind: MessageKind; wake: 'yes' | 'no' | null; needsOwner: boolean }): boolean {
  if (m.kind === 'event') return false
  if (sender !== 'app') return true
  if (m.wake === 'no') return false
  if (m.kind === 'notice') return m.needsOwner || m.wake === 'yes'
  return true
}

/**
 * Whether a message needs its receiver even when the host has been off a long while (§7.9): the person's words, work given or
 * asked in its own threads (an assign, a question, an answer), a report its owner is waiting on, and an app's `needsOwner` post. The rest waits for
 * the session's next turn
 */
export function needsReceiver(sender: SenderClass, m: { kind: MessageKind; needsOwner: boolean }): boolean {
  // The person's words are never the kind that can wait out a stop: they decide
  if (sender === 'person') return true
  switch (m.kind) {
    case 'assign':
    case 'question':
    case 'answer':
      return true
    case 'report':
      return true
    case 'notice':
      return sender === 'app' && m.needsOwner
    default:
      return false
  }
}

/** Receipts are due 2 s after the message so a burst is one delivery; urgent mail and the person's words at once (§7.9) */
export const DEBOUNCE_MS = 2_000

export function dueAt(now: number, urgent: boolean, fromPerson: boolean): number {
  return urgent || fromPerson ? now : now + DEBOUNCE_MS
}
