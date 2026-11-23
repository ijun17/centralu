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
         * tables becomes mail once, here; from this build on only a migration step names the thread tables, `report_marks`, `delegated_turns`,
         * `queued_requests` or `sessions.mail_args`. Pending: a receipt not handled or dismissed, of a message from the last 180 days, not
         * delivered, not read, or a `question` (read and not answered). Each is copied once under its own id, its rows settled `legacy`, and the
         * old receipt marked handled, delivered and read. A row to the thread's assignee that is the Assistant (not the thread's owner) goes to the role (`via`), so the next
         * Assistant takes it; a task to a trashed session is settled `gone`; a released row is never held again; old holds go to `endOldHolds`.
         * A frozen copy of `movePendingThreadMail` and what it called, on purpose (a step must not call code that may change), except that a
         * sender's project comes from its `sessions` row by id alone. Breaks v70 to v73 (beta.58 to beta.69), floor 74: they leave a report mark
         * per session in a turn and make a task of each at their next start, and this build does not name `report_marks` to clear one a rollback
         * left, so they are refused (`StoreTooNewError`). v74 (beta.70 to beta.72) writes no mark and opens the store; the tables stay for it.
         */
        run: () => this.moveThreadMail(),
      },
      {
        to: 76,
        breaksOlderReaders: true,
        minReader: 75,
        /**
         * What nothing reads any more goes (#2258, docs/plans/mailbox.md M7): v61's thread tables, `mail_turns_open`, the three tables of owed
         * work from before mail and `sessions.mail_args`. Step 74 made tasks of the owed work and step 75 moved the pending thread mail, so what
         * is deleted is history: thread messages handled, or older than step 75's 180 days, are kept only in the copy of the store the open that
         * runs this step makes, for its 14 days, and nowhere when that copy could not be made (rule 5 above `migrationSteps`; the copy is named
         * after that open's first breaking step, so `store.before-75.db` from version 74). No vacuum, so not `heavy`: later writes reuse the pages.
         * One release after step 75, the first build to name none of these (rule 2 above `migrationSteps`); `schema.sql` creates none of them.
         * Breaks v74 (beta.70 to beta.72), floor 75: it reads the thread tables at every start, deletes from `report_marks` at every start and
         * from two thread tables on purge; it is refused (`StoreTooNewError`). No release read or wrote `sessions.mail_args`: the mail tool's
         * second version it was added for was not built (M3b).
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
      {
        to: 78,
        breaksOlderReaders: true,
        minReader: 75,
        /**
         * Two clean-ups that ran at every start or waited for a breaking step (#2481), done once here.
         *
         * `grid_panels` goes: step 47 copied it into the workspace, and only migration steps up to 47 name it. The builds the floor (75) admits
         * neither read nor write it, so they open the store.
         *
         * Every "always allow" rule whose matcher ends in `*` goes (#838; the owner's yes on #1143, 2026-11-12, session-manager-split.md §7). A build
         * before #908 read such a rule as a prefix; since #908 a rule matches exactly and none of them allows anything. Every start deleted them
         * until now. Once is enough: the builds before #908 are far below the floor and cannot open the store, so a rule ending in `*` written
         * later is inert in every build that can.
         *
         * Breaking, as a drop and a delete of the person's rules are (rule 2 above `migrationSteps`), so the store is copied first; the floor stays 75:
         * the builds of v75 to v77 name neither, and open the store.
         */
        run: () => {
          this.db.exec(`DROP TABLE IF EXISTS grid_panels`)
          this.db.exec(`DELETE FROM approval_rules WHERE substr(matcher, -1) = '*'`)
        },
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
