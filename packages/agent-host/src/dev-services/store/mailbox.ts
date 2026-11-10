import type Database from 'better-sqlite3'
import { z } from 'zod'
import { isObj } from '../../json-value.js'
import { parseAddress } from '../../mail/address.js'
import { parseJson } from './json.js'
import { oneRow, updateRecipientRows } from './rows.js'

/*
 * Mail without threads (#1684, docs/plans/mailbox.md §5, §6, store step v65): messages addressed to parties, and each
 * recipient's progress with one. This file holds the queries and the shapes they hand out; the rules (who may write,
 * what is held, what a reply settles) are the message service's (slice M2). Nothing outside `store/` reads these
 * tables before slice M3a.
 *
 * **A word this build does not know reads as a default** (docs/stored-shapes.md): a kind as `notice`, a `settled` word as
 * `legacy`, a release reason as null. A `facts` key that does not read is left out, and a `facts` that is not an object
 * reads as `{}` (`factsFrom`).
 */

export const MAIL_KINDS = ['message', 'task', 'report', 'notice'] as const
export type MailKind = (typeof MAIL_KINDS)[number]
export const SETTLED = ['answered', 'done', 'withdrawn', 'reported', 'gone', 'legacy'] as const
export type Settled = (typeof SETTLED)[number]
/**
 * Why Centralu stopped watching a row. `stopped` to `uncontinued` after `waiting` are the stops of a session (docs/plans/turn-owned-by-no-one.md §4.1):
 * the person's Stop, an error, a usage limit, the network, the tool's own interrupt, a quit or a shutdown, and a cut turn Centralu could not continue.
 * A build that does not know a word reads it as null
 */
export const RELEASE_WHY = ['reminders', 'waited', 'working', 'waiting', 'stopped', 'error', 'gone', 'lost', 'limit', 'network', 'interrupted', 'quit', 'shutdown', 'uncontinued'] as const
export type ReleaseWhy = (typeof RELEASE_WHY)[number]

/** What only Centralu writes about a message (§5.4). Every key optional; a key a newer build added is kept */
export const MailFacts = z.looseObject({
  outcome: z.enum(['finished', 'failed', 'stopped', 'paused', 'waiting']).optional(),
  about: z.object({ session: z.string() }).optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
  paused: z.number().optional(),
  waitingOn: z.number().optional(),
  personNote: z.boolean().optional(),
  answer: z.string().optional(),
  quiet: z.boolean().optional(),
  needsOwner: z.boolean().optional(),
  covers: z.array(z.string()).optional(),
  clarifies: z.string().optional(),
  hostCap: z.boolean().optional(),
  /** On Centralu's warning to the person (#2014): the pair of sessions whose mail started more turns in the hour than it warns at, and how many */
  pairTurns: z.object({ sessions: z.array(z.string()), turns: z.number() }).optional(),
  /** On Centralu's warning to the person (#2024): the session that went through more compaction cycles (`compact_self` with `then`) in the hour than it warns at, and how many */
  compactCycles: z.object({ session: z.string(), count: z.number() }).optional(),
  answerHeld: z.object({ question: z.string(), answer: z.string() }).optional(),
  refused: z.object({ tool: z.string(), target: z.string(), firstLine: z.string(), projectId: z.string() }).optional(),
  trusted: z.object({ project: z.string(), refused: z.array(z.string()) }).optional(),
  reminder: z.union([z.literal(1), z.literal(2)]).optional(),
  of: z.array(z.string()).max(10).optional(),
  /** A `why` this build does not know reads as null, alone: the element and the list stay */
  unanswered: z.array(z.object({ id: z.string(), recipient: z.string(), why: z.enum(RELEASE_WHY).nullable().catch(null) })).optional(),
  asker: z.string().optional(),
  handedOver: z.boolean().optional(),
  legacyKind: z.string().optional(),
  /** The recipients an older build's person released a moved message to: never held again for them (§6.3) */
  releasedTo: z.array(z.string()).optional(),
  /** On a chain's root: how the person last closed the chain (Mark done `finished`, Drop `dropped`), which the window shows while it stays done */
  closed: z.object({ outcome: z.enum(['finished', 'failed', 'stopped', 'dropped']), at: z.number() }).optional(),
  /** On Centralu's notice to a session whose work the person closed in the Inbox: the chain, how it was closed, and the person's requests in it that were withdrawn (at most ten) */
  chainClosed: z.object({ root: z.string(), outcome: z.enum(['finished', 'failed', 'stopped', 'dropped']), withdrawn: z.array(z.string()).max(10) }).optional(),
  chain: z.array(z.object({ host: z.string(), address: z.string() })).optional(),
  /** On a request to the Assistant: the person's message in the sender's conversation that Centralu checked it cites (docs/plans/cited-requests.md §3) */
  cites: z.object({ seq: z.number(), at: z.number() }).optional(),
})
export type MailFacts = z.infer<typeof MailFacts>

export type MailRow = {
  id: string
  sender: string
  senderProject: string | null
  kind: MailKind
  needsReply: boolean
  replyTo: string | null
  rootId: string
  causeId: string | null
  depth: number
  urgent: boolean
  body: string
  facts: MailFacts
  dedupeKey: string | null
  origin: string | null
  legacyThread: string | null
  createdAt: number
}

export type RecipientRow = {
  messageId: string
  recipient: string
  recipientProject: string | null
  via: string | null
  dueAt: number
  attemptAt: number | null
  deliveredAt: number | null
  readAt: number | null
  held: string | null
  attempts: number
  lastError: string | null
  turnSeq: number | null
  settled: Settled | null
  settledAt: number | null
  answerId: string | null
  reminded: number
  remindedAt: number | null
  releasedAt: number | null
  releasedWhy: ReleaseWhy | null
  toldAt: number | null
}

/** `rootId` only for mail from another machine, whose host computed it (§14) */
export type NewMail = Omit<MailRow, 'rootId'> & { rootId?: string }
export type NewRecipient = Pick<RecipientRow, 'recipient' | 'dueAt'> &
  Partial<Pick<RecipientRow, 'recipientProject' | 'via' | 'deliveredAt' | 'readAt' | 'held'>>
/**
 * Which of the original's rows a handoff moves: all, or those of mail from these senders (the children that move, §7.7) and Centralu's mail about
 * them: a finished child's report is sent as Centralu, with the child in its `about`, so it goes with the child it reports
 */
export type HandOverScope = 'all' | { senders: readonly string[] }

/** The stored message, and whether it was there already under the sender's `dedupeKey` */
export type StoredMail = MailRow & { duplicate: boolean }
/** A row and its message: what a delivery re-reads at drain time (§8.2) */
export type PendingRow = { row: RecipientRow; message: MailRow }
/** One row by its key */
export type RowKey = { messageId: string; recipient: string }

/**
 * A message that cannot be stored as given: its id is taken (`id`), it lists a recipient twice (`recipient`), or it
 * answers a message that answers it, which would make a chain with no root (`cycle`)
 */
export class MailConflict extends Error {
  constructor(
    readonly what: 'id' | 'recipient' | 'cycle',
    readonly value: string,
  ) {
    super(what === 'id' ? `The message id ${value} is taken` : what === 'recipient' ? `The recipient ${value} is listed twice` : `The message ${value} would answer itself through its chain`)
    this.name = 'MailConflict'
  }
}

/** The reply target is not stored and no root was given: a reply's root cannot be computed (S9 `unknown_message`) */
export class MailTargetMissing extends Error {
  constructor(readonly replyTo: string) {
    super(`The message ${replyTo} is not stored`)
    this.name = 'MailTargetMissing'
  }
}

export type MailboxSweepLimits = {
  /** A message something still waits on (§6.4) is kept at most this long */
  waitingMs: number
  /** Any other message goes this long after it was sent */
  settledMs: number
  /** A notice read by every recipient goes this long after it was sent */
  readNoticeMs: number
  /** Messages per delete, so a sweep never holds the store for long */
  batch: number
}

const DAY = 24 * 60 * 60 * 1000
export const MAILBOX_RETENTION: MailboxSweepLimits = { waitingMs: 180 * DAY, settledMs: 30 * DAY, readNoticeMs: 14 * DAY, batch: 500 }

