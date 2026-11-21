import { oneRow, pragmaNumber } from '../rows.js'
import { INDEXED_KINDS, indexedText } from '../search-index.js'
import { bytesText } from '../../../bytes-text.js'
import { VACUUM_FREE_BYTES } from '../vacuum.js'
import { MigrationRange, type MigrationStep } from './context.js'

/** The migration steps v28 to v40, in order. The rule they follow is written above `migrationSteps` in `index.ts` */
export class StepsV28ToV40 extends MigrationRange {
  steps(): MigrationStep[] {
    return [
      {
        to: 28,
        // Drops `sessions.archived`: the v27 build indexes and inserts that column, so it fails on start
        breaksOlderReaders: true,
        run: () => {
          /*
           * Retires the archive: the inbox's `d` hid a session with no way back. Every hidden session becomes
           * visible again, since nothing is left to filter on. The index goes first: SQLite cannot DROP a column
           * an index refers to.
           */
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (!cols.some((c) => c.name === 'archived')) return
          this.db.exec(`DROP INDEX IF EXISTS idx_sessions_project`)
          this.db.exec(`ALTER TABLE sessions DROP COLUMN archived`)
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`)
        },
      },
      {
        to: 29,
        // Scans every message, but rewrites only the trampled ones, and ts is read the same way by every build
        breaksOlderReaders: false,
        run: () => {
          /*
           * Repairs the assistant-row timestamps the v21 merge step overwrote with `Date.now()` when beta.4 rewound
           * user_version and replayed it. The originals are lost, but seq is trustworthy: a row whose ts exceeds a
           * later row's is false. Walking back to front and clamping to the running minimum gives each such row an
           * upper bound (the next genuine row's time), not exact but order-preserving.
           */
          const rows = this.db
            .prepare<unknown[], { rowid: number; session_id: string; ts: number }>(`SELECT rowid, session_id, ts FROM messages ORDER BY session_id, seq DESC`)
            .all()
          const fix = this.db.prepare(`UPDATE messages SET ts = ? WHERE rowid = ?`)
          let repaired = 0
          const tx = this.db.transaction(() => {
            let session = ''
            let floor = Number.MAX_SAFE_INTEGER
            for (const r of rows) {
              if (r.session_id !== session) {
                session = r.session_id
                floor = Number.MAX_SAFE_INTEGER
              }
              if (r.ts > floor) {
                fix.run(floor, r.rowid)
                repaired += 1
              } else {
                floor = r.ts
              }
            }
          })
          tx()
          if (repaired > 0) console.error(`[store] repaired ${repaired} message timestamps trampled by the merge migration`)
        },
      },
      {
        to: 30,
        breaksOlderReaders: false,
        /*
         * The two handles of a coordinating session (#80, #81) — a visibility allow-list
         * (JSON), and the role text fixed at creation time. There is no "task" or "lead"
         * concept in the core: these columns are the mechanism (enforcing visibility,
         * reapplying the role), and the app supplies the meaning.
         */
        run: () => {
          // Idempotent — a test rewinds user_version and replays this (following parent_session_id's precedent)
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (!cols.some((c) => c.name === 'scope_session_ids')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN scope_session_ids TEXT`)
          }
          if (!cols.some((c) => c.name === 'role_append')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN role_append TEXT`)
          }
        },
      },
      {
        to: 31,
        breaksOlderReaders: false,
        /**
         * The app that owns a session (#81): a running app shows its own sessions, the sidebar only projects. Old
         * rows are null, read as "no owner", and fall back to the sidebar, so no session becomes unreachable.
         */
        run: () => {
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (!cols.some((c) => c.name === 'app_id')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN app_id TEXT`)
          }
        },
      },
      {
        to: 32,
        // Drops `projects.default_model` and `default_effort`: the v31 build selects and updates them
        breaksOlderReaders: true,
        /**
         * The default model and effort get a tool of their own (#107): a model name is one tool's vocabulary, and a
         * project with `default_tool=codex` and `default_model=opus[1m]` killed every codex session on its first turn.
         *
         * The old value is dropped, not attached to the current `default_tool`: the scalar never recorded which tool
         * it was chosen for, and that guess is the bug. A lost default costs one click; a wrong one, a dead session.
         * The columns hold only the last choice made, so nothing worth keeping goes with them.
         */
        run: () => {
          const cols = () => this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(projects)`).all()
          if (!cols().some((c) => c.name === 'default_models')) {
            this.db.exec(`ALTER TABLE projects ADD COLUMN default_models TEXT`)
          }
          for (const dead of ['default_model', 'default_effort']) {
            if (cols().some((c) => c.name === dead)) {
              this.db.exec(`ALTER TABLE projects DROP COLUMN ${dead}`)
            }
          }
        },
      },
      {
        to: 33,
        breaksOlderReaders: false,
        /**
         * Project trust (M4 A-2, plan decision 3): "is it fine to run this repository's code on this machine". Opening
         * a repository someone handed you must not run its apps' `server.command` with your permissions, so an app
         * launches only in a trusted project (discovery and listing ignore trust). The same column answers #92
         * (respecting project settings). Every project, existing rows included, starts at "no" (a "yes" would be a silent grant); v35 trusts the rows that exist before it.
         */
        run: () => {
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(projects)`).all()
          if (!cols.some((c) => c.name === 'trusted')) {
            this.db.exec(`ALTER TABLE projects ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0`)
          }
        },
      },
      {
        to: 34,
        breaksOlderReaders: false,
        /**
         * A run log for external apps (M4 A-6): the broker, which every call passes through, writes one row per call,
         * so a call from the UI or app-to-app is recorded, not only an agent's (which its conversation holds).
         *
         *   project_id    an app id is unique only within its scope (project or user folder); null is a user-folder app
         *   args_summary  arguments are kept only as a summary and a hash; a hash alone gives a person nothing to read
         *   error         the reason for a rejection or failure, which the history screen (B-7) shows
         *
         * `app_run_failures` keeps the raw arguments (secrets redacted) for only the most recent few failures: an
         * agent debugging an app needs the input that failed, not every call's.
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS app_runs (
              id                TEXT PRIMARY KEY,
              project_id        TEXT,
              app_id            TEXT NOT NULL,
              tool              TEXT NOT NULL,
              caller_kind       TEXT NOT NULL,
              caller_session_id TEXT,
              parent_run_id     TEXT,
              status            TEXT NOT NULL,
              duration_ms       INTEGER,
              args_digest       TEXT NOT NULL,
              args_summary      TEXT NOT NULL,
              error             TEXT,
              created_at        INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_app_runs_app ON app_runs(app_id, project_id, created_at);
            CREATE TABLE IF NOT EXISTS app_run_failures (
              run_id     TEXT PRIMARY KEY,
              project_id TEXT,
              app_id     TEXT NOT NULL,
              args       TEXT NOT NULL,
              result     TEXT,
              created_at INTEGER NOT NULL
            );
          `)
        },
      },
      {
        to: 35,
        // One-way, but `trusted` already exists in the build before it
        breaksOlderReaders: false,
        /**
         * Projects registered before this step are trusted (M4): they are folders a person chose by hand, and trust
         * also decides #92 (respecting project settings), so leaving them at v33's "no" would silently start ignoring
         * their `.claude/` settings. Projects registered later still start at "no" and are asked once, at registration.
         *
         * It must run only once, or a start would re-enable trust a person turned off: the runner never replays a
         * step that ran (user_version), and on a new database it touches no rows.
         */
        run: () => {
          this.db.exec(`UPDATE projects SET trusted = 1`)
        },
      },
      {
        to: 36,
        breaksOlderReaders: false,
        /**
         * The person's answer to an app's capability request (M4 D-4): the memory of "ask once on first use".
         *
         * The key is `app_key` (`<project id | _user>/<app id>`), not project_id: a user-folder app's project_id is
         * null, and SQLite's PRIMARY KEY treats NULLs as distinct, which would allow two rows for one capability.
         * project_id stays a column so the rows go with a deleted project.
         *
         * `uses_stamp` fingerprints the manifest's `uses` when answered; once it changes, the question is asked again.
         * `text` is what the person was shown, and the history screen shows it back.
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS app_permissions (
              app_key    TEXT NOT NULL,
              project_id TEXT,
              capability TEXT NOT NULL,
              text       TEXT NOT NULL,
              decision   TEXT NOT NULL,
              uses_stamp TEXT NOT NULL,
              decided_at INTEGER NOT NULL,
              PRIMARY KEY (app_key, capability)
            );
          `)
        },
      },
      {
        to: 37,
        breaksOlderReaders: false,
        /**
         * The run log becomes a chain (M4 D-6): what an app asks the broker for over fd 3 gets a row under the run
         * that caused it.
         *
         *   kind        `tool` is a call to the app's tool (every old row), `broker` a request the app made to the broker
         *   session_id  the agent session run_agent set up, where the history screen jumps to
         *
         * `parent_run_id` is indexed: the history screen walks the chain downward with a recursive query, and without
         * the index every step scans the whole table.
         */
        run: () => {
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(app_runs)`).all()
          // A database with no table has only had its version bumped, never gone through v34
          // (an old database made by the migration tests) — there is no table to fix
          if (cols.length === 0) return
          if (!cols.some((c) => c.name === 'kind')) this.db.exec(`ALTER TABLE app_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'tool'`)
          if (!cols.some((c) => c.name === 'session_id')) this.db.exec(`ALTER TABLE app_runs ADD COLUMN session_id TEXT`)
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_app_runs_parent ON app_runs(parent_run_id)`)
        },
      },
      {
        to: 38,
        breaksOlderReaders: false,
        /**
         * Tokens spent by an agent an app requested (M4 D-5) — a run_agent row records the input
         * and output tokens the tool reported. The history screen sums these from this table
         * per app for "how many times, how long, how much" (`appAgentUse`). Every other kind of
         * row, and old rows, are null.
         */
        run: () => {
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(app_runs)`).all()
          if (cols.length === 0) return
          if (!cols.some((c) => c.name === 'tokens_in')) this.db.exec(`ALTER TABLE app_runs ADD COLUMN tokens_in INTEGER`)
          if (!cols.some((c) => c.name === 'tokens_out')) this.db.exec(`ALTER TABLE app_runs ADD COLUMN tokens_out INTEGER`)
        },
      },
      {
        to: 39,
        // An older build shows sessions in the trash as live ones; nothing is lost and nothing fails
        breaksOlderReaders: false,
        /**
         * The session archive (#204; called the trash until #1404, which is why the column below is `trash`): archiving a
         * session stops destroying it.
         *
         *   deleted_at  when the person moved it to the trash; NULL is a live session. Every listing query filters on it
         *   trash       JSON (`TrashRecord`): where it came from (project id, name and path) and what the person chose to
         *               remove with it when it is deleted for good (conversation file, worktree). NULL on a live session
         *
         * A column, not a side table whose `NOT EXISTS` join every listing would have to remember; NULL on older rows is
         * true. No index: the table holds tens of rows. Rows later steps add for a session (see `purgeSession`) must
         * allow for it being in the trash, still pointing at it.
         */
        run: () => {
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (!cols.some((c) => c.name === 'deleted_at')) this.db.exec(`ALTER TABLE sessions ADD COLUMN deleted_at INTEGER`)
          if (!cols.some((c) => c.name === 'trash')) this.db.exec(`ALTER TABLE sessions ADD COLUMN trash TEXT`)
        },
      },
      {
        to: 40,
        // Rebuilds the whole index and vacuums. An older build's new tool-call rows in the index are harmless
        breaksOlderReaders: false,
        heavy: true,
        /**
         * Tool calls leave the search index, and the file gives the space back (#221).
         *
         * From here on only what the person and the agent said, and the agent's reasoning, are indexed
         * (`INDEXED_KINDS`). The rows the index already holds for tool calls are the bulk of it, so the index is
         * rebuilt rather than picked clean, and the file is vacuumed — SQLite does not hand freed pages back on its own
         * (v11's note). See `rebuildIndexWithoutToolCalls` for what was measured.
         */
        run: () => this.rebuildIndexWithoutToolCalls(),
      },
    ]
  }

  /**
   * v40: rebuilds the search index over `INDEXED_KINDS` alone, then vacuums the file (#221). Rebuilt rather than deleted
   * from: the rows to go are two thirds of the index, and FTS5 keeps deleted rows' segments until a merge. The rebuild
   * skips sessions in the trash (#204) and keys each row by its message's rowid, as `appendMessages` does (v11).
   * Nothing is rebuilt when every index row belongs to an indexed message (a new store, or a rerun after the commit).
   * The vacuum, decided by the file's free share, runs after the step commits; a start killed mid-vacuum (SQLite rolls
   * it back whole) leaves it owed for the next open (#396, `vacuumAfterStep`). A failed vacuum (no room for its copy) is
   * reported and passed over: freed pages get reused, and a store that cannot shrink must not keep the host from starting.
   *
   * Measured on a copy of the real store (2026-09-30, 137,722 messages): 55,131 index rows dropped, 26,685 kept; rebuild
   * 1.25s, vacuum 0.52–0.58s (start held about 1.9s, once); file 236.2MiB -> 145.4MiB, index 124.5MiB -> 36.6MiB. The
   * vacuum needs room for its temporary copy and its WAL (146.2MiB peak; free space dipped by at most 306.5MiB).
   */
  private rebuildIndexWithoutToolCalls(): void {
    const kinds = `(${[...INDEXED_KINDS].map((k) => `'${k}'`).join(', ')})`
    // A store without the index at all (only a hand-made one in a test) is built one here rather than left broken
    const present = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`).get()
    const stale = present
      ? oneRow(
          this.db
            .prepare<unknown[], { n: number }>(
              `SELECT COUNT(*) as n FROM messages_fts f
             WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.rowid = f.rowid AND m.kind IN ${kinds})`,
            )
            .get(),
        )
      : { n: 0 }
    const t0 = Date.now()
    let rows = 0
    if (stale.n > 0 || !present) {
      this.db.transaction(() => {
        this.db.exec(`DROP TABLE IF EXISTS messages_fts`)
        this.db.exec(`
          CREATE VIRTUAL TABLE messages_fts USING fts5(
            body, session_id UNINDEXED, seq UNINDEXED, tokenize='trigram'
          );
        `)
        const insert = this.db.prepare(`INSERT INTO messages_fts (rowid, body, session_id, seq) VALUES (?, ?, ?, ?)`)
        const pick = this.db.prepare<unknown[], { rowid: number; session_id: string; seq: number; kind: string; payload: string }>(
          `SELECT rowid, session_id, seq, kind, payload FROM messages
           WHERE kind IN ${kinds} AND session_id NOT IN (SELECT id FROM sessions WHERE deleted_at IS NOT NULL)`,
        )
        // `.all()`, not `.iterate()`: better-sqlite3 refuses another statement while an iterator is open
        for (const r of pick.all()) {
          const body = indexedText(r.kind, r.payload)
          if (!body) continue
          insert.run(r.rowid, body, r.session_id, r.seq)
          rows += 1
        }
      })()
    }
    const t1 = Date.now()
    const pageSize = pragmaNumber(this.db, 'page_size')
    const free = pragmaNumber(this.db, 'freelist_count') * pageSize
    if (free < VACUUM_FREE_BYTES) {
      if (stale.n > 0) console.error(`[store] search index rebuilt without tool calls: dropped ${stale.n} rows, kept ${rows} (${t1 - t0}ms)`)
      return
    }
    this.vacuumAfterStep(({ before, after, ms }) =>
      console.error(
        `[store] search index rebuilt without tool calls: dropped ${stale.n} rows, kept ${rows} (${t1 - t0}ms); ` +
          `vacuumed ${bytesText(before)} -> ${bytesText(after)} (${ms}ms)`,
      ),
    )
  }
}
