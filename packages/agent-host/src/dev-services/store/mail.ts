import type Database from 'better-sqlite3'
import { z } from 'zod'
import { JsonObject, readJson, readJsonList } from './json.js'
import { sweepMail, type MailSweepResult, type MailSweepLimits } from './mail-retention.js'

/*
 * The mailbox's rows (#1347, docs/plans/mailbox.md §4.1, store step v61): threads that are tasks, who is in them, what
 * blocks them, the messages, each recipient's receipt, and whose each turn was. This file holds the queries and the
 * shapes they hand out; the rules (who may post, how a state moves) are `mail/service.ts`.
 *
 * **A word this build does not know reads as a default, alone** (docs/stored-shapes.md): a newer build may write a
 * kind or an origin that does not exist here, and the host of a swap can be either. The row still reads. A thread's
 * state and outcome are the exception: they read as `unknown`, which refuses every change, because a default would say
 * something the newer build did not.
 */

export const THREAD_STATES = ['open', 'running', 'review', 'blocked', 'done'] as const
export type ThreadState = (typeof THREAD_STATES)[number]

/** How a `done` thread ended */
export const THREAD_OUTCOMES = ['finished', 'failed', 'stopped', 'dropped'] as const
export type ThreadOutcome = (typeof THREAD_OUTCOMES)[number]

/** What opened a thread (§3.3) */
export const THREAD_ORIGINS = ['mail', 'start_agent', 'agent_session', 'send_to_session', 'create_session', 'ask_project', 'app', 'watch', 'person'] as const
export type ThreadOrigin = (typeof THREAD_ORIGINS)[number]

/** §3.2 */
export const MESSAGE_KINDS = ['assign', 'question', 'answer', 'report', 'notice', 'note', 'event'] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

export const BLOCKER_KINDS = ['issue', 'pr', 'decision', 'thread', 'text'] as const
export type BlockerKind = (typeof BLOCKER_KINDS)[number]

export const PARTICIPANT_ROLES = ['owner', 'assignee', 'member'] as const
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number]

/** A GitHub issue and PR numbers a thread is about (§3.3 `links`, the queue's `links.pr = [N, A, B]`, §8.3). Other fields are kept */
export type MailLinks = { issue?: number[]; pr?: number[] } & Record<string, unknown>

/**
 * What only Centralu writes about a message (§3.2 `facts`): `outcome` of a turn's report, `about` (the session and the
 * answer's seq it is about), an error's kind, a task count, a blocker ref, `waitingOn` threads and `paused` tasks (§6),
 * and for a state change `from` / `to`. Every field is optional and an unknown one is kept
 */
export type MailFacts = Record<string, unknown>

export type ThreadRow = {
  id: string
  /** The host that owns the task fields (§11.3); this host's own id when the thread is local */
  home: string
  projectId: string | null
  subject: string
  origin: ThreadOrigin
  depth: number
  parentId: string | null
  /** The done threads this one follows up (§3.3) */
  follows: string[]
  /** `unknown` for a state a newer build wrote: the thread reads, and refuses every write (docs/stored-shapes.md) */
  state: ThreadState | 'unknown'
  /** `unknown` for an outcome this build does not know: it does not say `finished` for it */
  outcome: ThreadOutcome | 'unknown' | null
  owner: string
  assignee: string | null
  next: string | null
  links: MailLinks
  /** Bumped on every task-field change (§11.6) */
  rev: number
  /** When the person pinned a done thread so retention keeps it; null when it is not */
  pinnedAt: number | null
  createdAt: number
  updatedAt: number
  /** When `state` last changed */
  stateSince: number
  doneAt: number | null
}

export type ParticipantRow = {
  threadId: string
  address: string
  role: ParticipantRole
  joinedAt: number
  leftAt: number | null
  /** The last message of the thread this party has read: where `mail read` goes on from */
  readSeq: number
}

export type BlockerRow = { threadId: string; n: number; kind: BlockerKind; ref: string | null; text: string; resolvedAt: number | null }

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

export type ReceiptRow = {
  messageId: string
  recipient: string
  dueAt: number
  attemptAt: number | null
  deliveredAt: number | null
  readAt: number | null
  handledAt: number | null
  held: string | null
  attempts: number
  lastError: string | null
}

/** A receipt with the message it is for and the thread that message is in: what a delivery re-reads at drain time (§7.5) */
export type PendingMail = { receipt: ReceiptRow; message: MessageRow; thread: ThreadRow }

export type TurnRow = { sessionId: string; turnSeq: number; threadId: string | null; startedBy: string; startedAt: number; endedAt: number | null; outcome: string | null }