type MailSql = {
  id: string
  sender: string
  sender_project: string | null
  kind: string
  needs_reply: number
  reply_to: string | null
  root_id: string
  cause_id: string | null
  depth: number
  urgent: number
  body: string
  facts: string
  dedupe_key: string | null
  origin: string | null
  legacy_thread: string | null
  created_at: number
}

type RecipientSql = {
  message_id: string
  recipient: string
  recipient_project: string | null
  via: string | null
  due_at: number
  attempt_at: number | null
  delivered_at: number | null
  read_at: number | null
  held: string | null
  attempts: number
  last_error: string | null
  turn_seq: number | null
  settled: string | null
  settled_at: number | null
  answer_id: string | null
  reminded: number
  reminded_at: number | null
  released_at: number | null
  released_why: string | null
  told_at: number | null
}

/** A row watched for an answer: of a needsReply message or a task (§4). `m` is the message, `r` the row */
const WATCHED = `(m.needs_reply = 1 OR m.kind = 'task')`
/** A row that may be delivered: not read, not held (or let go by the person), and not withdrawn or gone (§8.2 step 1) */
const WAITING = `r.read_at IS NULL AND (r.held IS NULL OR r.held = 'released') AND COALESCE(r.settled, '') NOT IN ('withdrawn', 'gone')`
/** Held for a reason the person acts on */
const HELD = `r.held IS NOT NULL AND r.held NOT IN ('released', 'dismissed')`
/**
 * The `via` of a recipient row sent to the Assistant's role rather than to one session (§7.7). This build writes
 * `ROLE_VIA` (#2133 step 4, docs/plans/assistant-rename.md); a build before it wrote `'orchestrator'`, and a row keeps
 * the one it was written with, so every reader takes both. The row stays on this machine, and every build that can
 * open the store (v68 on, store step v69) reads both words
 */
export const ROLE_VIA = 'assistant'
const ROLE_VIA_WORDS = [ROLE_VIA, 'orchestrator'] as const
/** Whether a row's `via` is the Assistant's role, under either name */
export const isRoleVia = (via: unknown): boolean => (ROLE_VIA_WORDS as readonly unknown[]).includes(via)
/** The same, as an SQL list */
const ROLE_VIAS = `(${ROLE_VIA_WORDS.map((w) => `'${w}'`).join(', ')})`

/** Holds about one recipient's delivery: let go when a row moves to another recipient, for delivery to judge again */
export const RECIPIENT_HOLD_WORDS = ['uncertain', 'failed', 'loop', 'budget', 'policy'] as const
/** `RECIPIENT_HOLD_WORDS` as an SQL list, for `held IN ...`; the v61 receipts (`mail.ts`) hold for the same words */
export const RECIPIENT_HOLDS = `(${RECIPIENT_HOLD_WORDS.map((w) => `'${w}'`).join(', ')})`

/** Holds that keep a message from its recipient altogether: it was not told of it, so it reads as a phantom (§5.5) */
export const HIDDEN_HOLDS = ['policy', 'loop'] as const
const HIDDEN_SQL = HIDDEN_HOLDS.map((w) => `'${w}'`).join(', ')

/** The ids as one JSON parameter, read with `json_each` */
const idList = (ids: readonly string[]): string => JSON.stringify(ids)

export class MailboxRecords {
  /** Whether a `facts` that did not read was logged: once per store, so a run of bad rows does not flood the log */
  private factsWarned = false

  constructor(private readonly db: Database.Database) {}

