import { parseAddress } from '../../../mail/address.js'
import { MigrationRange, type MigrationStep } from './context.js'
import { endOldHolds } from './v65.js'

/** The migration steps from v75 on. The rule it follows is written above `migrationSteps` in `index.ts` */
export class StepsV75 extends MigrationRange {
  steps(): MigrationStep[] {
    return [
      {
        to: 75,
        breaksOlderReaders: true,
        minReader: 74,
        /**
         * The last move of thread mail (#2258 item 1, docs/plans/mailbox.md §6.3, M7): what a build of v61 to v64 left pending in its thread
         * tables (`mail_threads`, `mail_messages`, `mail_receipts`) becomes mail once, here. Until this step the host moved it at every start
         * and read the old tables for the lines before a moved message. From this build on only a migration step names those tables, the two
         * beside them (`mail_participants`, `mail_blockers`), `report_marks`, `delegated_turns`, `queued_requests` or `sessions.mail_args`.
         *
         * Pending is a receipt not handled, not dismissed by the person, of a message sent in the last 180 days (retention would not have kept
         * an older one waiting), that is not delivered, not read, or a `question` (read and not answered). Each message is copied once under its
         * own id, its rows settled `legacy` (never awaited), and each old receipt is marked handled, delivered and read. A row to the Assistant in
         * a session's request (the old thread's assignee, the Assistant or a trashed one) is sent to the role (`via`), so the next Assistant
         * takes it; a task to a trashed session is settled `gone`. A row the person released is never held again (`releasedTo`). A hold an
         * earlier build set stays only if today's gate would hold the mail now, as step 72 judged the rows moved before it (`endOldHolds`).
         * A `policy` hold is judged on the rows this step writes only, since a row moved at an earlier start may be held by the delivery's own
         * judgement; a `budget` hold, which no delivery sets, ends on whatever row carries it.
         *
         * **A frozen copy of the move the host ran (`movePendingThreadMail`) and of what it called, on purpose**: a step runs once on every
         * store and must not call code that may change. Only the address shape is imported (mail/address.ts), as the stored shape it is. One
         * thing is read differently: a sender's project comes from its `sessions` row by the session id alone, where the host asked only for a
         * session of its own (as step 72 reads a recipient's).
         *
         * **Breaks the builds of v70 to v73 (beta.58 to beta.69): the floor goes to 74.** Those builds leave a report mark for every session in
         * a turn as they go, and make a task of each mark at their next start. This build deleted the marks at every start, so that one left
         * during a rollback never became a task for work settled since; it no longer names `report_marks`, so those builds are refused instead
         * (`StoreTooNewError`). The build of v74 (beta.70 to beta.72) writes no mark, and its own move at every start finds each receipt handled:
         * it opens the store and serves it as before. The tables stay for it, unread by this build, and go in the next step.
         */
        run: () => this.moveThreadMail(),
      },
      {
        to: 76,
        breaksOlderReaders: true,
        minReader: 75,
        /**
         * What nothing reads any more goes (#2258, docs/plans/mailbox.md M7): the thread tables of v61 (`mail_threads`, `mail_participants`,
         * `mail_blockers`, `mail_messages`, `mail_receipts`), the index that found a thread's open turn (`mail_turns_open`), the three tables
         * of owed work from before mail (`report_marks`, `delegated_turns`, `queued_requests`) and `sessions.mail_args`. Step 74 made tasks of
         * the owed work and step 75 moved the pending thread mail, so what is deleted here is history: thread messages that were handled, or
         * were older than step 75's 180 days, are kept only in the copy of the store the open that runs this step makes, for its 14 days,
         * and nowhere when that copy could not be made (rule 5 above `migrationSteps`; the copy is named after that open's first breaking
         * step, so `store.before-75.db` from version 74). No vacuum, so the step is not `heavy`: later writes reuse the pages the tables held.
         *
         * One release after step 75, whose build was the first to name none of these (rule 2 above `migrationSteps`). `schema.sql` creates
         * none of them, so a new store and a migrated one end with the same tables.
         *
         * **Breaks the build of v74 (beta.70 to beta.72): the floor goes to 75.** That build reads the thread tables at every start and for the
         * lines before a moved message, deletes from `report_marks` at every start and from two of the thread tables when a session is
         * purged; it is refused (`StoreTooNewError`). The build of v75 opens the store as it is. No release read or wrote `sessions.mail_args`:
         * the second version of the mail tool it was added for was not built (M3b).
         */
        run: () => {
          for (const table of ['mail_blockers', 'mail_participants', 'mail_receipts', 'mail_messages', 'mail_threads', 'report_marks', 'delegated_turns', 'queued_requests']) {
            this.db.exec(`DROP TABLE IF EXISTS ${table}`)
          }
          this.db.exec(`DROP INDEX IF EXISTS mail_turns_open`)
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (cols.some((c) => c.name === 'mail_args')) this.db.exec(`ALTER TABLE sessions DROP COLUMN mail_args`)
        },
      },
      {
        to: 77,
        breaksOlderReaders: false,
        /**
         * When a task a turn took in while it ran was given again at rest (#2369, docs/plans/mailbox.md §10.6.3): `mail_recipients.given_again_at`,
         * null once the task is delivered again. Its next frame says so (`givenAgain="1"`), and a call waiting on it reads the turn it joined as still
         * working. A column of its own: `last_error` is the last delivery's error, which a failed try overwrites while the task waits.
         *
         * **Expand only (#292's rule).** One nullable column. An older build names its columns in every write of `mail_recipients` and reads them by
         * name, so it never sees it: it opens the store, and a task it finds given again goes as a plain task and keeps the mark. Nothing is
         * backfilled: no build marked one.
         */
        run: () => this.addColumn('mail_recipients', 'given_again_at', 'INTEGER'),
      },
    ]
  }

