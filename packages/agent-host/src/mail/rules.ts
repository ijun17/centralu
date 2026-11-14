import { durationText } from '../timing.js'
import { createHash } from 'node:crypto'
import { oneLineText } from '@cc/protocol'
import { asObj } from '../json-value.js'
import { rpcError, type RpcError } from '../rpc-error.js'
import type { MessageKind } from '../dev-services/store/mail-types.js'
import type { MailKind, MailRow } from '../dev-services/store/mailbox.js'
import { isPerson, senderKind } from './address.js'

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
  'repeat',
  'ask_rate',
  'assistant_asks',
  'removed',
  'untrusted_project',
  'answered',
  // a pull request watch where gh is not installed or not signed in (§18.3)
  'unavailable',
] as const
export type MailRefusal = (typeof REFUSALS)[number]

/**
 * A refusal is an error with the protocol's `refused` code and a `data.reason` word the caller can act on: the host understood
 * the call and said no, which is not a fault and not worth a retry
 */
export function refuse(reason: MailRefusal, message: string, more: Record<string, unknown> = {}): RpcError {
  return rpcError(message, 'refused', { retryable: false, data: { reason, ...more } })
}

/** A refusal another computer gave in its own word (`MailAcross`): that word when the mailbox has it, else `elsewhere`, with the other side's text */
export function refuseAcross(why: string, text: string): RpcError {
  return refuse(REFUSALS.find((r) => r === why) ?? 'elsewhere', text)
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

/** The words of a `too_long` refusal, as the mailbox says them (`MessageService` and a mail to a parent on a hub, #2067) */
export function tooLongText(sender: SenderClass): string {
  return `a body from ${sender === 'app' ? 'an app' : 'this sender'} is at most ${bodyLimit(sender)} characters`
}

/** A sender's posts a minute (§7.9): 30 from a session, 10 from an app. The person and Centralu are not limited */
export function postsPerMinute(sender: SenderClass): number {
  return sender === 'session' ? 30 : sender === 'app' ? 10 : Infinity
}

/** A session's new requests to the Assistant an hour (§9.7, #1447) */
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
  return isPerson(m.sender) || m.kind === 'task' || m.kind === 'report' || m.needsReply || m.facts.needsOwner === true
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
/** The dedupe key of a notice sent at most once a clock hour: `key` and the hour `now` falls in (the warnings and refusals, §7.5) */
export const hourlyKey = (key: string, now: number): string => `${key}:${Math.floor(now / HOUR_MS) * HOUR_MS}`
/** What `read` with no id returns at most: 10 messages and about 20,000 characters, never half a message (§8.4); a chain back from a message, 9 ancestors */
export const READ_ITEMS = 10
export const READ_CHARS = 20_000
export const READ_CHAIN = 9
export const MAX_RECIPIENTS = 10
/** A session of an untrusted project writing outside it waits for the person to trust the project (D12); false holds and refuses nothing */
export const HOLD_UNTRUSTED_OUT = true
/**
 * Mail-started turns an hour, with no word from the person, past which Centralu writes the person one warning (#2014): between one pair of sessions,
 * and across the host. Mail is never held or deferred for them
 */
export const WARN_PAIR_TURNS_PER_HOUR = 20
export const WARN_HOST_TURNS_PER_HOUR = 120
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

/** A watch's limits (§18.7): checks at registration, answered in the call; nothing a watch posts is held */
export const WATCH = {
  perSession: 20,
  everyAtLeastMs: 10 * MINUTE_MS,
  aheadAtMostMs: 7 * 24 * HOUR_MS,
  /** How long a session or `every` watch lasts; setting it again extends it */
  lastsMs: 24 * HOUR_MS,
  noteChars: 300,
  /** How often the host asks gh for the pull requests watched (§18.3, owner 2026-11-13): once a minute, one call per pull request */
  prPollMs: MINUTE_MS,
  /** Firings to one session in an hour past which the person is warned once per clock hour */
  warnWakesPerHour: 6,
} as const

/** The words of the refusals mail itself raises (§15, S9 and S15), without the `Refused (<reason>): ` the tool puts in front. `name` is the address until the tool resolves names */
export const REFUSAL_TEXT = {
  gone: (address: string) => `${address} is gone: it is in the session archive or deleted.`,
  no_mailbox: () => 'that session cannot read mail: only an ordinary session in a project, or the Assistant, has the mail tool',
  // The mailbox here never writes to another computer's session: a session's mail tool sends it there (#2067 item 2), and this is what any other way of sending reads
  elsewhere: (address: string) => `${address} is on another computer, and only a session's mail tool sends mail there: nothing was written.`,
  answered: (id: string) => `${id} is answered already: a question is answered once. Write to say more.`,
  unknown_message: (id: string) => `there is no message ${id} you can read; check the id with mail(action="inbox").`,
  own_message: (id: string) => `${id} is your own message; say who it is for with to="…".`,
  recipients: () => `at most ${MAX_RECIPIENTS} recipients.`,
  not_allowed: () => 'that is not a party that takes mail',
  withheld: (id: string) => `${id} is a request: its words are shown in the turn it starts, and it is marked done there.`,
  not_yours: (id: string) => `you were not sent ${id} and did not send it.`,
  repeat: (name: string) => `you sent the same text to ${name} less than ${durationText(REPEAT_WINDOW_MS)} ago.`,
  ask_rate: () => `your project's sessions asked the Assistant ${ASKS_PER_HOUR} times in the last hour; wait, or write to the person.`,
  assistant_asks: () =>
    'the Assistant runs on a tool that cannot ask the person for each step of a request yet, so a session cannot ask it: write to the person instead',
  untrusted_project: (project: string, target: string) =>
    `your project ${project} is not trusted, so work you give outside it (to ${target}) waits for the person to trust ${project}. Nothing was started. Centralu shows the person how, and tells you when ${project} is trusted; give it again then.`,
} as const

/** Centralu's warning to the person (#2014): what ran on, and that nothing was stopped */
export const WARNING_TEXT = {
  pair: (a: string, b: string, turns: number) =>
    `${a} and ${b} started ${turns} turns of each other by mail in the last hour, with no word from you. Their mail still goes: write to either, or stop one, if they are going round in circles.`,
  host: (turns: number) =>
    `Mail between sessions started ${turns} turns on this computer in the last hour. It still goes: look at the busy sessions if that is more than you expect.`,
  compactCycles: (session: string, cycles: number) =>
    `${session} asked to compact its conversation and went on to its next step ${cycles} times in the last hour. It keeps working: look at it if that is more than you expect.`,
  watchWakes: (session: string, wakes: number) =>
    `${session}'s watches woke it ${wakes} times in the last hour. They keep firing: look at it if that is more than you expect.`,
  /** The three guards that refuse rather than warn (#1684, #2035): the person hears of the first refusal of each kind a clock hour */
  repeat: (sender: string, to: string) => `Centralu refused mail from ${sender} to ${to}: the same text again within ${durationText(REPEAT_WINDOW_MS)}. ${sender} was told; nothing else was stopped.`,
  rate_limited: (sender: string, limit: number) => `Centralu refused mail from ${sender}: more than ${limit} messages in a minute. ${sender} was told to wait; nothing else was stopped.`,
  ask_rate: (sender: string) => `Centralu refused a request from ${sender} to the Assistant: its project's sessions asked ${ASKS_PER_HOUR} times in the last hour. ${sender} was told to wait or write to you.`,
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
 * request to the Assistant (`request`, §7.6) is work for it, so it never is quiet: D3 and §7.6 meet here
 */
export function quietAnswer(
  m: Pick<MailRow, 'kind' | 'sender' | 'needsReply' | 'urgent'>,
  target: Pick<MailRow, 'kind' | 'needsReply'>,
  receiver: { parent: string | null; owesTask: boolean; request: boolean },
): boolean {
  return (
    m.kind === 'message' && !m.needsReply && !m.urgent && !receiver.request && target.kind === 'message' && !target.needsReply &&
    senderKind(m.sender) === 'session' && m.sender !== receiver.parent && !receiver.owesTask
  )
}

/** One group of the receiver's work due now: a task, or for the Assistant one asker's requests (`key`) */
export type WorkPick = {
  key: string
  /** The person's words, or urgent mail: they decide */
  decides: boolean
  /** A request to the Assistant that waits for an answer (a task has no `needsReply`) */
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
 * not the Assistant; a `message` from the receiver's parent (`askedBy`) to a receiver that is not the Assistant; a watch's notice to the session that
 * set it (§18.5: Centralu's words and the session's own note). Everything else is pulled with `mail read`: a session's words to the Assistant never
 * flow down, whatever their kind
 */
export function flowsDownTo(f: { fromPerson: boolean; fromSession: boolean; kind: MailKind; toAssistant: boolean; fromParent: boolean; watch: boolean }): boolean {
  if (f.fromPerson || f.watch) return true
  if (!f.fromSession || f.toAssistant) return false
  return f.kind === 'task' || (f.kind === 'message' && f.fromParent)
}

/** The first 16 hex digits of the sha256 of the parts: the stable part of a Centralu dedupe key (§6.5) */
export function hash16(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}
