import { oneLineText } from '@cc/protocol'
import { asObj } from '../json-value.js'
import { rpcError, type RpcError } from '../rpc-error.js'
import type { MessageKind } from '../dev-services/store/mail-types.js'
import type { MailKind, MailRow } from '../dev-services/store/mailbox.js'
import { PERSON, parseAddress } from './address.js'

/**
 * The rules of the mailbox that need no store (docs/plans/mailbox.md §3.2, §3.3, §9.4): who may send which kind, who may
 * move a thread's state, how big a post may be. `MailService` asks them; they are here so each is read and tested alone.
 */

/** What a sender is, from its address */
export type SenderClass = 'session' | 'app' | 'person' | 'centralu'

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
  'rate_limited',
  'bad_value',
  'policy',
  // mail without threads (docs/plans/mailbox.md §15, S9)
  'gone',
  'ambiguous',
  'unknown',
  'elsewhere',
  'unknown_message',
  'own_message',
  'recipients',
  'not_yours',
  'pair_rate',
  'repeat',
  'ask_rate',
  'orchestrator_asks',
  'removed',
  'untrusted_project',
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

/** A sender's posts a minute (§7.9): 30 from a session, 10 from an app. The person and Centralu are not limited */
export function postsPerMinute(sender: SenderClass): number {
  return sender === 'session' ? 30 : sender === 'app' ? 10 : Infinity
}

/** A session's new requests to the orchestrator an hour (§9.7, #1447) */
export const ASKS_PER_HOUR = 5

/** The same words from the same sender in the same thread within this long are one post (§7.9) */
export const REPEAT_WINDOW_MS = 10 * 60_000

/**
 * Whether a message wakes a receiver at rest (§3.2, §9.5). Mail from a session, the person or Centralu does; an app's notice does
 * not unless the app marked it `needsOwner` (or asked for it), and an app can ask for no wake at all. An `event` is never mail
 */
export function wakes(sender: SenderClass, m: { kind: MessageKind; wake: 'yes' | 'no' | null; needsOwner: boolean }): boolean {
  if (m.kind === 'event') return false
  // Centralu's own report of a pause that is not the first of its thread (§6): recorded, read at the next turn, starts none
  if (sender === 'centralu' && m.wake === 'no') return false
  if (sender !== 'app') return true
  if (m.wake === 'no') return false
  if (m.kind === 'notice') return m.needsOwner || m.wake === 'yes'
  return true
}

/**
 * Whether a message needs its receiver even when the host has been off a long while (§7.9): the person's words, a task, a report, a
 * message that needs a reply and an app's post the receiver must see. The rest waits for the session's next turn
 */
export function needsReceiver(m: Pick<MailRow, 'sender' | 'kind' | 'needsReply' | 'facts'>): boolean {
  return m.sender === PERSON || m.kind === 'task' || m.kind === 'report' || m.needsReply || m.facts.needsOwner === true
}

/** Receipts are due 2 s after the message so a burst is one delivery; urgent mail and the person's words at once (§7.9) */
/** How long a thread's mail may wait behind other threads' before it comes first (§5, §7.10): a question 5 minutes, anything else 15 */
export const HOLD_QUESTION_MS = 5 * 60_000
export const HOLD_OTHER_MS = 15 * 60_000

export const DEBOUNCE_MS = 2_000

export function dueAt(now: number, urgent: boolean, fromPerson: boolean): number {
  return urgent || fromPerson ? now : now + DEBOUNCE_MS
}