/** The member of `list` that `value` is, or `fallback` for a word this build does not know */
function oneOf<T extends string>(list: readonly T[], value: string | null | undefined, fallback: T): T {
  return list.find((x) => x === value) ?? fallback
}

/** `links` as stored: an object, with `issue` and `pr` kept only when they are lists of numbers; any other field is kept */
function linksOf(raw: string): MailLinks {
  const links: MailLinks = { ...readJson(raw, JsonObject, {}) }
  for (const key of ['issue', 'pr'] as const) {
    const value = links[key]
    if (value !== undefined && !(Array.isArray(value) && value.every((n) => typeof n === 'number'))) delete links[key]
  }
  return links
}

type ThreadSql = {
  id: string
  home: string
  project_id: string | null
  subject: string
  origin: string
  depth: number
  parent_id: string | null
  follows: string | null
  state: string
  outcome: string | null
  owner: string
  assignee: string | null
  next_step: string | null
  links: string
  rev: number
  pinned_at: number | null
  created_at: number
  updated_at: number
  state_since: number
  done_at: number | null
}

type ParticipantSql = { thread_id: string; address: string; role: string; joined_at: number; left_at: number | null; read_seq: number }

type BlockerSql = { thread_id: string; n: number; kind: string; ref: string | null; text: string; resolved_at: number | null }

