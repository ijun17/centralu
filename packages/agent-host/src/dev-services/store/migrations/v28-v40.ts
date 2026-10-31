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
           * Retiring the archive (2026-09-02 dogfooding).
           *
           * `d` in the inbox was the only entry point, and it read "Dismiss" on screen, but
           * there was **no way back at all** — neither the palette nor the sidebar did more
           * than filter on `!archived`. So a key pressed to mean "I am not answering this"
           * erased a session from view forever. FR-20 had designed a way out too (a per-project
           * Archive list, the palette, resuming in place), but only half of that had shipped.
           *
           * Every session that was hidden **becomes visible again** — once the column is gone
           * there is nothing left to filter on. That is the point of this migration: no
           * session in the app is invisible.
           *
           * Why the index is dropped first: SQLite cannot DROP a column an index refers to.
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
           * Restoring the timestamps the v21 merge trampled (real incident, 2026-09-03).
           *
           * The merge step stamped `Date.now()` onto an assistant row's ts instead of keeping
           * the original — even on rows that had nothing to merge. When beta.4 rewound
           * user_version and that step replayed, the timestamps of an entire night's worth of
           * conversation were overwritten with the time the step happened to run (13:44). The
           * original timestamps are gone, so they cannot be recovered — instead the fix
           * **narrows them using what the neighbors still know**: seq is trustworthy, so if a
           * row's ts is greater than the ts of a later row (larger seq), that row's timestamp
           * is known to be false. Walking back to front and clamping to the running minimum
           * gives every trampled row an upper bound — "no later than the next genuine row's
           * time" — not exact, but close enough to not disturb the ordering.
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
         * The app that owns a session (#81, user request 2026-09-09). A running app shows its
         * own sessions, and the sidebar carries only projects — this one column is what that
         * decision is made from. Old rows are null, which reads as "no owner" and falls back
         * to the sidebar (so no session becomes unreachable).
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
         * The default model and effort get a tool of their own (#107).
         *
         * `default_model` and `default_effort` were one value per project, sitting next to
         * `default_tool` — but a model name is a tool's own vocabulary, so a model default with
         * no tool attached cannot say which tool it is for. Real incident: a project with
         * `default_tool=codex` was holding `default_model=opus[1m]`, and every codex session
         * born from it died on its first turn with `400 invalid_request_error`. Nothing showed
         * on screen.
         *
         * **The old value is dropped, not migrated.** Attaching it to the current
         * `default_tool` looks like the most plausible guess, but that exact guess is what
         * caused this bug — the scalar never recorded which tool it was chosen for. The cost of
         * a lost default is one click in the next session; the cost of a wrong one is a dead
         * session.
         *
         * Why the columns are dropped outright: this is not conversation history, only **the
         * last choice made**, so there is nothing worth keeping, and keeping it would leave two
         * more columns for the next person to wonder "does anything still read this" (following
         * v28's precedent).
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
         * Project trust (M4 A-2, plan decision 3) — "is it fine to run this repository's code on
         * this machine".
         *
         * Project apps are committed to the repository and shared with the team. If simply
         * opening a repository someone handed you lets the `server.command` inside it run with
         * your own permissions, opening the repository has become the same act as running
         * someone else's code. So an app only launches in a trusted project (discovery and
         * listing do not care about trust).
         *
         * **An existing project's default is "not trusted."** Every project registered so far
         * was registered before apps existed — that registration never answered this question.
         * Filling in the missing answer with "yes" would be a silent grant of permission. The
         * cost of "no" is one click the first time the app is launched.
         *
         * One column settles both apps and #92 (respecting project settings) at once — decision
         * 3 tied the two together as a single question.
         *
         * (This call for existing rows is reversed by v35. New projects still default to "no.")
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
         * A run log for external apps (M4 A-6) — the local half of "record who ran what".
         *
         * A call made by an agent is left in that session's conversation, but a call made from
         * the UI, or app-to-app, landed nowhere at all (the plan's "what is blocking this now").
         * The one place every call passes through (the broker) writes one row here per call.
         *
         * Three columns were added beyond the plan's:
         *   project_id    an app id is unique only within its scope (project, or the user's own
         *                 folder) — two projects can each have a `notes` app that are different
         *                 apps. null means a user-folder app
         *   args_summary  arguments are kept only as a summary and a hash — a hash alone gives a
         *                 person nothing to read
         *   error         the reason for a rejection or failure. This is where the history
         *                 screen (B-7) shows "why"
         *
         * The raw arguments are not kept here. A side table keeps the raw text (secrets
         * redacted) for **only the most recent handful of failures** — an agent debugging an app
         * needs to see the input that failed, but there is no reason to pile up the raw text of
         * every call.
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
         * Projects already registered are trusted (M4, reversing v33's default, but only for
         * existing rows).
         *
         * v33 left old rows untrusted, reasoning that "registration never answered this
         * question." What that missed is that the question **had just come into existence**.
         * These rows are folders a person chose by hand, and they have been running agents in
         * them for weeks. Trust decides not just apps but also #92 (respecting project
         * settings) (decision 3). So leaving old rows at "no" means a single update starts
         * silently ignoring these projects' `.claude/` settings — the person only sees the
         * result of a choice they never made.
         *
         * Projects registered from here on still start at "no" and are asked once, at
         * registration time (UI). v33's reasoning — that a freshly handed-over repository's code
         * must not run just from opening it — still holds.
         *
         * **This runs only once.** If this step ran every time, the next startup would silently
         * re-enable trust a person had turned off. The runner does not replay a step that has
         * already run (user_version), and on a new database this step runs against zero
         * projects, so it does nothing.
         */
        run: () => {
          this.db.exec(`UPDATE projects SET trusted = 1`)
        },
      },
      {
        to: 36,
        breaksOlderReaders: false,
        /**
         * The person's answer to an app's capability request (M4 D-4) — the memory of "ask once
         * on first use."
         *
         * An app is unique per (project, id), so `app_key` (`<project id | _user>/<app id>`) is
         * used as the key. project_id is kept out of the key because a user-folder app's
         * project_id is null, and SQLite's PRIMARY KEY treats NULLs as distinct from one
         * another, which would let the same app's same capability end up as two rows.
         * project_id is kept as its own column so it can be cleaned up together when a project
         * is deleted.
         *
         * `uses_stamp` is a fingerprint of the manifest's declared `uses` at the moment the
         * answer was given — if the fingerprint changes, the stored answer is no longer used and
         * the question is asked again. `text` is what was shown to the person when asked. The
         * list of remembered answers (the history screen) shows that same text back.
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
         * The run log becomes a chain (M4 D-6) — what an app asked the broker for over fd 3 also
         * gets a row, nested under the run that caused it.
         *
         *   kind        `tool` is a call to the app's tool, `broker` is a request the app made to
         *               the broker. Every old row was a tool call
         *   session_id  the agent session run_agent set up — where the history screen jumps into
         *               that session
         *
         * An index is added on the parent column (`parent_run_id`): the history screen reads
         * **downward**, walking the chain from one app's row (a recursive query). Without the
         * index, every step scans the whole table.
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
         *   deleted_at  when the person moved it to the trash; NULL is a live session. Every query that lists
         *               sessions filters on this one column, so "is it in the trash" is answered in one place
         *   trash       JSON (`TrashRecord`): where it came from (project id, name and path) and what the person
         *               chose to remove with it when it is deleted for good (the tool's conversation file, the
         *               worktree). NULL on a live session
         *
         * A column rather than a side table: a side table makes every listing query a `NOT EXISTS` join, and the
         * easiest query to write would be the one that forgets it. A column that says NULL for every row written
         * before this step means nothing old is in the trash, which is true.
         *
         * No backfill and no index: the step only adds two empty columns, and the sessions table holds tens of rows.
         * Rows that later steps add for a session (see `purgeSession`) have to consider that the session may be in
         * the trash — its rows still exist and still point at it.
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
   * v40: rebuilds the search index over `INDEXED_KINDS` alone, then vacuums the file (#221).
   *
   * Rebuilt rather than deleted from: the rows to go are two thirds of the index, and deleting from FTS5 leaves the
   * old segments in place until they are merged. Rebuilding writes only what stays — the text and reasoning rows —
   * and leaves out the sessions in the trash, whose index rows are dropped while they are there (#204). Each row is
   * keyed by its message's rowid, as `appendMessages` writes it (v11).
   *
   * Nothing to rebuild when every index row already belongs to an indexed message: a new store, or a rerun after the
   * rebuild committed. The vacuum is decided separately, by how much of the file is free. It runs after the step has
   * committed, so v40 does not run again for it: a start that was killed during the vacuum (which SQLite rolls back
   * whole) leaves it recorded as owed, and the next open vacuums (#396, `vacuumAfterStep`).
   *
   * A vacuum that fails — no room for its temporary copy, say — is reported and passed over: the index is already
   * rebuilt, the freed pages stay in the file and later writes reuse them, and a store that cannot shrink must not
   * keep the host from starting.
   *
   * Measured on a copy of the real store (2026-09-30, 137,722 messages): 55,131 index rows dropped and 26,685 kept;
   * the rebuild took 1.25s and the vacuum 0.52–0.58s, so the start is held for about 1.9s, once. The file went from
   * 236.2MiB to 145.4MiB, the index from 124.5MiB to 36.6MiB. The vacuum needs room for what it keeps twice over — its
   * temporary copy and the WAL it writes the result through (146.2MiB at its peak; the volume's free space dipped by at
   * most 306.5MiB) — which is the reason a failure is survivable rather than fatal.
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