// ── Mail without threads (docs/plans/mailbox.md §1, §8.2, §15; M2). The constants of the design are here and nowhere else ──

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
/** What `read` with no id returns at most: 10 messages and about 20,000 characters, never half a message (§8.4); a chain back from a message, 9 ancestors */
export const READ_ITEMS = 10
export const READ_CHARS = 20_000
export const READ_CHAIN = 9
/** Non-reply messages an hour from one session to one other: refused `pair_rate` (D13). Replies are not counted */
export const PAIR_NEW_PER_HOUR = 5
export const MAX_RECIPIENTS = 10
/** A session of an untrusted project writing outside it waits for the person to trust the project (D12); false holds and refuses nothing */
export const HOLD_UNTRUSTED_OUT = true
/** Hops in a row of mail passed on (D9) above which a message is held `loop`; only the person's Resume lets it go */
export const MAX_DEPTH = 4
/** Mail-started turns an hour on the host before a wake that would start one is deferred, and the share a quiet session keeps (D13) */
export const HOST_MAIL_TURNS_PER_HOUR = 120
export const HOST_SHARE = 10
/** Mail-started turns an hour between one pair of sessions, with no word from the person, before their mail is held `loop` (D13) */
export const PAIR_TURNS_PER_HOUR = 20
/** The unanswered reminder's limits (§10.4), counted from the store so a swap or restart does not reset them */
export const REMINDER = {
  /** After a session came to rest, before the first reminder */
  graceMs: 2 * 60_000,
  /** After a turn the person started */
  personQuietMs: 10 * 60_000,
  /** After the first reminder's turn ended; also the wait after the second before the row is released */
  againMs: 20 * 60_000,
  perRow: 2,
  /** Between two follow-up wakes of one session (reminders and notices to a sender together) */
  gapMs: 20 * 60_000,
  perDay: 6,
  /** A session asleep longer than this since its last turn is not woken for a follow-up (its prompt cache has expired) */
  warmMs: 50 * 60_000,
  /** After delivery a needsReply row is released: the one 2-hour constant, which also bounds a cover (D23, D25) */
  unansweredAfterMs: 2 * HOUR_MS,
} as const

/** The words of the refusals mail itself raises (§15, S9 and S15), without the `Refused (<reason>): ` the tool puts in front. `name` is the address until the tool resolves names */
export const REFUSAL_TEXT = {
  gone: (address: string) => `${address} is gone: it is in the session archive or deleted.`,
  no_mailbox: () => 'that session cannot read mail: only an ordinary session in a project, or the orchestrator, has the mail tool',
  elsewhere: (address: string) => `${address} is on another computer, and mail does not reach other computers yet; use agent_session there.`,
  unknown_message: (id: string) => `there is no message ${id} you can read; check the id with mail(action="inbox").`,
  own_message: (id: string) => `${id} is your own message; say who it is for with to="…".`,
  recipients: () => `at most ${MAX_RECIPIENTS} recipients.`,
  not_allowed: () => 'that is not a party that takes mail',
  withheld: (id: string) => `${id} is a request: its words are shown in the turn it starts, and it is marked done there.`,
  not_yours: (id: string) => `you were not sent ${id} and did not send it.`,
  pair_rate: (name: string) => `you started ${PAIR_NEW_PER_HOUR} conversations with ${name} in the last hour; answer one of its messages instead, or wait.`,
  repeat: (name: string) => `you sent the same text to ${name} less than ${REPEAT_WINDOW_MS / 60_000} minutes ago.`,
  ask_rate: () => `your project's sessions asked the orchestrator ${ASKS_PER_HOUR} times in the last hour; wait, or write to the person.`,
  orchestrator_asks: () =>
    'the orchestrator runs on a tool that cannot ask the person for each step of a request yet, so a session cannot ask it: write to the person instead',
  untrusted_project: (project: string, target: string) =>
    `your project ${project} is not trusted, so work you give outside it (to ${target}) waits for the person to trust ${project}. Nothing was started. Centralu shows the person how, and tells you when ${project} is trusted; give it again then.`,
} as const

/** The text of a task written for a report mark an earlier build left with no task (§9.5) */
export const ADOPTED_TASK = 'Work given before this version of Centralu wrote it down as mail. The conversation of the session that does it shows what was asked.'

/** The line an over-long task ends with once cut: the full text stays in the session's conversation */
export const TASK_CUT = "\n[Centralu: cut here. The full task is in the session's conversation (read_session).]"

/** A task's text as the record keeps it (trimmed, and cut at `limit` with `TASK_CUT`): a delegation tool has started the child already, so it is never refused for its length */
export function cutTask(text: string, limit: number): string {
  const task = text.trim()
  return task.length > limit ? task.slice(0, limit - TASK_CUT.length) + TASK_CUT : task
}

/** The first line of a text on one line, cut at `max`: how a message or a call is quoted in a notice, a card or a record */
export function firstLineOf(text: string, max = Infinity): string {
  return oneLineText(text.split(/\r\n|[\n\r]/)[0] ?? '', max)
}

/**
 * Whether a message wakes a receiver at rest (D3): unless Centralu or an app marked it `facts.quiet`. Replaces `wakes`, whose rules for an app's
 * notice and an old report the adoption has already folded into `quiet` (§6.3), so the kind needs no word here
 */
export function wakesMessage(m: Pick<MailRow, 'facts'>): boolean {
  return m.facts.quiet !== true
}