type MessageSql = {
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

type ReceiptSql = {
  message_id: string
  recipient: string
  due_at: number
  attempt_at: number | null
  delivered_at: number | null
  read_at: number | null
  handled_at: number | null
  held: string | null
  attempts: number
  last_error: string | null
}

/** A state or an outcome this build does not know is `unknown`, not a default that says something: it reads, and refuses writes */
function stateOf(word: string): ThreadRow['state'] {
  return THREAD_STATES.find((x) => x === word) ?? 'unknown'
}

function outcomeOf(word: string | null): ThreadRow['outcome'] {
  if (word === null) return null
  return THREAD_OUTCOMES.find((x) => x === word) ?? 'unknown'
}

const toThread = (r: ThreadSql): ThreadRow => ({
  id: r.id,
  home: r.home,
  projectId: r.project_id,
  subject: r.subject,
  origin: oneOf(THREAD_ORIGINS, r.origin, 'mail'),
  depth: r.depth,
  parentId: r.parent_id,
  follows: readJsonList(r.follows, z.string()),
  state: stateOf(r.state),
  outcome: outcomeOf(r.outcome),
  owner: r.owner,
  assignee: r.assignee,
  next: r.next_step,
  links: linksOf(r.links),
  rev: r.rev,
  pinnedAt: r.pinned_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  stateSince: r.state_since,
  doneAt: r.done_at,
})

const toBlocker = (r: BlockerSql): BlockerRow => ({
  threadId: r.thread_id,
  n: r.n,
  kind: oneOf(BLOCKER_KINDS, r.kind, 'text'),
  ref: r.ref,
  text: r.text,
  resolvedAt: r.resolved_at,
})

const toMessage = (r: MessageSql): MessageRow => ({
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

const toReceipt = (r: ReceiptSql): ReceiptRow => ({
  messageId: r.message_id,
  recipient: r.recipient,
  dueAt: r.due_at,
  attemptAt: r.attempt_at,
  deliveredAt: r.delivered_at,
  readAt: r.read_at,
  handledAt: r.handled_at,
  held: r.held,
  attempts: r.attempts,
  lastError: r.last_error,
})

/** A new thread: `rev` starts at 0 and the three times at `now` */
export type NewThread = Omit<ThreadRow, 'rev' | 'pinnedAt' | 'createdAt' | 'updatedAt' | 'stateSince' | 'doneAt' | 'outcome' | 'state'> & {
  state: ThreadState
  outcome?: ThreadOutcome | null
}

/** A message to store: the sender's side and Centralu's `facts`. `seq` is given by the store */
export type NewMessage = Omit<MessageRow, 'seq' | 'homeSeq'>

/** The fields of a thread a change may set. Each moves `updated_at`; the task ones bump `rev` (the service decides which) */
export type ThreadPatch = Partial<
  Pick<ThreadRow, 'subject' | 'owner' | 'assignee' | 'next' | 'links' | 'stateSince' | 'doneAt' | 'pinnedAt' | 'depth' | 'parentId'> & {
    state: ThreadState
    outcome: ThreadOutcome
  }
>

export class MailRecords {
  constructor(private readonly db: Database.Database) {}

  /**
   * One unit of work: everything a post or a state change writes (the message, its receipts, the thread, the event it
   * leaves) commits together or not at all. `immediate`, so two writers cannot both read the same next `seq`
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate()
  }

  // ── Threads ──

  insertThread(t: NewThread, now: number): void {
    this.db
      .prepare(
        `INSERT INTO mail_threads (id, home, project_id, subject, origin, depth, parent_id, follows, state, outcome, owner, assignee, next_step, links, rev,
                                   created_at, updated_at, state_since)
         VALUES (@id, @home, @projectId, @subject, @origin, @depth, @parentId, @follows, @state, @outcome, @owner, @assignee, @next, @links, 0, @now, @now, @now)`,
      )
      .run({
        id: t.id,
        home: t.home,
        projectId: t.projectId,
        subject: t.subject,
        origin: t.origin,
        depth: t.depth,
        parentId: t.parentId,
        follows: t.follows.length > 0 ? JSON.stringify(t.follows) : null,
        state: t.state,
        outcome: t.outcome ?? null,
        owner: t.owner,
        assignee: t.assignee,
        next: t.next,
        links: JSON.stringify(t.links),
        now,
      })
  }

  /** The parties that own or are assigned a thread that is not done: whom the sweep asks whether they are still here */
  partiesOfOpenThreads(): string[] {
    return this.db
      .prepare<[], { address: string }>(
        `SELECT owner AS address FROM mail_threads WHERE state != 'done'
         UNION SELECT assignee FROM mail_threads WHERE state != 'done' AND assignee IS NOT NULL`,
      )
      .all()
      .map((r) => r.address)
  }

  /** Whether there is a thread at all: a host that never made mail has nothing to move when a session goes */
  hasThreads(): boolean {
    return !!this.db.prepare<[], { one: number }>(`SELECT 1 AS one FROM mail_threads LIMIT 1`).get()
  }

  thread(id: string): ThreadRow | undefined {
    const row = this.db.prepare<[string], ThreadSql>(`SELECT * FROM mail_threads WHERE id = ?`).get(id)
    return row && toThread(row)
  }

  /** Threads a party owns or is assigned, optionally in some states: what the party's departure moves (§3.3) */
  threadsOfParty(address: string, role: 'owner' | 'assignee', states?: readonly ThreadRow['state'][]): ThreadRow[] {
    const column = role === 'owner' ? 'owner' : 'assignee'
    const rows = this.db.prepare<[string], ThreadSql>(`SELECT * FROM mail_threads WHERE ${column} = ? ORDER BY created_at, id`).all(address)
    return rows.map(toThread).filter((t) => !states || states.includes(t.state))
  }

  /** The threads that name `id` in `follows` (§3.3: "shown both ways") */
  threadsFollowing(id: string): ThreadRow[] {
    const rows = this.db
      .prepare<[string], ThreadSql>(
        `SELECT t.* FROM mail_threads t WHERE t.follows IS NOT NULL AND json_valid(t.follows) AND EXISTS (SELECT 1 FROM json_each(t.follows) WHERE value = ?) ORDER BY t.created_at, t.id`,
      )
      .all(id)
    return rows.map(toThread)
  }

  /** Sets the given fields; `bumpRev` for a change to the task's own fields (§11.6). Returns the thread after the change */
  updateThread(id: string, patch: ThreadPatch, now: number, bumpRev: boolean): ThreadRow {
    const sets: string[] = ['updated_at = @now']
    const args: Record<string, unknown> = { id, now }
    const set = (column: string, key: string, value: unknown) => {
      sets.push(`${column} = @${key}`)
      args[key] = value
    }
    if (patch.subject !== undefined) set('subject', 'subject', patch.subject)
    if (patch.state !== undefined) set('state', 'state', patch.state)
    if (patch.outcome !== undefined) set('outcome', 'outcome', patch.outcome)
    if (patch.owner !== undefined) set('owner', 'owner', patch.owner)
    if (patch.assignee !== undefined) set('assignee', 'assignee', patch.assignee)
    if (patch.next !== undefined) set('next_step', 'next', patch.next)
    if (patch.links !== undefined) set('links', 'links', JSON.stringify(patch.links))
    if (patch.stateSince !== undefined) set('state_since', 'stateSince', patch.stateSince)
    if (patch.doneAt !== undefined) set('done_at', 'doneAt', patch.doneAt)
    if (patch.pinnedAt !== undefined) set('pinned_at', 'pinnedAt', patch.pinnedAt)
    if (patch.depth !== undefined) set('depth', 'depth', patch.depth)
    if (patch.parentId !== undefined) set('parent_id', 'parentId', patch.parentId)
    if (bumpRev) sets.push('rev = rev + 1')
    this.db.prepare(`UPDATE mail_threads SET ${sets.join(', ')} WHERE id = @id`).run(args)
    const after = this.thread(id)
    if (!after) throw new Error(`mail thread ${id} is gone`)
    return after
  }

  // ── Participants ──

  participants(threadId: string): ParticipantRow[] {
    const rows = this.db
      .prepare<[string], ParticipantSql>(
        `SELECT thread_id, address, role, joined_at, left_at, read_seq FROM mail_participants WHERE thread_id = ? ORDER BY joined_at, address`,
      )
      .all(threadId)
    return rows.map((r) => ({
      threadId: r.thread_id,
      address: r.address,
      // A role this build does not know is the weakest one, alone: it may read and post, and moves nothing
      role: oneOf(PARTICIPANT_ROLES, r.role, 'member'),
      joinedAt: r.joined_at,
      leftAt: r.left_at,
      readSeq: r.read_seq,
    }))
  }

  /** Adds a participant, or brings one who left back with the new role. The owner and assignee roles are kept apart from `member` by the caller */
  putParticipant(threadId: string, address: string, role: ParticipantRole, now: number): void {
    this.db
      .prepare(
        `INSERT INTO mail_participants (thread_id, address, role, joined_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(thread_id, address) DO UPDATE SET role = excluded.role, left_at = NULL`,
      )
      .run(threadId, address, role, now)
  }

  /** Adds a participant who is not in the thread; one who is (or was) keeps the row, and so the role it has */
  putParticipantIfAbsent(threadId: string, address: string, role: ParticipantRole, now: number): void {
    this.db
      .prepare(`INSERT INTO mail_participants (thread_id, address, role, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, address) DO UPDATE SET left_at = NULL`)
      .run(threadId, address, role, now)
  }

  /** Marks a participant as having left (kept, so the history still names them) */
  leaveParticipant(threadId: string, address: string, now: number): void {
    this.db.prepare(`UPDATE mail_participants SET left_at = ? WHERE thread_id = ? AND address = ? AND left_at IS NULL`).run(now, threadId, address)
  }

  // ── Blockers ──

  blockers(threadId: string): BlockerRow[] {
    return this.db
      .prepare<[string], BlockerSql>(`SELECT thread_id, n, kind, ref, text, resolved_at FROM mail_blockers WHERE thread_id = ? ORDER BY n`)
      .all(threadId)
      .map(toBlocker)
  }

  insertBlocker(b: Omit<BlockerRow, 'resolvedAt'>): void {
    this.db.prepare(`INSERT INTO mail_blockers (thread_id, n, kind, ref, text) VALUES (?, ?, ?, ?, ?)`).run(b.threadId, b.n, b.kind, b.ref, b.text)
  }

  /** Returns whether a blocker was open and is now resolved */
  resolveBlocker(threadId: string, n: number, now: number): boolean {
    return this.db.prepare(`UPDATE mail_blockers SET resolved_at = ? WHERE thread_id = ? AND n = ? AND resolved_at IS NULL`).run(now, threadId, n).changes > 0
  }

  /**
   * Unresolved `thread` blockers that name a thread this store does not hold. Those naming a thread of this host were
   * swept by retention and count as resolved (§3.3); the caller tells them from a thread of another host by the id
   */
  blockersOnMissingThreads(): BlockerRow[] {
    return this.db
      .prepare<[], BlockerSql>(
        `SELECT b.thread_id, b.n, b.kind, b.ref, b.text, b.resolved_at FROM mail_blockers b
          WHERE b.kind = 'thread' AND b.resolved_at IS NULL AND b.ref IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM mail_threads t WHERE t.id = b.ref)`,
      )
      .all()
      .map(toBlocker)
  }

  /** The unresolved `thread` blockers, in any thread, that wait for this one to end (§3.3) */
  blockersWaitingFor(threadId: string): BlockerRow[] {
    return this.db
      .prepare<[string], BlockerSql>(
        `SELECT thread_id, n, kind, ref, text, resolved_at FROM mail_blockers WHERE kind = 'thread' AND ref = ? AND resolved_at IS NULL ORDER BY thread_id, n`,
      )
      .all(threadId)
      .map(toBlocker)
  }

  /**
   * The state a thread was in when it was last blocked, read from the `event` that moved it (its facts name `from`): what a
   * thread goes back to when its last blocker is resolved. Undefined when no event says
   */
  stateBeforeBlocked(threadId: string): ThreadState | undefined {
    const row = this.db
      .prepare<[string], { before: string | null }>(
        `SELECT json_extract(facts, '$.from') AS before FROM mail_messages
          WHERE thread_id = ? AND kind = 'event' AND json_valid(facts)
            AND json_extract(facts, '$.change') = 'state' AND json_extract(facts, '$.to') = 'blocked'
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(threadId)
    const before = THREAD_STATES.find((x) => x === row?.before)
    return before === 'blocked' || before === 'done' ? undefined : before
  }

  // ── Messages ──

  /** Stores a message at the thread's next `seq`; `homeSeq` is the same, the thread being local. Returns the stored message */
  insertMessage(m: NewMessage): MessageRow {
    const next = this.db.prepare<[string], { n: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM mail_messages WHERE thread_id = ?`).get(m.threadId)
    const seq = next?.n ?? 1
    this.db
      .prepare(
        `INSERT INTO mail_messages (id, thread_id, seq, home_seq, sender, kind, urgent, needs_owner, wake, reply_to, body, facts, dedupe_key, created_at)
         VALUES (@id, @threadId, @seq, @seq, @sender, @kind, @urgent, @needsOwner, @wake, @replyTo, @body, @facts, @dedupeKey, @createdAt)`,
      )
      .run({
        id: m.id,
        threadId: m.threadId,
        seq,
        sender: m.sender,
        kind: m.kind,
        urgent: m.urgent ? 1 : 0,
        needsOwner: m.needsOwner ? 1 : 0,
        wake: m.wake,
        replyTo: m.replyTo,
        body: m.body,
        facts: JSON.stringify(m.facts),
        dedupeKey: m.dedupeKey,
        createdAt: m.createdAt,
      })
    return { ...m, seq, homeSeq: seq }
  }

  /** How many messages `sender` posted since the id `floor` (see `messageIdFloor`): the rate a sender is held to, counted in the store (§7.9) */
  postsSince(sender: string, host: string, floor: string): number {
    const row = this.db
      .prepare<[string, string, string], { n: number }>(`SELECT COUNT(*) AS n FROM mail_messages WHERE id >= ? AND id < ? AND sender = ?`)
      .get(floor, `${host}.m_~`, sender)
    return row?.n ?? 0
  }

  /** The latest message `sender` posted in the thread */
  lastBy(threadId: string, sender: string): MessageRow | undefined {
    const row = this.db
      .prepare<[string, string], MessageSql>(`SELECT * FROM mail_messages WHERE thread_id = ? AND sender = ? ORDER BY seq DESC LIMIT 1`)
      .get(threadId, sender)
    return row && toMessage(row)
  }

  message(id: string): MessageRow | undefined {
    const row = this.db.prepare<[string], MessageSql>(`SELECT * FROM mail_messages WHERE id = ?`).get(id)
    return row && toMessage(row)
  }

  /** A key is the sender's own: another sender's message under the same key is not this one */
  messageByDedupeKey(threadId: string, sender: string, key: string): MessageRow | undefined {
    const row = this.db
      .prepare<[string, string, string], MessageSql>(`SELECT * FROM mail_messages WHERE thread_id = ? AND sender = ? AND dedupe_key = ?`)
      .get(threadId, sender, key)
    return row && toMessage(row)
  }

  /** The message that opened a thread, found by its sender's key: a thread opened twice under one key is one thread */
  openingMessageByDedupeKey(sender: string, key: string): MessageRow | undefined {
    const row = this.db
      .prepare<[string, string], MessageSql>(`SELECT * FROM mail_messages WHERE sender = ? AND dedupe_key = ? AND seq = 1`)
      .get(sender, key)
    return row && toMessage(row)
  }

  /** A thread's messages after `seq`, oldest first */
  messagesAfter(threadId: string, seq: number, limit = 500): MessageRow[] {
    return this.db
      .prepare<[string, number, number], MessageSql>(`SELECT * FROM mail_messages WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(threadId, seq, limit)
      .map(toMessage)
  }

  // ── Receipts ──

  insertReceipt(messageId: string, recipient: string, dueAt: number): void {
    this.db.prepare(`INSERT INTO mail_receipts (message_id, recipient, due_at) VALUES (?, ?, ?)`).run(messageId, recipient, dueAt)
  }

  receiptsOf(messageId: string): ReceiptRow[] {
    return this.db.prepare<[string], ReceiptSql>(`SELECT * FROM mail_receipts WHERE message_id = ? ORDER BY recipient`).all(messageId).map(toReceipt)
  }

  /**
   * Where `mail read` goes on from: the participant's own position. A party with no row in the thread (the person, from the
   * Inbox, who keeps its own place with `after`) goes on from the highest message it has a read receipt for. The position
   * is kept on the participant, not worked out from receipts, because a party has no receipt for what it sent or for what
   * was posted before it joined, and a reply marks receipts read that were never returned
   */
  readPosition(threadId: string, address: string): number {
    const own = this.db
      .prepare<[string, string], { s: number }>(`SELECT read_seq AS s FROM mail_participants WHERE thread_id = ? AND address = ?`)
      .get(threadId, address)
    // A participant's position is its own: a receipt marked read by a reply or a close says nothing of what was returned to it
    if (own) return own.s
    const receipts = this.db
      .prepare<[string, string], { s: number | null }>(
        `SELECT MAX(m.seq) AS s FROM mail_receipts r JOIN mail_messages m ON m.id = r.message_id
          WHERE m.thread_id = ? AND r.recipient = ? AND r.read_at IS NOT NULL`,
      )
      .get(threadId, address)
    return receipts?.s ?? 0
  }

  /** Moves a participant's read position forward, never back */
  setReadPosition(threadId: string, address: string, seq: number): void {
    this.db.prepare(`UPDATE mail_participants SET read_seq = MAX(read_seq, ?) WHERE thread_id = ? AND address = ?`).run(seq, threadId, address)
  }

  /** Marks `recipient`'s receipts for exactly these messages read (not handled), keeping an earlier read time */
  markRead(recipient: string, messageIds: readonly string[], now: number): number {
    return this.db
      .prepare(`UPDATE mail_receipts SET read_at = COALESCE(read_at, ?) WHERE recipient = ? AND message_id IN (SELECT value FROM json_each(?))`)
      .run(now, recipient, JSON.stringify(messageIds)).changes
  }

  /**
   * Marks them handled, and read when they were not: handling a message means it was read (§7.6). With `onlyRead`, only
   * those already read: a reply answers what its sender has read, not what is still waiting for it
   */
  markHandled(threadId: string, recipient: string, upToSeq: number, now: number, onlyRead = false): number {
    return this.db
      .prepare(
        `UPDATE mail_receipts SET handled_at = COALESCE(handled_at, ?), read_at = COALESCE(read_at, ?)
          WHERE recipient = ? AND handled_at IS NULL AND (? = 0 OR read_at IS NOT NULL)
            AND message_id IN (SELECT id FROM mail_messages WHERE thread_id = ? AND seq <= ?)`,
      )
      .run(now, now, recipient, onlyRead ? 1 : 0, threadId, upToSeq).changes
  }

  /** The mailboxes that have mail waiting (not read, handled, delivered or held): who the delivery sweep looks at */
  recipientsWithMail(): string[] {
    return this.db
      .prepare<[], { recipient: string }>(
        `SELECT DISTINCT recipient FROM mail_receipts
          WHERE delivered_at IS NULL AND read_at IS NULL AND handled_at IS NULL AND (held IS NULL OR held = 'released')`,
      )
      .all()
      .map((r) => r.recipient)
  }

  /**
   * When the first of `recipient`'s waiting mail that is not due yet becomes due, or null for none: when to look at its
   * mailbox next. Mail already due is not counted: it was looked at, and may be waiting for its receiver, not for the clock
   */
  nextDue(recipient: string, after: number): number | null {
    const row = this.db
      .prepare<[string, number], { due: number | null }>(
        `SELECT MIN(due_at) AS due FROM mail_receipts
          WHERE recipient = ? AND due_at > ? AND delivered_at IS NULL AND read_at IS NULL AND handled_at IS NULL AND (held IS NULL OR held = 'released')`,
      )
      .get(recipient, after)
    return row?.due ?? null
  }

  /** Whether any of `recipient`'s waiting mail is due by `now` */
  hasDue(recipient: string, now: number): boolean {
    return !!this.db
      .prepare<[string, number], { one: number }>(
        `SELECT 1 AS one FROM mail_receipts
          WHERE recipient = ? AND due_at <= ? AND delivered_at IS NULL AND read_at IS NULL AND handled_at IS NULL AND (held IS NULL OR held = 'released') LIMIT 1`,
      )
      .get(recipient, now)
  }

  /** Written, and committed, before a delivery is tried (§7.6.1): a host that dies after it and before `markDelivered` leaves a delivery that may have gone */
  markAttempt(recipient: string, messageIds: readonly string[], now: number): void {
    this.db
      .prepare(`UPDATE mail_receipts SET attempt_at = ?, attempts = attempts + 1 WHERE recipient = ? AND message_id IN (SELECT value FROM json_each(?))`)
      .run(now, recipient, JSON.stringify(messageIds))
  }

  /** The tool took them (§7.6.2–4): delivered, and read for those whose words went in whole. A failed attempt's error is forgotten */
  markDelivered(recipient: string, messageIds: readonly string[], readIds: readonly string[], now: number): void {
    this.db
      .prepare(`UPDATE mail_receipts SET delivered_at = ?, last_error = NULL WHERE recipient = ? AND message_id IN (SELECT value FROM json_each(?))`)
      .run(now, recipient, JSON.stringify(messageIds))
    this.markRead(recipient, readIds, now)
  }

  /** How many times the most-tried of these has been attempted: when to give up and hold for the person */
  attemptsOf(recipient: string, messageIds: readonly string[]): number {
    const row = this.db
      .prepare<[string, string], { n: number | null }>(`SELECT MAX(attempts) AS n FROM mail_receipts WHERE recipient = ? AND message_id IN (SELECT value FROM json_each(?))`)
      .get(recipient, JSON.stringify(messageIds))
    return row?.n ?? 0
  }

  /**
   * A delivery the tool failed after all (late, once it was counted as taken): the receipts that delivery marked delivered at
   * `deliveredAt` are unread and undelivered again, unless handled or held for the person since. Mail delivered again by a later
   * wake has another time and is left alone. Returns the ids put back
   */
  undeliver(recipient: string, messageIds: readonly string[], deliveredAt: number): string[] {
    const ids = JSON.stringify(messageIds)
    const where = `recipient = ? AND delivered_at = ? AND handled_at IS NULL AND (held IS NULL OR held = 'released') AND message_id IN (SELECT value FROM json_each(?))`
    const put = this.db.prepare<[string, number, string], { message_id: string }>(`SELECT message_id FROM mail_receipts WHERE ${where}`).all(recipient, deliveredAt, ids).map((r) => r.message_id)
    this.db.prepare(`UPDATE mail_receipts SET delivered_at = NULL, read_at = NULL WHERE ${where}`).run(recipient, deliveredAt, ids)
    return put
  }

  /** The tool did not take them: tried again at `retryAt`, the error kept for the Inbox. Not "uncertain": nothing went */
  failAttempt(recipient: string, messageIds: readonly string[], error: string, retryAt: number): void {
    this.db
      .prepare(`UPDATE mail_receipts SET attempt_at = NULL, last_error = ?, due_at = ? WHERE recipient = ? AND message_id IN (SELECT value FROM json_each(?))`)
      .run(error, retryAt, recipient, JSON.stringify(messageIds))
  }

  /** A try that was not made after all (the receiver left rest while it was being woken): the attempt is taken back, and it counts for nothing */
  undoAttempt(recipient: string, messageIds: readonly string[]): void {
    this.db
      .prepare(`UPDATE mail_receipts SET attempt_at = NULL, attempts = MAX(attempts - 1, 0) WHERE recipient = ? AND delivered_at IS NULL AND message_id IN (SELECT value FROM json_each(?))`)
      .run(recipient, JSON.stringify(messageIds))
  }

  /** Sets why mail waits for a person's act (`policy`, `failed`, `loop`, `budget`, `uncertain`), or clears it with null */
  setHeld(recipient: string, messageIds: readonly string[], held: string | null): void {
    this.db
      .prepare(`UPDATE mail_receipts SET held = ? WHERE recipient = ? AND message_id IN (SELECT value FROM json_each(?))`)
      .run(held, recipient, JSON.stringify(messageIds))
  }

  /** Deliveries that were tried and not known to have gone: what a host that starts finds a previous one left (§7.6.5) */
  attemptedUnconfirmed(): ReceiptRow[] {
    return this.db
      .prepare<[], ReceiptSql>(
        `SELECT * FROM mail_receipts WHERE attempt_at IS NOT NULL AND delivered_at IS NULL AND read_at IS NULL AND handled_at IS NULL AND (held IS NULL OR held = 'released')`,
      )
      .all()
      .map(toReceipt)
  }

  /** A delivery that may have gone and may not: held until the person says (§7.6.5) */
  markUncertain(recipient: string, messageIds: readonly string[]): void {
    this.db
      .prepare(`UPDATE mail_receipts SET held = 'uncertain', attempt_at = NULL WHERE recipient = ? AND message_id IN (SELECT value FROM json_each(?))`)
      .run(recipient, JSON.stringify(messageIds))
  }

  /** A delivery that may have gone, of mail that starts no work: tried again, and its next frame says it may be a repeat (§7.6.5) */
  markMaybeRepeated(recipient: string, messageIds: readonly string[], dueAt: number): void {
    this.db
      .prepare(`UPDATE mail_receipts SET attempt_at = NULL, last_error = 'maybe_repeated', due_at = ? WHERE recipient = ? AND message_id IN (SELECT value FROM json_each(?))`)
      .run(dueAt, recipient, JSON.stringify(messageIds))
  }

  /**
   * The person's answer to held mail: sent now, or never (`dismissed`). Only mail held for a reason that needs them. Sent now,
   * mail that was held back from waking a session (`policy`, `budget`) goes as the mail it is and is not held again (`released`)
   */
  releaseHeld(recipient: string, messageIds: readonly string[], to: null | 'released' | 'dismissed', dueAt: number): number {
    return this.db
      .prepare(
        `UPDATE mail_receipts SET delivered_at = CASE WHEN held IN ('policy', 'budget') THEN NULL ELSE delivered_at END,
               held = CASE WHEN ? IS NULL AND held IN ('policy', 'budget') THEN 'released' ELSE ? END, attempt_at = NULL, last_error = NULL, attempts = 0, due_at = ?
          WHERE recipient = ? AND held IN ('uncertain', 'failed', 'loop', 'budget', 'policy') AND message_id IN (SELECT value FROM json_each(?))`,
      )
      .run(to, to, dueAt, recipient, JSON.stringify(messageIds)).changes
  }

  /** Receipts the Inbox lists for a person to act on: held for a reason that needs them (§7.6, §7.7, §7.9) */
  heldReceipts(): ReceiptRow[] {
    return this.db
      .prepare<[], ReceiptSql>(`SELECT * FROM mail_receipts WHERE held IS NOT NULL AND held NOT IN ('released', 'dismissed') AND read_at IS NULL AND handled_at IS NULL ORDER BY due_at`)
      .all()
      .map(toReceipt)
  }

  /**
   * What `recipient` has not read or handled, with its message and thread, oldest first: the rows a delivery re-reads at
   * drain time to build the frame from what is true then (§7.5). Not those already delivered (unless `again`, for a wake
   * that points at what has not been read yet, §7.6.6), not those held, and not those not yet due
   */
  pendingFor(recipient: string, now: number, again = false): PendingMail[] {
    const rows = this.db
      .prepare<[string, number, number], ReceiptSql>(
        `SELECT r.* FROM mail_receipts r JOIN mail_messages m ON m.id = r.message_id
          WHERE r.recipient = ? AND r.read_at IS NULL AND r.handled_at IS NULL AND (r.held IS NULL OR r.held = 'released') AND r.due_at <= ?
            AND (r.delivered_at IS NULL OR ? = 1)
          ORDER BY m.created_at, m.thread_id, m.seq`,
      )
      .all(recipient, now, again ? 1 : 0)
    const out: PendingMail[] = []
    for (const row of rows) {
      const message = this.message(row.message_id)
      const thread = message && this.thread(message.threadId)
      if (message && thread) out.push({ receipt: toReceipt(row), message, thread })
    }
    return out
  }

  // ── Turns (§6) ──

  /** Whether a turn of the thread is going: what a cleared blocker restores `running` from (§3.3). Uses `mail_turns_open` */
  hasOpenTurn(threadId: string): boolean {
    return !!this.db.prepare<[string], { one: number }>(`SELECT 1 AS one FROM mail_turns WHERE thread_id = ? AND ended_at IS NULL LIMIT 1`).get(threadId)
  }

  startTurn(t: Omit<TurnRow, 'endedAt' | 'outcome'>): void {
    this.db
      .prepare(`INSERT INTO mail_turns (session_id, turn_seq, thread_id, started_by, started_at) VALUES (?, ?, ?, ?, ?)`)
      .run(t.sessionId, t.turnSeq, t.threadId, t.startedBy, t.startedAt)
  }

  endTurn(sessionId: string, turnSeq: number, now: number, outcome: string): void {
    this.db.prepare(`UPDATE mail_turns SET ended_at = ?, outcome = ? WHERE session_id = ? AND turn_seq = ? AND ended_at IS NULL`).run(now, outcome, sessionId, turnSeq)
  }

  // ── Retention (§4.4) ──

  /** The sweep, in batches (`mail-retention.ts`). It deletes plain rows and moves nothing */
  sweep(now: number, limits?: Partial<MailSweepLimits>): MailSweepResult {
    return sweepMail(this.db, now, limits)
  }
}

export type { MailSweepLimits, MailSweepResult }