  /** Step 75: every pending receipt of the thread tables written as mail, and the old receipt marked handled */
  private moveThreadMail(): void {
    const has = (table: string) => this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined
    // Earlier steps made every one of these in a real store: a partial schema (a test's) has nothing to move
    if (!['mail_threads', 'mail_messages', 'mail_receipts', 'mail', 'mail_recipients', 'sessions', 'projects'].every(has)) return
    const now = Date.now()
    const pending = this.pendingReceipts(now)
    if (pending.length === 0) return
    const rootOf = this.db.prepare<[string], { root_id: string }>(`SELECT root_id FROM mail WHERE id = ?`)
    const insertMail = this.db.prepare(
      `INSERT OR IGNORE INTO mail (id, sender, sender_project, kind, needs_reply, reply_to, root_id, urgent, body, facts, origin, legacy_thread, created_at)
       VALUES (@id, @sender, @senderProject, @kind, @needsReply, @replyTo, @rootId, @urgent, @body, @facts, @origin, @legacyThread, @createdAt)`,
    )
    const insertRow = this.db.prepare(
      `INSERT OR IGNORE INTO mail_recipients (message_id, recipient, via, due_at, attempt_at, delivered_at, read_at, held, attempts, last_error, settled, settled_at)
       VALUES (@messageId, @recipient, @via, @dueAt, @attemptAt, @deliveredAt, @readAt, @held, @attempts, @lastError, @settled, @now)`,
    )
    const handled = this.db.prepare(
      `UPDATE mail_receipts SET handled_at = @now, delivered_at = COALESCE(delivered_at, @now), read_at = COALESCE(read_at, @now) WHERE message_id = @id AND recipient = @recipient`,
    )
    const sessionRow = this.db.prepare<[string], { project: string | null; assistant: number; trashed: number }>(
      `SELECT project_id AS project, is_assistant = 1 AND (project_id IS NULL OR deleted_at IS NOT NULL) AS assistant, deleted_at IS NOT NULL AS trashed FROM sessions WHERE id = ?`,
    )
    const sessionOf = (address: string) => {
      const party = parseAddress(address)
      return party?.kind === 'session' ? sessionRow.get(party.sessionId) : undefined
    }
    // The recipients the person released each message to, carried on the message: never held again for them
    const releasedTo = new Map<string, string[]>()
    for (const p of pending) if (p.held === 'released') releasedTo.set(p.id, [...(releasedTo.get(p.id) ?? []), p.recipient])
    const moved: number[] = []
    for (const p of pending) {
      const sender = parseAddress(p.sender)
      const from = sessionOf(p.sender)
      // The old tool left its threads' project empty for a session's own mail, so the sender's is its session's; a thread's is its owner's
      const senderProject = sender?.kind === 'session' ? ((from?.trashed === 0 ? from.project : null) ?? (p.sender === p.t_owner ? p.t_project_id : null)) : null
      const target = p.reply_to === null ? undefined : rootOf.get(p.reply_to)
      const kind = movedKind(p.kind, p.t_origin)
      const facts = {
        ...movedFacts(p.facts),
        legacyKind: p.kind,
        ...(quiet(sender?.kind ?? 'session', p) ? { quiet: true } : {}),
        ...(p.needs_owner === 1 ? { needsOwner: true } : {}),
        ...(releasedTo.has(p.id) ? { releasedTo: releasedTo.get(p.id) } : {}),
      }
      insertMail.run({
        id: p.id,
        sender: p.sender,
        senderProject,
        kind,
        needsReply: p.kind === 'question' ? 1 : 0,
        // The order is a thread's own (`seq`), so a reply finds its target moved before it, whatever their times say
        replyTo: target ? p.reply_to : null,
        rootId: target?.root_id ?? p.id,
        urgent: p.urgent === 1 ? 1 : 0,
        body: p.body,
        facts: JSON.stringify(facts),
        origin: p.seq === 1 ? p.t_origin : 'mail',
        legacyThread: p.thread_id,
        createdAt: p.created_at,
      })
      const to = sessionOf(p.recipient)
      const row = insertRow.run({
        messageId: p.id,
        recipient: p.recipient,
        via: p.recipient === p.t_assignee && to?.assistant === 1 && p.t_owner !== p.recipient ? 'assistant' : null,
        dueAt: p.due_at,
        attemptAt: p.attempt_at,
        deliveredAt: p.delivered_at,
        readAt: p.read_at,
        held: p.held !== null && CARRIED_HOLDS.includes(p.held) ? p.held : null,
        attempts: p.attempts,
        lastError: p.last_error,
        settled: kind === 'task' && to?.trashed === 1 ? 'gone' : 'legacy',
        now,
      })
      // A row already there is not this step's to judge, and an ignored insert's `lastInsertRowid` is an earlier insert's. No build leaves
      // one beside a receipt not handled (the move at a start wrote both sides in one transaction): a store edited by hand could
      if (row.changes === 1) moved.push(Number(row.lastInsertRowid))
      handled.run({ now, id: p.id, recipient: p.recipient })
    }
    endOldHolds(this.db, moved)
  }