/**
 * Whether an answer is delivered quietly (D3): it needs no reply, to a message that needed none, and nothing about its sender or its words says the
 * receiver must act. It wakes when it is `urgent`, from the person, from the receiver's parent, or from a session with an unsettled task to the receiver
 * (`owesTask`, which the caller reads with `newestTask`); and an answer to a task or to a `needsReply` message always wakes. An answer that is a
 * request to the orchestrator (`request`, §7.6) is work for it, so it never is quiet: D3 and §7.6 meet here
 */
export function quietAnswer(
  m: Pick<MailRow, 'kind' | 'sender' | 'needsReply' | 'urgent'>,
  target: Pick<MailRow, 'kind' | 'needsReply'>,
  receiver: { parent: string | null; owesTask: boolean; request: boolean },
): boolean {
  return (
    m.kind === 'message' && !m.needsReply && !m.urgent && !receiver.request && target.kind === 'message' && !target.needsReply &&
    parseAddress(m.sender)?.kind === 'session' && m.sender !== receiver.parent && !receiver.owesTask
  )
}

/**
 * The depth of a `message` (D9, §8.2 step 6): hops in a row of mail passed on to a party that did not write the mail answered. `cause` is the message
 * that started the sender's turn, `about` the messages a reminder or a notice to a sender is about (the caller loads them), `recipients` the new
 * message's. The person's word resets it (§10.10: the orchestrator relaying for the person is a pair, depth 0); a task, a report or another notice,
 * or no cause, gives 0; a follow-up adds none
 */
export function depthOf(cause: MailRow | null, about: readonly MailRow[], recipients: readonly string[]): number {
  if (!cause || cause.sender === PERSON) return 0
  const followUp = cause.kind === 'notice' && (cause.facts.reminder !== undefined || cause.facts.unanswered !== undefined)
  if (cause.kind !== 'message' && !followUp) return 0
  const base = followUp ? Math.max(0, ...about.map((m) => m.depth)) : cause.depth
  // A reminder answers its askers; a notice to a sender answers the receivers it lists
  const back = !followUp ? [cause.sender] : cause.facts.reminder !== undefined ? about.map((m) => m.sender) : (cause.facts.unanswered ?? []).map((u) => u.recipient)
  return recipients.every((r) => back.includes(r)) ? base : base + 1
}

/** One group of the receiver's work due now: a task, or for the orchestrator one asker's requests (`key`) */
export type WorkPick = {
  key: string
  /** The person's words, or urgent mail: they decide */
  decides: boolean
  /** A request to the orchestrator that waits for an answer (a task has no `needsReply`) */
  needsReply: boolean
  dueAt: number
}

/**
 * The one group of the receiver's work that a wake carries (§8.2 step 3), from the due work oldest first. Three classes, the lowest first, the oldest
 * group first within a class:
 *
 * 1. a group with the person's words or urgent mail, or one passed over for longer than the most its mail may wait (`HOLD_*`);
 * 2. a group with a request that waits for an answer;
 * 3. the rest.
 *
 * So a stream of newer requests cannot starve older work: past its hold a group moves up to the first class.
 */
export function pickWork(candidates: readonly WorkPick[], now: number): string | null {
  const classOf = new Map<string, 1 | 2 | 3>()
  for (const c of candidates) {
    const hold = c.needsReply ? HOLD_QUESTION_MS : HOLD_OTHER_MS
    const k = c.decides || now - c.dueAt > hold ? 1 : c.needsReply ? 2 : 3
    const was = classOf.get(c.key)
    if (was === undefined || k < was) classOf.set(c.key, k)
  }
  let best: string | null = null
  let bestClass = 4
  for (const [key, k] of classOf) {
    if (k < bestClass) {
      best = key
      bestClass = k
    }
  }
  return best
}

/**
 * Whether a body is inline in the wake (§8.2 step 4), after the frame and quoted: the person's words; a `task` from a session to a session that is
 * not the orchestrator; a `message` from the receiver's parent (`askedBy`) to a receiver that is not the orchestrator. Everything else is pulled
 * with `mail read`: a session's words to the orchestrator never flow down, whatever their kind
 */
export function flowsDownTo(f: { fromPerson: boolean; fromSession: boolean; kind: MailKind; toOrchestrator: boolean; fromParent: boolean }): boolean {
  if (f.fromPerson) return true
  if (!f.fromSession || f.toOrchestrator) return false
  return f.kind === 'task' || (f.kind === 'message' && f.fromParent)
}