  /** One unit of work. `immediate`, so a read then write cannot interleave with another writer */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate()
  }

  /** Whether `sender` has a message stored under `dedupeKey` */
  hasDedupe(sender: string, dedupeKey: string): boolean {
    return this.db.prepare(`SELECT 1 FROM mail WHERE sender = ? AND dedupe_key = ?`).get(sender, dedupeKey) !== undefined
  }

  // ── Writing ──

  /**
   * Stores a message and a row for each recipient. The root is `rootId` when given, else the reply target's stored root,
   * else the message's own id. A duplicate `(sender, dedupeKey)` returns the stored message with `duplicate: true` and
   * writes nothing. A taken id, a recipient listed twice, or a reply that its own chain answers throws `MailConflict`.
   * Returns the message as stored and read back (its `facts` as `factsFrom` reads them)
   */
  insert(mail: NewMail, recipients: readonly NewRecipient[]): StoredMail {
    return this.transaction(() => {
      if (mail.dedupeKey !== null) {
        const stored = this.db.prepare<[string, string], MailSql>(`SELECT * FROM mail WHERE sender = ? AND dedupe_key = ?`).get(mail.sender, mail.dedupeKey)
        if (stored) return { ...this.toMail(stored), duplicate: true }
      }
      if (this.db.prepare(`SELECT 1 FROM mail WHERE id = ?`).get(mail.id)) throw new MailConflict('id', mail.id)
      const twice = recipients.find((r, i) => recipients.findIndex((x) => x.recipient === r.recipient) !== i)
      if (twice) throw new MailConflict('recipient', twice.recipient)
      if (mail.replyTo !== null && this.answersItself(mail.id, mail.replyTo)) throw new MailConflict('cycle', mail.id)
      let rootId = mail.rootId ?? mail.id
      if (mail.rootId === undefined && mail.replyTo !== null) {
        const target = this.db.prepare<[string], { root_id: string }>(`SELECT root_id FROM mail WHERE id = ?`).get(mail.replyTo)
        if (!target) throw new MailTargetMissing(mail.replyTo)
        rootId = target.root_id
      }
      this.db
        .prepare(
          `INSERT INTO mail (id, sender, sender_project, kind, needs_reply, reply_to, root_id, cause_id, depth, urgent, body, facts, dedupe_key, origin, legacy_thread, created_at)
           VALUES (@id, @sender, @senderProject, @kind, @needsReply, @replyTo, @rootId, @causeId, @depth, @urgent, @body, @facts, @dedupeKey, @origin, @legacyThread, @createdAt)`,
        )
        .run({
          id: mail.id,
          sender: mail.sender,
          senderProject: mail.senderProject,
          kind: mail.kind,
          needsReply: mail.needsReply ? 1 : 0,
          replyTo: mail.replyTo,
          rootId,
          causeId: mail.causeId,
          depth: mail.depth,
          urgent: mail.urgent ? 1 : 0,
          body: mail.body,
          facts: JSON.stringify(mail.facts),
          dedupeKey: mail.dedupeKey,
          origin: mail.origin,
          legacyThread: mail.legacyThread,
          createdAt: mail.createdAt,
        })
      const row = this.db.prepare(
        `INSERT INTO mail_recipients (message_id, recipient, recipient_project, via, due_at, delivered_at, read_at, held)
         VALUES (@messageId, @recipient, @recipientProject, @via, @dueAt, @deliveredAt, @readAt, @held)`,
      )
      for (const r of recipients) {
        row.run({ messageId: mail.id, recipient: r.recipient, dueAt: r.dueAt, recipientProject: r.recipientProject ?? null, via: r.via ?? null, deliveredAt: r.deliveredAt ?? null, readAt: r.readAt ?? null, held: r.held ?? null })
      }
      const stored = oneRow(this.db.prepare<[string], MailSql>(`SELECT * FROM mail WHERE id = ?`).get(mail.id))
      return { ...this.toMail(stored), duplicate: false }
    })
  }

  /**
   * Whether a new message `id` answering `replyTo` would close a loop: `replyTo` is `id` itself, or its chain reaches
   * `id` (a message from another machine stored before the one it answers, §14). Walks only when something stored
   * answers `id`; `UNION` ends the walk on a loop already stored
   */
  private answersItself(id: string, replyTo: string): boolean {
    if (replyTo === id) return true
    if (!this.db.prepare(`SELECT 1 FROM mail WHERE reply_to = ?`).get(id)) return false
    return !!this.db
      .prepare(
        `WITH RECURSIVE up(id) AS (SELECT ? UNION SELECT m.reply_to FROM mail m JOIN up ON m.id = up.id WHERE m.reply_to IS NOT NULL)
         SELECT 1 FROM up WHERE id = ?`,
      )
      .get(replyTo, id)
  }

  // ── Reading ──

  message(id: string): MailRow | undefined {
    const row = this.db.prepare<[string], MailSql>(`SELECT * FROM mail WHERE id = ?`).get(id)
    return row && this.toMail(row)
  }

  recipients(messageId: string): RecipientRow[] {
    return this.rows(`r.message_id = ? ORDER BY r.recipient`, messageId)
  }

  recipient(messageId: string, address: string): RecipientRow | undefined {
    return this.rows(`r.message_id = ? AND r.recipient = ?`, messageId, address)[0]
  }

  /**
   * The messages `id` answers, nearest first, at most `limit`: its reply target, that one's, and so on up to the root.
   * The walk itself stops at `limit`, so a loop of replies (refused by `insert`, but a store is not trusted) still ends
   */
  chain(id: string, limit: number): MailRow[] {
    return this.db
      .prepare<{ id: string; limit: number }, MailSql>(
        `WITH RECURSIVE up(id, n) AS (
           SELECT reply_to, 1 FROM mail WHERE id = @id AND reply_to IS NOT NULL AND @limit > 0
           UNION ALL SELECT m.reply_to, up.n + 1 FROM mail m JOIN up ON m.id = up.id WHERE m.reply_to IS NOT NULL AND up.n < @limit
         )
         SELECT m.* FROM up JOIN mail m ON m.id = up.id ORDER BY up.n LIMIT @limit`,
      )
      .all({ id, limit })
      .map((r) => this.toMail(r))
  }

  /** The last `limit` messages of a root, or the last before the message `before`, oldest first; none when `before` is not stored */
  byRoot(rootId: string, opts: { before?: string; limit: number }): MailRow[] {
    return this.page(`m.root_id = @key`, rootId, opts).reverse()
  }

  /**
   * The last `limit` messages of a root in the order they were stored, each with its number in `mail_numbers` (given here to those that have none
   * yet, in the order stored): a number that is the message's own for good and never given to another, what the person's window pages by (§12)
   */
  numbered(rootId: string, limit: number): { m: MailRow; n: number }[] {
    return this.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO mail_numbers (message_id) SELECT id FROM mail WHERE root_id = ? ORDER BY rowid`).run(rootId)
      return this.db
        .prepare<[string, number], MailSql & { n: number }>(
          `SELECT * FROM (SELECT k.n AS n, m.* FROM mail m JOIN mail_numbers k ON k.message_id = m.id WHERE m.root_id = ? ORDER BY k.n DESC LIMIT ?) ORDER BY n`,
        )
        .all(rootId, limit)
        .map((r) => ({ m: this.toMail(r), n: r.n }))
    })
  }

  /**
   * Messages to or from `address`, newest first, `limit` of them, before the message `before` when given (none when it
   * is not stored). The two sides are a `UNION` of two index reads (`mail_sender`, `mail_recipients_by`), not a scan
   */
  feedOf(address: string, opts: { before?: string; limit: number }): MailRow[] {
    return this.page(`m.id IN (SELECT id FROM mail WHERE sender = @key UNION SELECT message_id FROM mail_recipients WHERE recipient = @key)`, address, opts)
  }

  /** Centralu's reports on a task (replying to it), oldest first */
  reportsOn(taskId: string): MailRow[] {
    return this.messages(`m.reply_to = ? AND m.kind = 'report' AND m.sender = 'centralu' ORDER BY m.created_at, m.id`, taskId)
  }

  /** The newest message moved from the v61 thread `threadId` (§6.3) that `recipient` was sent: what the old tool's `thread` names (§11.3) */
  newestLegacyTo(threadId: string, recipient: string): MailRow | undefined {
    return this.messages(
      `m.legacy_thread = ? AND EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND r.recipient = ?) ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
      threadId,
      recipient,
    )[0]
  }

  /** The chains moved from the v61 thread `threadId` (§6.3), the newest first: what an old thread's id names in the person's window */
  movedFrom(threadId: string): string[] {
    return this.db
      .prepare<[string], { root_id: string }>(`SELECT root_id FROM mail WHERE legacy_thread = ? GROUP BY root_id ORDER BY MAX(created_at) DESC`)
      .all(threadId)
      .map((r) => r.root_id)
  }

  /** Whether a message of `sender` moved from a v61 thread (§6.3) has a row for `recipient`: the old build let it write there */
  movedTo(sender: string, recipient: string): boolean {
    return this.messages(`m.sender = ? AND m.legacy_thread IS NOT NULL AND EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND r.recipient = ?) LIMIT 1`, sender, recipient).length > 0
  }

  /** The newest task from `sender` whose row to `recipient` is not settled */
  newestTask(sender: string, recipient: string): MailRow | undefined {
    return this.messages(
      `m.sender = ? AND m.kind = 'task' AND EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND r.recipient = ? AND r.settled IS NULL)
       ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
      sender,
      recipient,
    )[0]
  }

  // ── Delivery ──

  /**
   * What `recipient` may be delivered, with its message, oldest first: rows waiting and due by `now`, not delivered yet
   * (or, with `again`, delivered and still unread: a wake that points at what has not been read)
   */
  pendingFor(recipient: string, now: number, again = false): PendingRow[] {
    return this.withMessages(
      this.rows(`r.recipient = ? AND ${WAITING} AND r.due_at <= ? AND (r.delivered_at IS NULL OR ? = 1) ORDER BY m.created_at, m.id`, recipient, now, again ? 1 : 0),
    )
  }

  /** What `recipient` may read and has not, due or not and delivered or not, with its message, oldest first: not what is held out (a phantom, §5.5), withdrawn or gone (`mail read` with no id, the Inbox; §8.4) */
  unreadFor(recipient: string): PendingRow[] {
    return this.withMessages(
      this.rows(
        `r.recipient = ? AND r.read_at IS NULL AND COALESCE(r.settled, '') NOT IN ('withdrawn', 'gone') AND COALESCE(r.held, '') NOT IN (${HIDDEN_SQL}, 'dismissed') ORDER BY m.created_at, m.id`,
        recipient,
      ),
    )
  }

  /**
   * The recipients with mail waiting to be delivered, due or not: whom the delivery sweep looks at. `nextDue` says when
   * one not due yet is
   */
  dueRecipients(): string[] {
    return this.db
      .prepare<[], { recipient: string }>(`SELECT DISTINCT r.recipient FROM mail_recipients r WHERE r.delivered_at IS NULL AND ${WAITING}`)
      .all()
      .map((r) => r.recipient)
  }

  /** When the first of `recipient`'s waiting mail not due by `after` becomes due, or null */
  nextDue(recipient: string, after: number): number | null {
    const row = this.db
      .prepare<[string, number], { due: number | null }>(`SELECT MIN(r.due_at) AS due FROM mail_recipients r WHERE r.recipient = ? AND r.due_at > ? AND r.delivered_at IS NULL AND ${WAITING}`)
      .get(recipient, after)
    return row?.due ?? null
  }

  hasDue(recipient: string, now: number): boolean {
    return !!this.db
      .prepare<[string, number], { one: number }>(`SELECT 1 AS one FROM mail_recipients r WHERE r.recipient = ? AND r.due_at <= ? AND r.delivered_at IS NULL AND ${WAITING} LIMIT 1`)
      .get(recipient, now)
  }

  /** Committed before a delivery is tried: a host that dies before `markDelivered` leaves a delivery that may have gone */
  markAttempt(recipient: string, ids: readonly string[], at: number): void {
    this.update('attempt_at = ?, attempts = attempts + 1', [at], recipient, ids)
  }

  /** The tool took them, in the turn `turnSeq` started or joined (null: delivered quietly outside a turn) */
  markDelivered(recipient: string, ids: readonly string[], at: number, turnSeq: number | null): void {
    this.update('delivered_at = ?, last_error = NULL, turn_seq = ?', [at, turnSeq], recipient, ids)
  }

  /** Sets why mail waits for the person (`policy`, `loop`, `budget`, `failed`, `uncertain`), or clears it with null */
  hold(recipient: string, ids: readonly string[], why: string | null): void {
    this.update('held = ?', [why], recipient, ids)
  }

  /** No longer held; an unread row waits to be delivered again, whatever was delivered of it while it was held (the person trusted its project, §7.4) */
  letGo(recipient: string, ids: readonly string[]): void {
    this.update('held = NULL, delivered_at = CASE WHEN read_at IS NULL THEN NULL ELSE delivered_at END, attempt_at = NULL, attempts = 0', [], recipient, ids)
  }

  /** Read, keeping an earlier read time */
  markRead(recipient: string, ids: readonly string[], at: number): number {
    return this.update('read_at = COALESCE(read_at, ?)', [at], recipient, ids)
  }

  /**
   * The person's Resend: held mail goes at `dueAt`. Mail held from waking a session (`policy`, `budget`) goes as the mail
   * it is and is not held again (`released`); `uncertain`, `failed` and `loop` are cleared
   */
  release(recipient: string, ids: readonly string[], dueAt: number): number {
    return this.update(
      `delivered_at = CASE WHEN held IN ('policy', 'budget') THEN NULL ELSE delivered_at END,
       held = CASE WHEN held IN ('policy', 'budget') THEN 'released' ELSE NULL END, attempt_at = NULL, last_error = NULL, attempts = 0, due_at = ?`,
      [dueAt],
      recipient,
      ids,
      `held IN ${RECIPIENT_HOLDS}`,
    )
  }

  /**
   * The person's Mark done on a chain (§12): each of `ids` with a row to `recipient` is settled `done`, watched or not, unless it was withdrawn or its
   * sender is gone. A row settled `legacy` or `answered` says done from now: what the person marks is theirs to mark
   */
  closeFor(recipient: string, ids: readonly string[], at: number): number {
    return this.update(`settled = 'done', settled_at = ?`, [at], recipient, ids, `COALESCE(settled, '') IN ('', 'legacy', 'answered')`)
  }

  /** How the person closed the chain rooted at `rootId` (`facts.closed`): the last close stands */
  markClosed(rootId: string, outcome: 'finished' | 'failed' | 'stopped' | 'dropped', at: number): void {
    this.db.prepare(`UPDATE mail SET facts = json_set(CASE WHEN json_valid(facts) THEN facts ELSE '{}' END, '$.closed', json(?)) WHERE id = ?`).run(JSON.stringify({ outcome, at }), rootId)
  }

  /** The person's Dismiss of `uncertain` or `failed` mail: never delivered, held against no one */
  dismiss(recipient: string, ids: readonly string[]): number {
    return this.update(`held = 'dismissed', attempt_at = NULL, last_error = NULL, attempts = 0`, [], recipient, ids, `held IN ${RECIPIENT_HOLDS}`)
  }

  /** The tool did not take them: tried again at `retryAt`, the error kept for the Inbox */
  failedTry(recipient: string, ids: readonly string[], error: string, retryAt: number): void {
    this.update('attempt_at = NULL, last_error = ?, due_at = ?', [error, retryAt], recipient, ids)
  }

  /** A try not made after all: the attempt is taken back and counts for nothing */
  takeBack(recipient: string, ids: readonly string[]): void {
    this.update('attempt_at = NULL, attempts = MAX(attempts - 1, 0)', [], recipient, ids, 'delivered_at IS NULL')
  }

  /** How many times the most-tried of these was attempted */
  attemptsOf(recipient: string, ids: readonly string[]): number {
    const row = this.db
      .prepare<[string, string], { n: number | null }>(`SELECT MAX(attempts) AS n FROM mail_recipients WHERE recipient = ? AND message_id IN (SELECT value FROM json_each(?))`)
      .get(recipient, idList(ids))
    return row?.n ?? 0
  }

  /**
   * A delivery the tool failed late: the rows that delivery marked delivered at `deliveredAt` are unread and undelivered
   * again, unless held since. Returns the ids put back
   */
  undeliver(recipient: string, ids: readonly string[], deliveredAt: number): string[] {
    const where = `recipient = ? AND delivered_at = ? AND (held IS NULL OR held = 'released') AND message_id IN (SELECT value FROM json_each(?))`
    const args: [string, number, string] = [recipient, deliveredAt, idList(ids)]
    return this.transaction(() => {
      const put = this.db.prepare<[string, number, string], { message_id: string }>(`SELECT message_id FROM mail_recipients WHERE ${where}`).all(...args).map((r) => r.message_id)
      this.db.prepare(`UPDATE mail_recipients SET delivered_at = NULL, read_at = NULL, turn_seq = NULL WHERE ${where}`).run(...args)
      return put
    })
  }

  /** A delivery that may have gone and may not: held until the person says */
  markUncertain(recipient: string, ids: readonly string[]): void {
    this.update(`held = 'uncertain', attempt_at = NULL`, [], recipient, ids)
  }

  /** A delivery that may have gone, of mail that starts no work: tried again, its next frame saying it may be a repeat */
  markMaybeRepeated(recipient: string, ids: readonly string[], dueAt: number): void {
    this.update(`attempt_at = NULL, last_error = 'maybe_repeated', due_at = ?`, [dueAt], recipient, ids)
  }

  /** Deliveries tried and not known to have gone: what a host that starts finds a previous one left */
  interrupted(): RecipientRow[] {
    return this.rows(`r.attempt_at IS NOT NULL AND r.delivered_at IS NULL AND ${WAITING}`)
  }

  /** The rows held for the person to act on, the earliest due first */
  heldRows(): RecipientRow[] {
    return this.rows(`${HELD} AND r.read_at IS NULL AND COALESCE(r.settled, '') NOT IN ('withdrawn', 'gone') ORDER BY r.due_at, r.message_id, r.recipient`)
  }

  /** Every row held `policy`, with its message's `sender_project`: what the person's trust or Dismiss acts on (§7.4) */
  heldPolicy(): { row: RecipientRow; senderProject: string | null }[] {
    return this.withMessages(this.rows(`r.held = 'policy' ORDER BY m.created_at, m.id, r.recipient`)).map((p) => ({ row: p.row, senderProject: p.message.senderProject }))
  }

  /** The person's Dismiss of a project's held mail (§7.4): these `policy` rows go, and each message left with no row. Returns the rows deleted */
  deleteHeld(rows: readonly RowKey[]): number {
    return this.transaction(() => {
      const del = this.db.prepare(`DELETE FROM mail_recipients WHERE message_id = ? AND recipient = ? AND held = 'policy'`)
      let n = 0
      for (const r of rows) n += del.run(r.messageId, r.recipient).changes
      this.dropOrphans(rows.map((r) => r.messageId))
      return n
    })
  }

  /** Rows that have served (the refused records of a project that was trusted or dismissed, §7.4): deleted, and each message left with no row */
  deleteRows(rows: readonly RowKey[]): number {
    return this.transaction(() => {
      const del = this.db.prepare(`DELETE FROM mail_recipients WHERE message_id = ? AND recipient = ?`)
      let n = 0
      for (const r of rows) n += del.run(r.messageId, r.recipient).changes
      this.dropOrphans(rows.map((r) => r.messageId))
      return n
    })
  }

  // ── Settling and waiting ──

  /**
   * Settles watched rows not settled yet: one recipient's, or every row of the message with `'all'` (no address). A row moved from an older build
   * (`legacy`) is answered or marked done too: its recipient's act ends it as it would have there (§6.3). Returns how many
   */
  settle(messageId: string, recipient: string, how: Settled, at: number, answerId?: string): number {
    return this.db
      .prepare(
        `UPDATE mail_recipients SET settled = @how, settled_at = @at, answer_id = COALESCE(@answerId, answer_id)
          WHERE message_id = @messageId AND (@recipient = 'all' OR recipient = @recipient)
            AND (settled IS NULL OR (settled = 'legacy' AND @how IN ('answered', 'done')))
            AND EXISTS (SELECT 1 FROM mail m WHERE m.id = @messageId AND ${WATCHED})`,
      )
      .run({ messageId, recipient, how, at, answerId: answerId ?? null }).changes
  }

  /** The recipient's answer is held for the person: the row keeps it and stays open (D8) */
  answerHeld(messageId: string, recipient: string, answerId: string): void {
    this.db.prepare(`UPDATE mail_recipients SET answer_id = ? WHERE message_id = ? AND recipient = ? AND COALESCE(settled, 'legacy') = 'legacy'`).run(answerId, messageId, recipient)
  }

  /** A held answer was dismissed: the rows it was to settle are open again. Returns how many */
  answerDropped(answerId: string): number {
    return this.db.prepare(`UPDATE mail_recipients SET answer_id = NULL WHERE answer_id = ? AND COALESCE(settled, 'legacy') = 'legacy'`).run(answerId).changes
  }

  /** Every unsettled task row with its sender, oldest first: what `takeOverFromEarlierBuild` checks the old report paths against (§9.5) */
  unsettledTasks(): { messageId: string; sender: string; recipient: string }[] {
    return this.db
      .prepare<[], { message_id: string; sender: string; recipient: string }>(
        `SELECT r.message_id, m.sender, r.recipient FROM mail_recipients r JOIN mail m ON m.id = r.message_id WHERE m.kind = 'task' AND r.settled IS NULL ORDER BY m.created_at, m.id`,
      )
      .all()
      .map((r) => ({ messageId: r.message_id, sender: r.sender, recipient: r.recipient }))
  }

  /**
   * The task rows whose cause is `causeId`, not settled and not held: the work handed on in that task (§9.4), each with its sender and recipient
   */
  handedOn(causeId: string): { messageId: string; sender: string; recipient: string; delivered: boolean }[] {
    return this.db
      .prepare<[string], { message_id: string; sender: string; recipient: string; delivered_at: number | null }>(
        `SELECT r.message_id, m.sender, r.recipient, r.delivered_at FROM mail_recipients r JOIN mail m ON m.id = r.message_id
          WHERE m.cause_id = ? AND m.kind = 'task' AND r.settled IS NULL AND (r.held IS NULL OR r.held = 'released') ORDER BY m.created_at, m.id`,
      )
      .all(causeId)
      .map((r) => ({ messageId: r.message_id, sender: r.sender, recipient: r.recipient, delivered: r.delivered_at !== null }))
  }

  /**
   * The work handed on in the newest unsettled task from session `ownerId` to session `childId` (`handedOn`), from the two sessions' ids alone: for
   * the host's start, which knows no address yet (an address ends in `/<session id>`)
   */
  handedOnBySessions(ownerId: string, childId: string): { messageId: string; sender: string; recipient: string; delivered: boolean }[] {
    const task = this.messages(
      `m.sender LIKE ? AND m.kind = 'task' AND EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND r.recipient LIKE ? AND r.settled IS NULL)
       ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
      `session:%/${ownerId}`,
      `session:%/${childId}`,
    )[0]
    return task ? this.handedOn(task.id) : []
  }

  /**
   * Whether session `ownerId` gave session `childId` a task, still open, while it worked on a task it was given that is still open (`cause_id`, §9.4): the
   * child does the work `ownerId` owes its own giver, and its report is what finishes that task (#1932). The cause must be a task, as `handedOnFrom`
   * reads it: a report, notice or message that started the turn is never watched, so its row never settles. From the two sessions' ids alone
   */
  carriesUpstream(ownerId: string, childId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM mail m JOIN mail_recipients r ON r.message_id = m.id
            WHERE m.kind = 'task' AND m.sender LIKE ? AND r.recipient LIKE ? AND r.settled IS NULL AND m.cause_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM mail c JOIN mail_recipients up ON up.message_id = c.id WHERE c.id = m.cause_id AND c.kind = 'task' AND up.recipient LIKE ? AND up.settled IS NULL) LIMIT 1`,
        )
        .get(`session:%/${ownerId}`, `session:%/${childId}`, `session:%/${ownerId}`) !== undefined
    )
  }

  /** The needsReply rows to `recipient` with no answer, not settled or moved from an older build (`legacy`): what waits for its reply (S6) */
  unansweredTo(recipient: string): RecipientRow[] {
    return this.rows(`r.recipient = ? AND m.needs_reply = 1 AND r.answer_id IS NULL AND COALESCE(r.settled, 'legacy') = 'legacy' ORDER BY m.created_at, m.id`, recipient)
  }

  /** The rows delivered to `recipient` in its turn `turnSeq`, settled or not, with their messages, oldest first */
  inTurn(recipient: string, turnSeq: number): PendingRow[] {
    return this.withMessages(this.rows(`r.recipient = ? AND r.turn_seq = ? ORDER BY m.created_at, m.id`, recipient, turnSeq))
  }

  /** The watched rows to `recipient` not settled */
  watchedTo(recipient: string): RecipientRow[] {
    return this.rows(`r.recipient = ? AND r.settled IS NULL AND ${WATCHED} ORDER BY m.created_at, m.id`, recipient)
  }

  /** The watched rows of `sender`'s messages not settled */
  watchedFrom(sender: string): RecipientRow[] {
    return this.rows(`m.sender = ? AND r.settled IS NULL AND ${WATCHED} ORDER BY m.created_at, m.id, r.recipient`, sender)
  }

  /** Centralu stops watching a row for its recipient, once: a row already released is left alone. Returns whether it was released now */
  markReleased(messageId: string, recipient: string, at: number, why: ReleaseWhy): boolean {
    return (
      this.db
        .prepare(`UPDATE mail_recipients SET released_at = ?, released_why = ? WHERE message_id = ? AND recipient = ? AND released_at IS NULL`)
        .run(at, why, messageId, recipient).changes > 0
    )
  }

  /** The sender was told of these released rows */
  markTold(rows: readonly RowKey[], at: number): void {
    const told = this.db.prepare(`UPDATE mail_recipients SET told_at = ? WHERE message_id = ? AND recipient = ? AND told_at IS NULL`)
    this.transaction(() => {
      for (const r of rows) told.run(at, r.messageId, r.recipient)
    })
  }

  // ── Across a link (#2067 item 2, docs/plans/linked-mail.md §6) ──

  /** Whether `sender` ever sent a message to an address that starts with `prefix` (a linked machine's sessions, `session:<hub>/<machine>.`) */
  sentToward(sender: string, prefix: string): boolean {
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    return (
      this.db
        .prepare<[string, string], { one: number }>(`SELECT 1 AS one FROM mail m JOIN mail_recipients r ON r.message_id = m.id WHERE m.sender = ? AND r.recipient LIKE ? ESCAPE '\\' LIMIT 1`)
        .get(sender, like) !== undefined
    )
  }

  /**
   * The rows of messages that crossed a link, with each message's sender: a row whose recipient or whose message's sender is
   * on another host (`session:<other host>/…`, or this host's id with a dotted session id: a linked machine's session as a
   * hub names it). Only those still open, or settled or released since `since`: what the other side may not have heard yet
   */
  acrossRows(ownHost: string, since: number): (RecipientRow & { sender: string })[] {
    const own = `session:${ownHost}/%`
    const dotted = `session:${ownHost}/%.%`
    const foreign = (x: string) => `(${x} LIKE 'session:%' AND (${x} NOT LIKE @own OR ${x} LIKE @dotted))`
    return this.db
      .prepare<{ own: string; dotted: string; since: number }, RecipientSql & { sender: string }>(
        `SELECT r.*, m.sender AS sender FROM mail_recipients r JOIN mail m ON m.id = r.message_id
          WHERE (${foreign('r.recipient')} OR ${foreign('m.sender')})
            AND (r.settled IS NULL OR r.settled_at >= @since OR r.released_at >= @since)
          ORDER BY m.created_at, m.id`,
      )
      .all({ own, dotted, since })
      .map((r) => ({ ...toRecipient(r), sender: r.sender }))
  }

  /**
   * What the other side of a link knows of a row of a message that crossed, merged forward only (§6). `copy`: this host
   * sent the message and keeps a copy, and takes from the recipient's host when it was delivered and read, how it was
   * settled and with which answer, and its release, which the recipient's host already told the sender of. `recipient`:
   * the row is this host's own recipient's, and takes only a withdrawal, which is the sender's to make. Returns whether
   * anything changed
   */
  mergeAcross(
    row: { messageId: string; recipient: string; deliveredAt: number | null; readAt: number | null; settled: string | null; settledAt: number | null; answerId: string | null; releasedAt: number | null; releasedWhy: string | null },
    side: 'copy' | 'recipient',
  ): boolean {
    if (side === 'recipient') {
      if (row.settled !== 'withdrawn') return false
      return this.settle(row.messageId, row.recipient, 'withdrawn', row.settledAt ?? Date.now()) > 0
    }
    return (
      this.db
        .prepare(
          `UPDATE mail_recipients SET
             delivered_at = COALESCE(@deliveredAt, delivered_at),
             read_at = COALESCE(read_at, @readAt),
             settled = COALESCE(settled, @settled),
             settled_at = CASE WHEN settled IS NULL THEN @settledAt ELSE settled_at END,
             answer_id = COALESCE(answer_id, @answerId),
             released_at = COALESCE(released_at, @releasedAt),
             released_why = COALESCE(released_why, @releasedWhy),
             told_at = CASE WHEN told_at IS NULL AND @releasedAt IS NOT NULL THEN @releasedAt ELSE told_at END
           WHERE message_id = @messageId AND recipient = @recipient
             AND (delivered_at IS NOT @deliveredAt AND @deliveredAt IS NOT NULL
               OR read_at IS NULL AND @readAt IS NOT NULL
               OR settled IS NULL AND @settled IS NOT NULL
               OR answer_id IS NULL AND @answerId IS NOT NULL
               OR released_at IS NULL AND @releasedAt IS NOT NULL)`,
        )
        .run(row).changes > 0
    )
  }

  // ── Cover (§10.3) ──

  /**
   * A row that spares `r` a reminder: of a watched message or task its recipient sent after `r` was delivered, whose cause
   * is null or the starter of the turn `r` was delivered in, not settled, held or released; for a task, only while
   * `owes(sender, recipient)`. Null when there is none
   */
  covering(r: RecipientRow, owes: (owner: string, child: string) => boolean): RecipientRow | null {
    if (r.deliveredAt === null) return null
    const party = parseAddress(r.recipient)
    const starter =
      r.turnSeq !== null && party?.kind === 'session'
        ? (this.db.prepare<[string, number], { s: string | null }>(`SELECT starter_id AS s FROM mail_turns WHERE session_id = ? AND turn_seq = ?`).get(party.sessionId, r.turnSeq)?.s ?? null)
        : null
    const rows = this.withMessages(
      this.rows(
        `m.sender = ? AND m.created_at > ? AND (m.cause_id IS NULL OR m.cause_id = ?) AND ${WATCHED}
           AND r.settled IS NULL AND r.released_at IS NULL AND (r.held IS NULL OR r.held = 'released')
         ORDER BY m.created_at, m.id, r.recipient`,
        r.recipient,
        r.deliveredAt,
        starter,
      ),
    )
    return rows.find((x) => x.message.kind !== 'task' || owes(x.message.sender, x.row.recipient))?.row ?? null
  }

  // ── Guards and counts ──

  /** Messages `sender` sent since `since`: the post rate (§7.5), read from `mail_sender` */
  postsSince(sender: string, since: number): number {
    return this.count(`SELECT COUNT(*) AS n FROM mail WHERE sender = ? AND created_at >= ?`, sender, since)
  }

  /**
   * Turns of `a` started or joined by `b`'s mail, and of `b` by `a`'s, delivered since `since` (the pair's warning, §7.5). Only turns a session's
   * message started: one the person started, by their words or their message, counts toward no warning (Q-M3a-12)
   */
  pairTurnsSince(a: string, b: string, since: number): number {
    return this.count(
      `SELECT COUNT(DISTINCT r.recipient || ':' || r.turn_seq) AS n FROM mail_recipients r JOIN mail m ON m.id = r.message_id
        WHERE ((r.recipient = @a AND m.sender = @b) OR (r.recipient = @b AND m.sender = @a)) AND r.turn_seq IS NOT NULL
          AND r.delivered_at >= @since
          AND EXISTS (SELECT 1 FROM mail_turns t JOIN mail s ON s.id = t.starter_id
                       WHERE r.recipient LIKE 'session:%/' || t.session_id AND t.turn_seq = r.turn_seq AND t.started_by = 'mail' AND s.sender LIKE 'session:%')`,
      { a, b, since },
    )
  }

  /** Whether `sender` sent `recipient` this very text since `since` (the repeat guard, §7.5) */
  sameBody(sender: string, recipient: string, body: string, since: number): boolean {
    return (
      this.count(
        `SELECT COUNT(*) AS n FROM mail m JOIN mail_recipients r ON r.message_id = m.id
          WHERE m.sender = ? AND r.recipient = ? AND m.body = ? AND m.created_at >= ?`,
        sender,
        recipient,
        body,
        since,
      ) > 0
    )
  }

  /**
   * Requests from `senders` to the Assistant since `since` (§7.6): their messages and tasks with a row to it, leaving
   * out a reply to a needsReply message or a task the Assistant sent that sender, and a clarification (`facts.clarifies`)
   */
  requestsSince(senders: readonly string[], assistant: string, since: number): number {
    return this.count(
      `SELECT COUNT(*) AS n FROM mail m
        WHERE m.sender IN (SELECT value FROM json_each(@senders)) AND m.kind IN ('message', 'task') AND m.created_at >= @since
          AND EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND r.recipient = @assistant)
          AND NOT (json_valid(m.facts) AND COALESCE(json_type(m.facts, '$.clarifies'), '') = 'text')
          AND NOT EXISTS (SELECT 1 FROM mail t JOIN mail_recipients tr ON tr.message_id = t.id AND tr.recipient = m.sender
                           WHERE t.id = m.reply_to AND t.sender = @assistant AND (t.needs_reply = 1 OR t.kind = 'task'))`,
      { senders: idList(senders), assistant, since },
    )
  }

  /** Centralu's follow-ups to `recipient` (reminders and unanswered notices): those undelivered, and those delivered since `since` (D24) */
  followUpsTo(recipient: string, since: number): RecipientRow[] {
    return this.rows(
      `r.recipient = ? AND m.kind = 'notice' AND m.sender = 'centralu'
         AND json_valid(m.facts) AND (json_type(m.facts, '$.reminder') IS NOT NULL OR json_type(m.facts, '$.unanswered') IS NOT NULL)
         AND (r.delivered_at IS NULL OR r.delivered_at >= ?)
       ORDER BY m.created_at, m.id`,
      recipient,
      since,
    )
  }

  /** The rows of `sender`'s needsReply messages released and not yet told (D25) */
  releasedUntold(sender: string): RecipientRow[] {
    return this.rows(`m.sender = ? AND m.needs_reply = 1 AND r.released_at IS NOT NULL AND r.told_at IS NULL ORDER BY m.created_at, m.id, r.recipient`, sender)
  }

  /** The records of delegations refused for `projectId` (§7.4), or for every project when none is given, each with the caller it went to */
  refusedRecords(projectId?: string): PendingRow[] {
    return this.withMessages(
      this.rows(
        `m.sender = 'centralu' AND m.kind = 'notice' AND json_valid(m.facts) AND json_extract(m.facts, '$.refused.projectId') IS NOT NULL AND (@project IS NULL OR json_extract(m.facts, '$.refused.projectId') = @project)
         ORDER BY r.recipient, m.created_at, m.id`,
        { project: projectId ?? null },
      ),
    )
  }

  // ── Handoff and trash (§7.7) ──

  /**
   * A handoff: `from`'s rows that are watched and not settled, or not read (settled or not: a moved `legacy` row too),
   * go to `to`, in `scope`. A row not read is delivered
   * afresh, with the holds about `from`'s delivery let go. When `to` already has a row for the message, or sent it, `to`'s
   * side stays as it is: `from`'s row is deleted, or (for `to`'s own message) left. Returns the ids of the messages moved
   */
  moveRows(from: string, to: string, scope: HandOverScope): string[] {
    return this.transaction(() => {
      const ids = this.movable(from, to, scope)
      this.db
        .prepare(
          `UPDATE OR IGNORE mail_recipients SET recipient = @to, turn_seq = NULL,
             delivered_at = CASE WHEN read_at IS NULL THEN NULL ELSE delivered_at END,
             attempt_at = CASE WHEN read_at IS NULL THEN NULL ELSE attempt_at END,
             attempts = CASE WHEN read_at IS NULL THEN 0 ELSE attempts END,
             last_error = CASE WHEN read_at IS NULL THEN NULL ELSE last_error END,
             held = CASE WHEN read_at IS NULL AND held IN ${RECIPIENT_HOLDS} THEN NULL ELSE held END
           WHERE recipient = @from AND message_id IN (SELECT value FROM json_each(@ids))`,
        )
        .run({ from, to, ids: idList(ids) })
      this.db.prepare(`DELETE FROM mail_recipients WHERE recipient = ? AND message_id IN (SELECT value FROM json_each(?))`).run(from, idList(ids))
      for (const id of ids) this.carryRelease(id, from, to)
      return ids
    })
  }

  /** The ids of the messages a handoff would move, in the order sent: what `moveRows` moves, read only (the archive's preview, §7.7) */
  movable(from: string, to: string, scope: HandOverScope): string[] {
    const inScope =
      scope === 'all'
        ? '1'
        : `(m.sender IN (SELECT value FROM json_each(@senders)) OR (json_valid(m.facts) AND json_extract(m.facts, '$.about.session') IN (SELECT value FROM json_each(@senders))))`
    return this.db
      .prepare<{ from: string; to: string; senders: string }, { id: string }>(
        `SELECT r.message_id AS id FROM mail_recipients r JOIN mail m ON m.id = r.message_id
          WHERE r.recipient = @from AND ((r.settled IS NULL AND ${WATCHED}) OR r.read_at IS NULL) AND m.sender <> @to AND ${inScope}
          ORDER BY m.created_at, m.id`,
      )
      .all({ from, to, senders: idList(scope === 'all' ? [] : scope.senders) })
      .map((r) => r.id)
  }

  /**
   * The Assistant's role is `to`'s (§7.7): rows sent to the role (`isRoleVia`) and held by any other session (trashed, deleted, or
   * replaced), watched and not settled or not delivered, or moved from an older build unread (held or not, §6.3), go to `to` and are delivered afresh, read or not. A row `to` already has stays. Returns the
   * message ids moved
   */
  moveRole(to: string): string[] {
    return this.transaction(() => {
      const rows = this.rows(
        `r.recipient <> ? AND r.via IN ${ROLE_VIAS} AND ((r.settled IS NULL AND ${WATCHED}) OR (r.delivered_at IS NULL AND ${WAITING}) OR (r.settled = 'legacy' AND r.read_at IS NULL))
          ORDER BY m.created_at, m.id`,
        to,
      )
      const move = this.db.prepare(
        `UPDATE OR IGNORE mail_recipients SET recipient = ?, delivered_at = NULL, read_at = NULL, attempt_at = NULL, turn_seq = NULL, attempts = 0, last_error = NULL,
           held = CASE WHEN held IN ${RECIPIENT_HOLDS} THEN NULL ELSE held END
         WHERE message_id = ? AND recipient = ?`,
      )
      const drop = this.db.prepare(`DELETE FROM mail_recipients WHERE message_id = ? AND recipient = ?`)
      for (const r of rows) {
        move.run(to, r.messageId, r.recipient)
        drop.run(r.messageId, r.recipient)
        this.carryRelease(r.messageId, r.recipient, to)
      }
      return rows.map((r) => r.messageId)
    })
  }

  /**
   * A row moved from `from` to `to` keeps an older build's person's release (`facts.releasedTo`, §6.3): released is never held again, whoever
   * holds the row now
   */
  private carryRelease(messageId: string, from: string, to: string): void {
    this.db
      .prepare(
        `UPDATE mail SET facts = json_set(facts, '$.releasedTo', (SELECT json_group_array(CASE WHEN value = @from THEN @to ELSE value END) FROM json_each(mail.facts, '$.releasedTo')))
          WHERE id = @messageId AND json_valid(facts) AND json_type(facts, '$.releasedTo') = 'array'
            AND EXISTS (SELECT 1 FROM json_each(mail.facts, '$.releasedTo') WHERE value = @from)`,
      )
      .run({ messageId, from, to })
  }

  /** The trash was emptied of `address`: its rows go, and each message left with no row but the person's own. Returns the rows deleted */
  purgeParty(address: string): number {
    return this.transaction(() => {
      const ids = this.db.prepare<[string], { id: string }>(`SELECT message_id AS id FROM mail_recipients WHERE recipient = ?`).all(address).map((r) => r.id)
      const n = this.db.prepare(`DELETE FROM mail_recipients WHERE recipient = ?`).run(address).changes
      // The person's own words stay in their window, sent to nobody kept (§12)
      this.dropOrphans(ids, { keepPerson: true })
      return n
    })
  }

  // ── Retention (§6.4) ──

  /**
   * Plain batched deletes, one transaction each. A message something waits on (a watched row open, a row undelivered, a
   * row held) is kept up to `waitingMs`; any other goes after `settledMs`, and a notice every recipient read after `readNoticeMs`
   */
  sweep(now: number, limits: Partial<MailboxSweepLimits> = {}): { messages: number } {
    const l = { ...MAILBOX_RETENTION, ...limits }
    const waits = `EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND (
        (r.settled IS NULL AND r.released_at IS NULL AND ${WATCHED})
        OR (r.delivered_at IS NULL AND ${WAITING})
        OR (${HELD})))`
    const unread = `EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND r.read_at IS NULL)`
    const pick = this.db.prepare<{ waiting: number; settled: number; notice: number; batch: number }, { id: string }>(
      `SELECT m.id FROM mail m
        WHERE m.created_at <= @waiting
           OR (m.created_at <= @settled AND NOT ${waits})
           OR (m.kind = 'notice' AND m.created_at <= @notice AND NOT ${waits} AND NOT ${unread})
        ORDER BY m.created_at LIMIT @batch`,
    )
    let messages = 0
    for (;;) {
      const n = this.transaction(() => {
        const ids = idList(pick.all({ waiting: now - l.waitingMs, settled: now - l.settledMs, notice: now - l.readNoticeMs, batch: l.batch }).map((r) => r.id))
        this.db.prepare(`DELETE FROM mail_recipients WHERE message_id IN (SELECT value FROM json_each(?))`).run(ids)
        return this.db.prepare(`DELETE FROM mail WHERE id IN (SELECT value FROM json_each(?))`).run(ids).changes
      })
      messages += n
      if (n === 0) return { messages }
    }
  }

  // ── Turns (`mail_turns`, read and written by `MailTurns`, M3a) ──

  /**
   * A turn begins: its work message and the message that started it (§8.2 step 6), and `thread_id` NULL. An older build
   * serving the same store writes `thread_id` and leaves these two NULL; each reads only its own columns (§6.2)
   */
  startTurn(t: Omit<TurnRecord, 'endedAt' | 'outcome'>): void {
    this.db
      .prepare(`INSERT INTO mail_turns (session_id, turn_seq, thread_id, message_id, starter_id, started_by, started_at) VALUES (?, ?, NULL, ?, ?, ?, ?)`)
      .run(t.sessionId, t.turnSeq, t.messageId, t.starterId, t.startedBy, t.startedAt)
  }

  /** Whose the open turn is and what it is the work of, decided again in place (#1639, `MailTurns.restate`) */
  restateTurn(sessionId: string, turnSeq: number, t: Pick<TurnRecord, 'messageId' | 'starterId' | 'startedBy'>): void {
    this.db
      .prepare(`UPDATE mail_turns SET message_id = ?, starter_id = ?, started_by = ? WHERE session_id = ? AND turn_seq = ? AND ended_at IS NULL`)
      .run(t.messageId, t.starterId, t.startedBy, sessionId, turnSeq)
  }

  /** The session's turn `turnSeq`, ended or not, or null */
  turn(sessionId: string, turnSeq: number): TurnRecord | null {
    const row = this.db.prepare<[string, number], TurnSql>(`SELECT * FROM mail_turns WHERE session_id = ? AND turn_seq = ?`).get(sessionId, turnSeq)
    return row ? toTurnRecord(row) : null
  }

  nextTurnSeq(sessionId: string): number {
    return this.count(`SELECT COALESCE(MAX(turn_seq), 0) + 1 AS n FROM mail_turns WHERE session_id = ?`, sessionId)
  }

  /** Turns no host recorded an end of: what a host that starts finds the last one left (`MailTurns.closeStale`) */
  openTurns(): TurnRecord[] {
    return this.db.prepare<[], TurnSql>(`SELECT * FROM mail_turns WHERE ended_at IS NULL`).all().map(toTurnRecord)
  }

  endTurn(sessionId: string, turnSeq: number, at: number, outcome: string): void {
    this.db.prepare(`UPDATE mail_turns SET ended_at = ?, outcome = ? WHERE session_id = ? AND turn_seq = ? AND ended_at IS NULL`).run(at, outcome, sessionId, turnSeq)
  }

  /** The running turn's work message is known only now (a delegation is written after its turn began): it is that work's, and the task started it */
  setTurnMessage(sessionId: string, turnSeq: number, messageId: string): void {
    this.db
      .prepare(`UPDATE mail_turns SET message_id = ?, starter_id = COALESCE(starter_id, ?) WHERE session_id = ? AND turn_seq = ? AND ended_at IS NULL AND message_id IS NULL`)
      .run(messageId, messageId, sessionId, turnSeq)
  }

  /**
   * Turns since `since` that mail from a session or a Centralu follow-up started (the host's warning, §7.5): `started_by = 'mail'`
   * and a starter that is a session's message, or Centralu's reminder or notice of unanswered mail. The person's words and a
   * report do not count, nor a turn whose delivery was not taken (`canceled`). One session's when `session` is given
   */
  mailStartedSince(since: number, session?: string): number {
    return this.count(`SELECT COUNT(*) AS n FROM (${MAIL_STARTED}) WHERE (@session IS NULL OR session_id = @session)`, { since, session: session ?? null })
  }

  /** When the person last started a turn of the session (their word, §7.5's pair warning), or null */
  lastPersonTurn(sessionId: string): number | null {
    return this.db.prepare<[string], { at: number | null }>(`SELECT MAX(started_at) AS at FROM mail_turns WHERE session_id = ? AND started_by = 'person'`).get(sessionId)?.at ?? null
  }

  /** When the person last wrote to `recipient`, or null */
  lastFromPerson(recipient: string): number | null {
    return (
      this.db
        .prepare<[string], { at: number | null }>(`SELECT MAX(m.created_at) AS at FROM mail m JOIN mail_recipients r ON r.message_id = m.id WHERE m.sender = 'person' AND r.recipient = ?`)
        .get(recipient)?.at ?? null
    )
  }

  /**
   * The parties of watched rows not settled, as recipients or senders: whom the delivery's sweep checks are still here (`partyGone`, §7.7). A row sent
   * to the role waits for the next Assistant (`moveRole`), not for the session that held it
   */
  openParties(): string[] {
    return this.db
      .prepare<[], { a: string }>(
        `SELECT r.recipient AS a FROM mail_recipients r JOIN mail m ON m.id = r.message_id WHERE r.settled IS NULL AND COALESCE(r.via, '') NOT IN ${ROLE_VIAS} AND ${WATCHED}
         UNION SELECT m.sender FROM mail m JOIN mail_recipients r ON r.message_id = m.id WHERE r.settled IS NULL AND ${WATCHED}`,
      )
      .all()
      .map((r) => r.a)
  }

  // ── Rows ──

  private toMail(r: MailSql): MailRow {
    return {
      id: r.id,
      sender: r.sender,
      senderProject: r.sender_project,
      kind: MAIL_KINDS.find((k) => k === r.kind) ?? 'notice',
      needsReply: r.needs_reply === 1,
      replyTo: r.reply_to,
      rootId: r.root_id,
      causeId: r.cause_id,
      depth: r.depth,
      urgent: r.urgent === 1,
      body: r.body,
      facts: this.readFacts(r.id, r.facts),
      dedupeKey: r.dedupe_key,
      origin: r.origin,
      legacyThread: r.legacy_thread,
      createdAt: r.created_at,
    }
  }

  /** `facts` as stored, read by `factsFrom`; what does not read is said once per store, naming the message */
  private readFacts(id: string, raw: string): MailFacts {
    const value = parseJson(raw)
    const facts = factsFrom(value)
    if (!this.factsWarned && (!isObj(value) || Object.keys(facts).length < Object.keys(value).length)) {
      this.factsWarned = true
      console.warn(`[mail] the facts of message ${id} do not read whole; what does not read is left out: ${raw.slice(0, 120)}`)
    }
    return facts
  }

  /** Rows with `where` over `r` (the row) and `m` (its message), `args` filling its `?` or `@names` */
  private rows(where: string, ...args: unknown[]): RecipientRow[] {
    return this.db
      .prepare<unknown[], RecipientSql>(`SELECT r.* FROM mail_recipients r JOIN mail m ON m.id = r.message_id WHERE ${where}`)
      .all(...args)
      .map(toRecipient)
  }

  private messages(where: string, ...args: unknown[]): MailRow[] {
    return this.db
      .prepare<unknown[], MailSql>(`SELECT m.* FROM mail m WHERE ${where}`)
      .all(...args)
      .map((r) => this.toMail(r))
  }

  /** Each row with its message; a row whose message is gone is left out */
  private withMessages(rows: readonly RecipientRow[]): PendingRow[] {
    return rows.flatMap((row) => {
      const message = this.message(row.messageId)
      return message ? [{ row, message }] : []
    })
  }

  /** Newest first, before the message `before` when given (by time, then id); none when `before` is not stored */
  private page(where: string, key: string, opts: { before?: string; limit: number }): MailRow[] {
    const anchor = opts.before === undefined ? undefined : this.message(opts.before)
    if (opts.before !== undefined && !anchor) return []
    return this.messages(
      `${where} AND (@at IS NULL OR m.created_at < @at OR (m.created_at = @at AND m.id < @id)) ORDER BY m.created_at DESC, m.id DESC LIMIT @limit`,
      { key, at: anchor?.createdAt ?? null, id: anchor?.id ?? '', limit: opts.limit },
    )
  }

  /** `UPDATE ... SET <set> WHERE recipient = ? [AND <also>] AND message_id IN <ids>`; returns the rows changed */
  private update(set: string, setArgs: readonly (string | number | null)[], recipient: string, ids: readonly string[], also?: string): number {
    return updateRecipientRows(this.db, 'mail_recipients', set, setArgs, recipient, ids, also)
  }

  private count(sql: string, ...args: unknown[]): number {
    return this.db.prepare<unknown[], { n: number }>(sql).get(...args)?.n ?? 0
  }

  /** Deletes those of `ids` no row names any more */
  private dropOrphans(ids: readonly string[], opts: { keepPerson?: boolean } = {}): void {
    this.db
      .prepare(
        `DELETE FROM mail WHERE id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = mail.id)
           AND (? = 0 OR sender <> 'person')`,
      )
      .run(idList(ids), opts.keepPerson ? 1 : 0)
  }
}

/** A turn as this build records it (§6.1): its work message and its starter; `thread_id` is the older build's */
export type TurnRecord = { sessionId: string; turnSeq: number; messageId: string | null; starterId: string | null; startedBy: string; startedAt: number; endedAt: number | null; outcome: string | null }
type TurnSql = { session_id: string; turn_seq: number; message_id: string | null; starter_id: string | null; started_by: string; started_at: number; ended_at: number | null; outcome: string | null }
function toTurnRecord(r: TurnSql): TurnRecord {
  return { sessionId: r.session_id, turnSeq: r.turn_seq, messageId: r.message_id, starterId: r.starter_id, startedBy: r.started_by, startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome }
}
/** The turns `mailStartedSince` counts, as a subquery over `@since` */
const MAIL_STARTED = `SELECT t.session_id, t.started_at FROM mail_turns t JOIN mail s ON s.id = t.starter_id
   WHERE t.started_by = 'mail' AND t.started_at >= @since AND COALESCE(t.outcome, '') <> 'canceled'
     AND (s.sender LIKE 'session:%' OR (s.sender = 'centralu' AND s.kind = 'notice' AND json_valid(s.facts)
          AND (json_type(s.facts, '$.reminder') IS NOT NULL OR json_type(s.facts, '$.unanswered') IS NOT NULL)))`

function toRecipient(r: RecipientSql): RecipientRow {
  return {
    messageId: r.message_id,
    recipient: r.recipient,
    recipientProject: r.recipient_project,
    via: r.via,
    dueAt: r.due_at,
    attemptAt: r.attempt_at,
    deliveredAt: r.delivered_at,
    readAt: r.read_at,
    held: r.held,
    attempts: r.attempts,
    lastError: r.last_error,
    turnSeq: r.turn_seq,
    settled: r.settled === null ? null : (SETTLED.find((s) => s === r.settled) ?? 'legacy'),
    settledAt: r.settled_at,
    answerId: r.answer_id,
    reminded: r.reminded,
    remindedAt: r.reminded_at,
    releasedAt: r.released_at,
    releasedWhy: RELEASE_WHY.find((w) => w === r.released_why) ?? null,
    toldAt: r.told_at,
  }
}

/**
 * Facts as stored, read key by key (docs/stored-shapes.md rule 3): a value that is not a JSON object reads as `{}`, and a
 * known key whose value is not the shape §5.4 gives is left out, alone; a key a newer build added is kept. A v61
 * `waitingOn` (the thread ids still going, §6.3) reads as their count
 */
export function factsFrom(raw: unknown): MailFacts {
  if (!isObj(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const v = key === 'waitingOn' && Array.isArray(value) ? value.length : value
    const shape = (MailFacts.shape as Record<string, z.ZodType | undefined>)[key]
    if (!shape || shape.safeParse(v).success) out[key] = v
  }
  return MailFacts.parse(out)
}
