import { JsonObject, readJson } from './json.js'

/*
 * What is left of the pre-mailbox thread world that live code still reads (docs/plans/mailbox.md §4.1, store step v61): the
 * words a thread was opened with and a message was of, and a message row as the v64 build stored it. `store/mailbox-adopt.ts`
 * moves what the old thread tables hold, and the origins name how a delegation is recorded. The tables stay until the M7
 * gate; the queries over them (`MailRecords`) and the retention sweep are gone, since only tests ran them.
 *
 * **A word this build does not know reads as a default** (docs/stored-shapes.md): a newer build may write a kind that does
 * not exist here, and the host of a swap can be either.
 */

/** What opened a thread (§3.3) */
export const THREAD_ORIGINS = ['mail', 'start_agent', 'agent_session', 'send_to_session', 'create_session', 'ask_project', 'app', 'watch', 'person'] as const
export type ThreadOrigin = (typeof THREAD_ORIGINS)[number]

/** The origins a session's delegation tools open threads with (§8.1): work one session gave another, written down by the host */
export const DELEGATION_ORIGINS = ['start_agent', 'agent_session', 'send_to_session', 'create_session', 'ask_project'] as const satisfies readonly ThreadOrigin[]

/** §3.2 */
export const MESSAGE_KINDS = ['assign', 'question', 'answer', 'report', 'notice', 'note', 'event'] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

/**
 * What only Centralu writes about a message (§3.2 `facts`): `outcome` of a turn's report, `about` (the session and the
 * answer's seq it is about), an error's kind, a task count, a blocker ref, `waitingOn` threads and `paused` tasks (§6),
 * and for a state change `from` / `to`. Every field is optional and an unknown one is kept
 */
export type MailFacts = Record<string, unknown>

export type MessageRow = {
  id: string
  threadId: string
  /** Its place in the thread as this host applied it */
  seq: number
  /** The place the thread's home gave it (§11.6); equal to `seq` when the thread is local */
  homeSeq: number | null
  sender: string
  kind: MessageKind
  urgent: boolean
  needsOwner: boolean
  /** An app's request about waking its receiver: 'yes', 'no', or null when it did not say (§9.5) */
  wake: 'yes' | 'no' | null
  replyTo: string | null
  body: string
  facts: MailFacts
  dedupeKey: string | null
  createdAt: number
}

export type MessageSql = {
  id: string
  thread_id: string
  seq: number
  home_seq: number | null
  sender: string
  kind: string
  urgent: number
  needs_owner: number
  wake: string | null
  reply_to: string | null
  body: string
  facts: string
  dedupe_key: string | null
  created_at: number
}

/** The member of `list` that `value` is, or `fallback` for a word this build does not know */
function oneOf<T extends string>(list: readonly T[], value: string | null | undefined, fallback: T): T {
  return list.find((x) => x === value) ?? fallback
}

export const toMessage = (r: MessageSql): MessageRow => ({
  id: r.id,
  threadId: r.thread_id,
  seq: r.seq,
  homeSeq: r.home_seq,
  sender: r.sender,
  kind: oneOf(MESSAGE_KINDS, r.kind, 'note'),
  urgent: r.urgent === 1,
  needsOwner: r.needs_owner === 1,
  wake: r.wake === 'yes' ? 'yes' : r.wake === 'no' ? 'no' : null,
  replyTo: r.reply_to,
  body: r.body,
  facts: readJson(r.facts, JsonObject, {}),
  dedupeKey: r.dedupe_key,
  createdAt: r.created_at,
})