  /** The receipts still pending at `now`, each with its message and what the move reads of its thread, in each thread's own order */
  private pendingReceipts(now: number): PendingReceipt[] {
    return this.db
      .prepare<[number], PendingReceipt>(
        `SELECT m.id, m.thread_id, m.seq, m.sender, m.kind, m.urgent, m.needs_owner, m.wake, m.reply_to, m.body, m.facts, m.created_at,
                r.recipient, r.due_at, r.attempt_at, r.delivered_at, r.read_at, r.held, r.attempts, r.last_error,
                t.project_id AS t_project_id, t.owner AS t_owner, t.assignee AS t_assignee, t.origin AS t_origin
           FROM mail_receipts r JOIN mail_messages m ON m.id = r.message_id JOIN mail_threads t ON t.id = m.thread_id
          WHERE r.handled_at IS NULL AND COALESCE(r.held, '') <> 'dismissed' AND m.created_at >= ?
            AND (r.delivered_at IS NULL OR r.read_at IS NULL OR m.kind = 'question')
          ORDER BY m.thread_id, m.seq, r.recipient`,
      )
      .all(now - MOVE_WITHIN_MS)
  }
}

/** Thread mail older than this is not moved: retention would not have kept it waiting (docs/plans/mailbox.md §6.4) */
const MOVE_WITHIN_MS = 180 * 24 * 60 * 60 * 1000

/**
 * The hold words a moved row keeps until `endOldHolds` judges it: a recipient's holds, the person's `released` (sent as it is, never held again), and
 * `budget`, the token guard's word no build reads as a hold, which the judgement ends. Any other word is no hold
 */
const CARRIED_HOLDS = ['uncertain', 'failed', 'loop', 'policy', 'released', 'budget']

/** The origins of a thread whose `assign` was a task: the person's, and the tools that gave work to a session (`DELEGATION_ORIGINS` then) */
const TASK_ORIGINS = ['person', 'start_agent', 'agent_session', 'send_to_session', 'create_session', 'ask_project']

/** A pending receipt with its message and what the move reads of its thread */
type PendingReceipt = {
  id: string
  thread_id: string
  seq: number
  sender: string
  kind: string
  urgent: number
  needs_owner: number
  wake: string | null
  reply_to: string | null
  body: string
  facts: string
  created_at: number
  recipient: string
  due_at: number
  attempt_at: number | null
  delivered_at: number | null
  read_at: number | null
  held: string | null
  attempts: number
  last_error: string | null
  t_project_id: string | null
  t_owner: string
  t_assignee: string | null
  t_origin: string
}

/** A thread message's kind as mail. A kind no build of v64 knew is a message, and keeps its word in `facts.legacyKind` */
function movedKind(kind: string, threadOrigin: string): 'task' | 'message' | 'report' | 'notice' {
  if (kind === 'assign' && TASK_ORIGINS.includes(threadOrigin)) return 'task'
  if (kind === 'report') return 'report'
  return kind === 'notice' || kind === 'event' ? 'notice' : 'message'
}

/** A thread message's facts as mail's: what is not a JSON object reads as none, and the threads a report still waited on become their count */
function movedFacts(raw: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const facts: Record<string, unknown> = { ...value }
  if (Array.isArray(facts.waitingOn)) facts.waitingOn = facts.waitingOn.length
  return facts
}

/**
 * Whether the old delivery started no turn for a message (`wakes` then, negated), which mail keeps as `facts.quiet`: an event, Centralu's or an
 * app's message sent with `wake: 'no'`, and an app's notice that neither needed the person nor asked to wake
 */
function quiet(senderKind: string, m: { kind: string; wake: string | null; needs_owner: number }): boolean {
  if (m.kind === 'event') return true
  if (senderKind === 'centralu') return m.wake === 'no'
  if (senderKind !== 'app') return false
  return m.wake === 'no' || (m.kind === 'notice' && m.needs_owner !== 1 && m.wake !== 'yes')
}
