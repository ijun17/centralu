import { MigrationRange, type MigrationStep } from './context.js'

/** The migration steps v65 to v69. The rule it follows is written above `migrationSteps` in `index.ts` */
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
    ]
  }

  /** Adds a column the table lacks. A table that does not exist (a test's partial schema) is left alone */
  private addColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(${table})`).all()
    if (cols.length > 0 && !cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}
