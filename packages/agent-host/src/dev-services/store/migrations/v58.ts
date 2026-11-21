import { MigrationRange, type MigrationStep } from './context.js'

/**
 * The migration steps from v58, in order. The rule they follow is written above `migrationSteps` in `index.ts`.
 *
 * v57 is #1121's (in `v55.ts`); this file starts at v58 so the two changes do not edit the same lines.
 */
export class StepsV58 extends MigrationRange {
  steps(): MigrationStep[] {
    return [
      {
        to: 58,
        breaksOlderReaders: false,
        /**
         * A session's subagent steps can go to the trash without it (#418): `subagent_messages.trashed_at`, the time
         * they were moved there, NULL for a step under its card.
         *
         * **A column, not a table to move the rows into.** A subagent still running numbers its next step after the
         * last one it kept (`appendSubagentMessage`), the trashed ones included, so a restore never meets a step with the
         * same number. The rows stay where they are, so the session's purge, which deletes every row of the session,
         * takes them too, in this build and in an older one.
         *
         * **Expand only (#292's rule).** A nullable column and an index. An older build reads trashed steps as steps (its card shows
         * them again) and never writes the column, so nothing is lost either way.
         */
        run: () => {
          const has = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'subagent_messages'`).get()
          if (!has) return
          const cols = new Set(this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(subagent_messages)`).all().map((c) => c.name))
          if (!cols.has('trashed_at')) this.db.exec(`ALTER TABLE subagent_messages ADD COLUMN trashed_at INTEGER`)
          /*
           * Which steps are in the trash, read without the rows: the column comes after the payload, so a row read for
           * it walks the payload's overflow pages (a step holds a tool's whole output, #221)
           */
          this.db.exec(`CREATE INDEX IF NOT EXISTS subagent_messages_trash ON subagent_messages(session_id, trashed_at, parent_call_id)`)
        },
      },
      {
        to: 59,
        breaksOlderReaders: false,
        /**
         * When the hub opens a linked machine's link (#1134): `linked_machines.connect` is `when_needed` for a machine
         * the hub connects only when something needs it, and null for one it connects at start, which is what every
         * machine did before the column.
         *
         * **Expand only (#292's rule).** A nullable column. An older host names its columns in every read and insert,
         * so it neither reads this one nor fails on it, and connects every machine at start as it always did; a machine
         * it adds gets null, which is `at_start`. `IF` because a store from a test's partial schema has no such table.
         */
        run: () => {
          const cols = new Set(this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(linked_machines)`).all().map((c) => c.name))
          if (cols.size > 0 && !cols.has('connect')) this.db.exec(`ALTER TABLE linked_machines ADD COLUMN connect TEXT`)
        },
      },
      {
        to: 60,
        breaksOlderReaders: false,
        /**
         * The reverse direction of linked machines (#550, docs/plans/remote-hub.md §12.7): a linked machine's sessions
         * asking this computer's projects.
         *
         *   linked_machines.asks  the per-machine switch in Settings → Machines, off (0) by default; on the machine's row,
         *                         so it goes with the machine, and a machine linked again under the same name starts off
         *   machine_ask_consents  one row per pair approved on this computer's card: a session of that machine (its id
         *                         there, its name when approved, for Settings) and a project here; later asks in the pair
         *                         need no card until withdrawn. Both ends CASCADE, whichever build removes the machine
         *
         * Expand only (#292): an older host's insert gets the switch off; it never reads the table, and its delete cascades.
         */
        run: () => {
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(linked_machines)`).all()
          if (cols.length > 0 && !cols.some((c) => c.name === 'asks')) {
            this.db.exec(`ALTER TABLE linked_machines ADD COLUMN asks INTEGER NOT NULL DEFAULT 0`)
          }
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS machine_ask_consents (
              machine_id   TEXT NOT NULL REFERENCES linked_machines(id) ON DELETE CASCADE,
              session_id   TEXT NOT NULL,
              session_name TEXT NOT NULL,
              project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              decided_at   INTEGER NOT NULL,
              PRIMARY KEY (machine_id, session_id, project_id)
            )
          `)
        },
      },
      {
        to: 61,
        breaksOlderReaders: false,
        /**
         * The mailbox (#1347, docs/plans/mailbox.md §6): one durable channel between sessions, apps and the person.
         *
         *   mail_threads       a conversation that is also a task; `home` owns the task fields; `pinned_at` keeps a done thread past retention
         *   mail_participants  role (owner, assignee, member); `read_seq`, where `mail read` goes on. `mail_blockers`: what stands in the way (at most 5)
         *   mail_messages      `seq` its place in the thread on this host; `facts` only Centralu writes; `dedupe_key` is unique per thread and
         *                      sender: a change posted twice is stored once, and no session can claim a key an app will use
         *   mail_receipts      one recipient's progress with one message: due, attempted, delivered, read, handled
         *   mail_turns         whose each turn of a session was; `mail_turns_open` finds a thread's running turn without a scan
         *
         * No foreign keys, as `report_marks` (a trashed session's rows stay until `purgeSession`; addresses name parties on other hosts
         * too); no CHECK on a word a newer build may write. Expand only (#292): an older host never names these tables, keeps writing
         * `report_marks`, `delegated_turns` and `queued_requests` (adopted in slice 3), and leaves their rows alone when it deletes a session.
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS mail_threads (
              id          TEXT PRIMARY KEY,
              home        TEXT NOT NULL,
              project_id  TEXT,
              subject     TEXT NOT NULL,
              origin      TEXT NOT NULL,
              depth       INTEGER NOT NULL DEFAULT 0,
              parent_id   TEXT,
              follows     TEXT,
              state       TEXT NOT NULL,
              outcome     TEXT,
              owner       TEXT NOT NULL,
              assignee    TEXT,
              next_step   TEXT,
              links       TEXT NOT NULL DEFAULT '{}',
              rev         INTEGER NOT NULL DEFAULT 0,
              pinned_at   INTEGER,
              created_at  INTEGER NOT NULL,
              updated_at  INTEGER NOT NULL,
              state_since INTEGER NOT NULL,
              done_at     INTEGER
            );
            CREATE INDEX IF NOT EXISTS mail_threads_state ON mail_threads(state, updated_at);
            CREATE TABLE IF NOT EXISTS mail_participants (
              thread_id TEXT NOT NULL,
              address   TEXT NOT NULL,
              role      TEXT NOT NULL,
              joined_at INTEGER NOT NULL,
              left_at   INTEGER,
              read_seq  INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (thread_id, address)
            );
            CREATE INDEX IF NOT EXISTS mail_participants_address ON mail_participants(address);
            CREATE TABLE IF NOT EXISTS mail_blockers (
              thread_id   TEXT NOT NULL,
              n           INTEGER NOT NULL,
              kind        TEXT NOT NULL,
              ref         TEXT,
              text        TEXT NOT NULL,
              resolved_at INTEGER,
              PRIMARY KEY (thread_id, n)
            );
            CREATE TABLE IF NOT EXISTS mail_messages (
              id          TEXT PRIMARY KEY,
              thread_id   TEXT NOT NULL,
              seq         INTEGER NOT NULL,
              home_seq    INTEGER,
              sender      TEXT NOT NULL,
              kind        TEXT NOT NULL,
              urgent      INTEGER NOT NULL DEFAULT 0,
              needs_owner INTEGER NOT NULL DEFAULT 0,
              wake        TEXT,
              reply_to    TEXT,
              body        TEXT NOT NULL,
              facts       TEXT NOT NULL DEFAULT '{}',
              dedupe_key  TEXT,
              created_at  INTEGER NOT NULL,
              UNIQUE (thread_id, seq),
              UNIQUE (thread_id, sender, dedupe_key)
            );
            CREATE INDEX IF NOT EXISTS mail_messages_dedupe ON mail_messages(sender, dedupe_key) WHERE dedupe_key IS NOT NULL;
            CREATE TABLE IF NOT EXISTS mail_receipts (
              message_id   TEXT NOT NULL,
              recipient    TEXT NOT NULL,
              due_at       INTEGER NOT NULL,
              attempt_at   INTEGER,
              delivered_at INTEGER,
              read_at      INTEGER,
              handled_at   INTEGER,
              held         TEXT,
              attempts     INTEGER NOT NULL DEFAULT 0,
              last_error   TEXT,
              PRIMARY KEY (message_id, recipient)
            );
            CREATE INDEX IF NOT EXISTS mail_receipts_pending ON mail_receipts(recipient, due_at) WHERE delivered_at IS NULL;
            CREATE TABLE IF NOT EXISTS mail_turns (
              session_id TEXT NOT NULL,
              turn_seq   INTEGER NOT NULL,
              thread_id  TEXT,
              started_by TEXT NOT NULL,
              started_at INTEGER NOT NULL,
              ended_at   INTEGER,
              outcome    TEXT,
              PRIMARY KEY (session_id, turn_seq)
            );
            CREATE INDEX IF NOT EXISTS mail_turns_open ON mail_turns(thread_id) WHERE ended_at IS NULL;
          `)
        },
      },
    ]
  }
}
