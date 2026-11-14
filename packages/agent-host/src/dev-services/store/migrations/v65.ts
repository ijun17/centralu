import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { sessionAddress } from '../../../mail/address.js'
import { messageIdOf, UlidMaker } from '../../../mail/ids.js'
import { HUB_SELF_KEY } from '../store-keys.js'
import { MigrationRange, type MigrationStep } from './context.js'

/** The migration steps v65 to v74. The rule it follows is written above `migrationSteps` in `index.ts` */
export class StepsV65 extends MigrationRange {
  steps(): MigrationStep[] {
    return [
      {
        to: 65,
        breaksOlderReaders: false,
        /**
         * Mail without threads (docs/plans/mailbox.md §6.1, #1684): messages addressed to parties, and each recipient's
         * progress with one.
         *
         *   mail             one message: its sender, kind, body, the message it answers (`reply_to`) and the first of
         *                    that chain (`root_id`, computed once when stored), the message that started the sender's turn
         *                    (`cause_id`) and how many hops led to it (`depth`), and `facts`, which only Centralu writes.
         *                    `dedupe_key` is unique per sender: Centralu's "once per change" (§6.5). `legacy_thread` names
         *                    the v61 thread a message was moved from (§6.3)
         *   mail_recipients  one recipient's progress with one message: the delivery fields a v61 receipt had, the turn
         *                    the delivery started or joined, whether and how it was settled (answered, done, withdrawn,
         *                    reported, gone, legacy), its reminders, and when it was released and its sender told (§5.3)
         *
         * `mail_turns` gains the turn's work message (`message_id`), the message that started it (`starter_id`, so a
         * restart keeps a turn's cause) and how it ended (`ended_how`). `sessions.mail_args` is the mail tool schema a
         * session's process was spawned with (NULL reads as 1).
         *
         * No foreign keys and no CHECK on a word, as v61 (`v58.ts`): addresses name parties on other hosts, and an older
         * or newer build must be able to write a word the other does not know.
         *
         * **Expand only (#292's rule).** Two new tables, three nullable columns and indexes. An older build serving the
         * same store during a swap never names the new tables: it keeps writing the v61 tables, and names its columns in
         * every read and insert of `mail_turns` and `sessions`. Nothing reads the new tables in this build yet (slice M1).
         * The columns are added only when missing (`PRAGMA table_info`), as `v62.ts` does.
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS mail (
              id             TEXT PRIMARY KEY,
              sender         TEXT NOT NULL,
              sender_project TEXT,
              kind           TEXT NOT NULL,
              needs_reply    INTEGER NOT NULL DEFAULT 0,
              reply_to       TEXT,
              root_id        TEXT NOT NULL,
              cause_id       TEXT,
              depth          INTEGER NOT NULL DEFAULT 0,
              urgent         INTEGER NOT NULL DEFAULT 0,
              body           TEXT NOT NULL,
              facts          TEXT NOT NULL DEFAULT '{}',
              dedupe_key     TEXT,
              origin         TEXT,
              legacy_thread  TEXT,
              created_at     INTEGER NOT NULL,
              UNIQUE (sender, dedupe_key)
            );
            CREATE INDEX IF NOT EXISTS mail_root   ON mail(root_id, created_at);
            CREATE INDEX IF NOT EXISTS mail_reply  ON mail(reply_to) WHERE reply_to IS NOT NULL;
            CREATE INDEX IF NOT EXISTS mail_cause  ON mail(cause_id) WHERE cause_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS mail_sender ON mail(sender, created_at);
            CREATE INDEX IF NOT EXISTS mail_legacy ON mail(legacy_thread) WHERE legacy_thread IS NOT NULL;
            CREATE TABLE IF NOT EXISTS mail_recipients (
              message_id        TEXT NOT NULL,
              recipient         TEXT NOT NULL,
              recipient_project TEXT,
              via               TEXT,
              due_at            INTEGER NOT NULL,
              attempt_at        INTEGER,
              delivered_at      INTEGER,
              read_at           INTEGER,
              held              TEXT,
              attempts          INTEGER NOT NULL DEFAULT 0,
              last_error        TEXT,
              turn_seq          INTEGER,
              settled           TEXT,
              settled_at        INTEGER,
              answer_id         TEXT,
              reminded          INTEGER NOT NULL DEFAULT 0,
              reminded_at       INTEGER,
              released_at       INTEGER,
              released_why      TEXT,
              told_at           INTEGER,
              PRIMARY KEY (message_id, recipient)
            );
            CREATE INDEX IF NOT EXISTS mail_recipients_by      ON mail_recipients(recipient, delivered_at);
            CREATE INDEX IF NOT EXISTS mail_recipients_pending ON mail_recipients(recipient, due_at) WHERE delivered_at IS NULL;
            CREATE INDEX IF NOT EXISTS mail_recipients_open    ON mail_recipients(recipient) WHERE settled IS NULL;
            CREATE INDEX IF NOT EXISTS mail_recipients_untold  ON mail_recipients(released_at) WHERE released_at IS NOT NULL AND told_at IS NULL;
          `)
          this.addColumn('mail_turns', 'message_id', 'TEXT')
          this.addColumn('mail_turns', 'starter_id', 'TEXT')
          this.addColumn('mail_turns', 'ended_how', 'TEXT')
          this.addColumn('sessions', 'mail_args', 'INTEGER')
        },
      },
      {
        to: 66,
        breaksOlderReaders: false,
        /**
         * Mail held for the person (docs/plans/mailbox.md §7.4, M2): the Inbox's guidance and the person's trust and Dismiss read every
         * row with a hold (`heldRows`, `heldPolicy`), and without an index that is a scan of `mail_recipients` at each refresh. The
         * index holds only the rows that are held, which are few.
         *
         * **Expand only (#292's rule).** One index; an older build never names it.
         */
        run: () => {
          this.db.exec(`CREATE INDEX IF NOT EXISTS mail_recipients_held ON mail_recipients(held) WHERE held IS NOT NULL`)
        },
      },
      {
        to: 67,
        breaksOlderReaders: false,
        /**
         * The person's window numbers a chain's messages (docs/plans/mailbox.md §12, Q-M3a-26) and pages by those numbers (`after`): a number
         * must never name a second message, and `mail`'s rowid does (SQLite gives a deleted top row's number to the next row). Each message
         * gets its number here the first time the window reads its chain, in the order stored, and `AUTOINCREMENT` never gives one twice.
         *
         * **Expand only (#292's rule).** One table; an older build never names it.
         */
        run: () => {
          this.db.exec(`CREATE TABLE IF NOT EXISTS mail_numbers (n INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE)`)
        },
      },
      {
        to: 68,
        breaksOlderReaders: false,
        /**
         * The Assistant's marker under the role's new name (#2133 step 3, docs/plans/assistant-rename.md): `sessions.is_assistant`,
         * copied once from `is_orchestrator`.
         *
         * **Expand only (#292's rule).** One defaulted column. Nothing in this build reads it: every build that can open this
         * store writes `is_orchestrator`, and the build before this one writes only that, so `is_orchestrator` is the one
         * that is never stale and the one read. This build writes both on every upsert (`SessionRecords.upsertSession`), so the
         * new column is right whenever this build wrote last; a later build that reads it copies it again first (step 4).
         */
        run: () => {
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (cols.length === 0) return
          this.addColumn('sessions', 'is_assistant', 'INTEGER NOT NULL DEFAULT 0')
          if (cols.some((c) => c.name === 'is_orchestrator')) this.db.exec(`UPDATE sessions SET is_assistant = is_orchestrator`)
        },
      },
      {
        to: 69,
        breaksOlderReaders: true,
        minReader: 68,
        /**
         * The Assistant's stored values read under the role's new name from here on (#2133 step 4, docs/plans/assistant-rename.md
         * §3.2): `is_assistant` is copied from `is_orchestrator` on every row once more, each new settings key is set from its
         * old key, and **a new key whose old key is absent is deleted**. A build of v68 writes both forms, but the build before
         * it writes and deletes only the old one: after a person went back to it, `is_assistant` and the new keys can be stale,
         * and where it deleted the old key (the last skill removed, a list emptied) the new key it left would bring back what
         * the person removed. This copy makes the old form the truth one last time; from here on the new form is read first.
         *
         * **Breaks the builds that write the old form alone, and only them:** the floor goes to 68, not 69 (`minReader`). A
         * build of v68 (beta.54 on) writes and deletes both forms (`SettingsRecords`, `SessionRecords.upsertSession`), so the
         * new form stays right when a person goes back to it; a build of v67 or before would leave it stale, and is kept out.
         * Both forms stay, and this build keeps writing both, so v68 still reads the old one; dropping them is a later step.
         */
        run: () => {
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (cols.some((c) => c.name === 'is_orchestrator') && cols.some((c) => c.name === 'is_assistant')) {
            this.db.exec(`UPDATE sessions SET is_assistant = is_orchestrator`)
          }
          if (this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'`).get() === undefined) return
          const copy = this.db.prepare(
            `INSERT INTO app_settings (key, value) SELECT ?, value FROM app_settings WHERE key = ?
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          const drop = this.db.prepare(`DELETE FROM app_settings WHERE key = ? AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ?)`)
          // The keys as they were when this step shipped, not the live `RENAMED_SETTINGS`: a step does the same on every store
          for (const [old, renamed] of [
            ['orchestrator_tool', 'assistant_tool'],
            ['orchestrator_mcp_proposals', 'assistant_mcp_proposals'],
            ['orchestrator_skill_proposals', 'assistant_skill_proposals'],
            ['orchestrator_skills', 'assistant_skills'],
          ] as const) {
            copy.run(renamed, old)
            drop.run(renamed, old)
          }
        },
      },
      {
        to: 70,
        breaksOlderReaders: false,
        /**
         * The answers a session's question to the person offers (docs/plans/mailbox.md D33, #1630): `mail.choices`, a JSON array of 2 to 6
         * strings, NULL on every other message. They are the sender's words, so they have a column of their own: `facts` is Centralu's
         * record, which a session cannot write (docs/security-boundaries/mailbox-and-requests.md).
         *
         * **Expand only (#292's rule).** One nullable column. An older build names its columns in every read and insert of `mail`
         * (`SELECT *` is read by name), so it never sees the column: it opens the store, and a question shows without its choices.
         * Nothing is backfilled: no build stored choices anywhere else before this one.
         */
        run: () => {
          this.addColumn('mail', 'choices', 'TEXT')
        },
      },
      {
        to: 71,
        breaksOlderReaders: false,
        /**
         * The subject a session's `mail` send gives the chain it starts (#2229): `mail.subject`, one line of at most 80 characters, NULL on
         * every other message. The sender's words, so a column of its own as v70's choices: `facts` is Centralu's record. The person's Inbox
         * names the chain by it instead of its first message's words.
         *
         * **Expand only (#292's rule).** One nullable column. An older build names its columns in every read and insert of `mail`, so it
         * never sees it: it opens the store and names the chain by its words, as before. Nothing is backfilled: no build kept a subject.
         */
        run: () => {
          this.addColumn('mail', 'subject', 'TEXT')
        },
      },
      {
        to: 72,
        breaksOlderReaders: false,
        /**
         * The holds of an earlier build, ended (#2243). The mail token guard (`budget`) went with D32 (#2014, beta.49) and the `auto` receiver's
         * first-contact hold (`holdsInbound`) with D10, but the rows an earlier build held kept their hold when the v65 move carried them (settled
         * `legacy`), so the Inbox's Waiting listed "Paused: this session has used its share of turns started by mail" and "Held: this session runs
         * without asking" weeks after nothing could write such a hold.
         *
         * **One meaning: a hold from an earlier build stays only if today's gate would hold the mail now.** `budget` is never set by today's code, so every
         * such row goes. A `policy` row settled `legacy` stays while `reach.holdFor` (mail/reach.ts) would hold it: a `message` from an untrusted project (a
         * missing project row is untrusted) to a session of another project, which is how a genuine untrusted asker's request is still held. The
         * delivery also holds moved rows that way (it judges a `legacy` row like any other, and `records.hold` writes `held` alone), so the same row looks
         * the same whoever held it, and this step cannot tell them apart; it asks the gate, as the move asks it for the rows it moves from now on. What the
         * gate would not hold goes, and what goes is `dismissed`, the hold word the person's Dismiss sets (not held for the person, never delivered):
         * `gone` says a sender or recipient is gone and `withdrawn` that the sender said it no longer waits, and neither is so. `settled` stays `legacy`.
         *
         * **This is a frozen copy of `holdFor`'s conditions, on purpose.** A step runs once on every store and must not call code that may change later;
         * if `holdFor` changes, this step does not. It mirrors: `m.kind === 'message'`; `leaves(senderProject, recipientProject)` = the sender's project is
         * not null and untrusted (`projects.trusted = 0`, or no such project) and is not the recipient session's project; the recipient is a session of this
         * host that is kept (a `sessions` row with `deleted_at` NULL: the live session lookup skips a trashed one, so the gate holds nothing for it). The
         * recipient's project is read from `sessions.project_id` and the sender's from `mail.sender_project`, as the move wrote it.
         *
         * **Not mirrored: a recipient on another machine** (a linked hub's session, a linked-machine child), which the live gate holds and this step
         * dismisses, since it compares the session id with this host's `sessions` rows only. That is acceptable: no such row is on the owner's store (read
         * only, 2026-11-13: all six held rows leave), and an old hold on another machine's session could not be released from this one in any case (Release
         * sends through this host's delivery to a session it keeps). There is no cheap exact way: the far session's project is not stored here.
         *
         * **Rewrite data one way (#292's rule 1).** An older build reads `dismissed` as it reads the person's own Dismiss (it is in its `HELD` filter),
         * and does not bring the holds back. Nothing is deleted: the message and its row stay. The sender is not told: the person did not dismiss it.
         */
        run: () => {
          // A store with no table, or no row held `budget` or `policy`, has nothing to judge (and a test's partial schema lacks the tables the judgement reads)
          if (this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mail_recipients'`).get() === undefined) return
          if (this.db.prepare(`SELECT 1 FROM mail_recipients WHERE held IN ('budget', 'policy') LIMIT 1`).get() === undefined) return
          this.db.exec(
            `UPDATE mail_recipients SET held = 'dismissed', attempt_at = NULL, last_error = NULL, attempts = 0
              WHERE held = 'budget'
                 OR (held = 'policy' AND settled = 'legacy' AND NOT EXISTS (
                      SELECT 1 FROM mail m, sessions s
                       WHERE m.id = mail_recipients.message_id AND m.kind = 'message' AND s.deleted_at IS NULL
                         AND m.sender_project IS NOT NULL
                         AND COALESCE((SELECT p.trusted FROM projects p WHERE p.id = m.sender_project), 0) = 0
                         AND mail_recipients.recipient LIKE 'session:%' AND substr(mail_recipients.recipient, instr(mail_recipients.recipient, '/') + 1) = s.id
                         AND s.project_id IS NOT m.sender_project))`,
          )
        },
      },
      {
        to: 73,
        breaksOlderReaders: false,
        /**
         * The watches sessions keep (#1324, docs/plans/mailbox.md §18.4): `mail_watches`, one row per watch. `source` and `target` say what it
         * waits for (`session` and an address, `time` and the words given), `spec` the rest as JSON (a slot and period, or a session's baseline),
         * `state` one of `active`, `fired`, `expired`, `cancelled`, `gone`. No CHECK on a word, as v58: a newer build may write one this build
         * does not know.
         *
         * **Expand only (#292's rule).** A new table and its indexes. An older build never names it: after a rollback the watches sleep and fire
         * nothing, and an update back picks them up.
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS mail_watches (
              id          TEXT PRIMARY KEY,
              owner       TEXT NOT NULL,
              source      TEXT NOT NULL,
              target      TEXT NOT NULL,
              spec        TEXT NOT NULL,
              note        TEXT NOT NULL DEFAULT '',
              state       TEXT NOT NULL,
              last_key    TEXT,
              fired_count INTEGER NOT NULL DEFAULT 0,
              created_at  INTEGER NOT NULL,
              expires_at  INTEGER NOT NULL,
              next_at     INTEGER,
              ended_at    INTEGER,
              ended_by    TEXT
            );
            CREATE INDEX IF NOT EXISTS mail_watches_owner ON mail_watches(owner, state);
            CREATE INDEX IF NOT EXISTS mail_watches_due ON mail_watches(state, next_at);
          `)
        },
      },
      {
        to: 74,
        breaksOlderReaders: true,
        minReader: 70,
        /**
         * One record of an owed answer (#2258 item 1, docs/plans/mailbox.md M7, M8): the task row. The builds before #1948 steps 2 to 4 (beta.57
         * and before, whose newest step is 69) kept a second one: a request held for a busy session (`queued_requests`), a report owed
         * (`report_marks`, which they also read to settle every task no mark owes), the turn another session gave (`delegated_turns`) and whose a
         * turn is (`RETIRED_SESSION_KEYS`). The build of v70 (beta.58) is the first that writes none of them but the marks it leaves for those
         * builds, so the floor goes to 70: those builds no longer open the store, and this build neither reads nor leaves them anything.
         *
         * What such a build left is turned into mail once, here, as the start of the builds from v70 to v73 did at every `ready`: a held request
         * becomes a task from its requester, not delivered, which the delivery gives its session; a mark whose caller has no unsettled task to
         * its session becomes one, delivered (the work was), `start_agent` when the caller started the session, else `send_to_session`. A row
         * whose sessions are not both kept (`deleted_at` NULL) goes with no task. Then every row of the four goes.
         *
         * **A frozen copy of `MessageService.task` and of the old adoption, on purpose**: a step runs once on every store and must not call code
         * that may change. Only the id and address shapes are imported (mail/ids.ts, mail/address.ts), as the stored shapes they are.
         *
         * The tables stay: the builds from v70 to v73 read them at every start. They go in a later step, once the floor is at or above 74.
         */
        run: () => this.oneRecordOfOwedWork(),
      },
    ]
  }

  /** Step 74: what the builds before v70 kept beside the task rows, turned into tasks and deleted */
  private oneRecordOfOwedWork(): void {
    const has = (table: string) => this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined
    if (has('app_settings')) this.db.prepare(`DELETE FROM app_settings WHERE substr(key, 1, instr(key, ':') - 1) IN (SELECT value FROM json_each(?))`).run(JSON.stringify(RETIRED_SESSION_KEYS))
    if (has('delegated_turns')) this.db.exec(`DELETE FROM delegated_turns`)
    if (!has('mail') || !has('mail_recipients') || !has('sessions')) return
    const queued = has('queued_requests')
      ? this.db.prepare<[], { session: string; caller: string; via: string; text: string }>(`SELECT session_id AS session, caller_session_id AS caller, via, text FROM queued_requests ORDER BY queued_at, rowid`).all()
      : []
    const marks = has('report_marks') ? this.db.prepare<[], { session: string; caller: string }>(`SELECT session_id AS session, caller_session_id AS caller FROM report_marks ORDER BY marked_at`).all() : []
    const tasks = new OldWorkTasks(this.db, () => this.hostId())
    for (const q of queued) if (OLD_SEND_ORIGINS.includes(q.via) && q.text.trim() !== '') tasks.write(q.caller, q.session, { body: q.text, origin: () => q.via, delivered: false })
    for (const m of marks) {
      tasks.write(m.caller, m.session, { body: ADOPTED_TASK, origin: (session) => (session.askedBy === m.caller ? 'start_agent' : 'send_to_session'), delivered: true })
    }
    if (queued.length > 0) this.db.exec(`DELETE FROM queued_requests`)
    if (marks.length > 0) this.db.exec(`DELETE FROM report_marks`)
  }

  /** This host's id in mail addresses (`hubSelfId`, links/stored.ts): the one kept, else one made and kept, as `hubSelfId` makes it */
  private hostId(): string {
    const stored = this.db.prepare<[string], { value: string }>(`SELECT value FROM app_settings WHERE key = ?`).get(HUB_SELF_KEY)?.value
    if (stored && /^hub-[0-9a-f]{8}$/.test(stored)) return stored
    const made = `hub-${randomBytes(4).toString('hex')}`
    this.db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(HUB_SELF_KEY, made)
    return made
  }

  /** Adds a column the table lacks. A table that does not exist (a test's partial schema) is left alone */
  private addColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(${table})`).all()
    if (cols.length > 0 && !cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

/** The tools an earlier build queued a request for (`SEND_ORIGINS` then) */
const OLD_SEND_ORIGINS = ['agent_session', 'ask_project', 'send_to_session']

/** What an earlier build kept per session of whose a turn is and of a paused report (`<name>:<sessionId>` in `app_settings`) */
const RETIRED_SESSION_KEYS = ['turn_inputs', 'report_turn', 'input_origins', 'report_paused', 'person_report_paused']

/** The words of a task step 74 writes for a report mark: the work was given before mail recorded it */
const ADOPTED_TASK = 'Work given before this version of Centralu wrote it down as mail. The conversation of the session that does it shows what was asked.'

type KeptSession = { project: string | null; askedBy: string | null }

/** Step 74's tasks, as `MessageService.task` wrote them then: from a kept session to another, a delivered one only when the pair has no open task */
class OldWorkTasks {
  private readonly ulids = new UlidMaker()
  private readonly now = Date.now()
  private host: string | null = null
  private readonly kept: Database.Statement<[string], KeptSession>
  private readonly open: Database.Statement<[string, string], unknown>
  private readonly mail: Database.Statement
  private readonly row: Database.Statement

  constructor(db: Database.Database, private readonly hostId: () => string) {
    this.kept = db.prepare(`SELECT project_id AS project, asked_by_session_id AS askedBy FROM sessions WHERE id = ? AND deleted_at IS NULL`)
    this.open = db.prepare(`SELECT 1 FROM mail m JOIN mail_recipients r ON r.message_id = m.id WHERE m.sender = ? AND m.kind = 'task' AND r.recipient = ? AND r.settled IS NULL`)
    this.mail = db.prepare(
      `INSERT INTO mail (id, sender, sender_project, kind, needs_reply, reply_to, root_id, cause_id, depth, urgent, body, facts, origin, created_at)
       VALUES (@id, @sender, @senderProject, 'task', 0, NULL, @id, NULL, 0, 0, @body, '{}', @origin, @now)`,
    )
    this.row = db.prepare(`INSERT INTO mail_recipients (message_id, recipient, recipient_project, due_at, delivered_at, read_at) VALUES (@id, @recipient, @project, @dueAt, @delivered, @delivered)`)
  }

  write(callerId: string, sessionId: string, t: { body: string; origin: (session: KeptSession) => string; delivered: boolean }): void {
    const caller = this.kept.get(callerId)
    const session = this.kept.get(sessionId)
    if (!caller || !session || callerId === sessionId) return
    this.host ??= this.hostId()
    const sender = sessionAddress(this.host, callerId)
    const recipient = sessionAddress(this.host, sessionId)
    if (t.delivered && this.open.get(sender, recipient) !== undefined) return
    const id = messageIdOf(this.host, this.ulids.next(this.now))
    this.mail.run({ id, sender, senderProject: caller.project, body: t.body, origin: t.origin(session), now: this.now })
    // Not delivered: due after the delivery's 2 s gap, as a session's task was (`dueAt`)
    this.row.run({ id, recipient, project: session.project, dueAt: t.delivered ? this.now : this.now + 2_000, delivered: t.delivered ? this.now : null })
  }
}
