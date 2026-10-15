import { indexedText } from '../search-index.js'
import { MigrationRange, type MigrationStep } from './context.js'

/** The migration steps v2 to v12, in order. The rule they follow is written above `migrationSteps` in `index.ts` */
export class StepsV2ToV12 extends MigrationRange {
  steps(): MigrationStep[] {
    return [
      {
        to: 2,
        breaksOlderReaders: false,
        run: () => {
          // B-7: remember the files an agent touched, across restarts
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'touched_paths')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN touched_paths TEXT NOT NULL DEFAULT '[]'`)
          }
        },
      },
      {
        to: 3,
        // Reads every message to backfill the new index
        breaksOlderReaders: false,
        heavy: true,
        run: () => {
          // E-1: full-text search over conversations. Korean words carry particles, so trigram
          //   tokenizing is used (unicode61 cannot find '승인을' when searching for '승인')
          this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
              body, session_id UNINDEXED, seq UNINDEXED, tokenize='trigram'
            );
          `)
          // Backfill existing messages — without this, old conversations are never searchable
          const rows = this.db.prepare(`SELECT session_id, seq, kind, payload FROM messages`).all() as {
            session_id: string
            seq: number
            kind: string
            payload: string
          }[]
          const insert = this.db.prepare(`INSERT INTO messages_fts (body, session_id, seq) VALUES (?, ?, ?)`)
          const tx = this.db.transaction(() => {
            for (const r of rows) {
              const body = indexedText(r.kind, r.payload)
              if (body) insert.run(body, r.session_id, r.seq)
            }
          })
          tx()
        },
      },
      {
        to: 4,
        breaksOlderReaders: false,
        run: () => {
          // FR-7: remember the model and permission per session (both can change mid-conversation)
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'model')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`)
          }
          if (!cols.some((c) => c.name === 'permission_preset')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN permission_preset TEXT NOT NULL DEFAULT 'normal'`)
          }
        },
      },
      {
        to: 5,
        breaksOlderReaders: false,
        run: () => {
          // Which earlier conversation this one continues. external_id cannot tell us — a
          // tool can **issue a new identifier** on resume, so it differs from the original.
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'imported_from')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN imported_from TEXT`)
          }
        },
      },
      {
        to: 6,
        breaksOlderReaders: false,
        run: () => {
          /*
           * The slash command (skill) cache.
           *
           * A skill is a property of **the tool plus the directory**, not of the session, so
           * it must not disappear with the session. Keeping it in memory only means the first
           * session after the host restarts (a sleeping session) never gets one: a sleeping
           * session has no process to ask, and the cache is also empty (caught by
           * dogfooding). So it is kept on disk.
           */
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS command_cache (
              tool TEXT NOT NULL,
              cwd TEXT NOT NULL,
              commands TEXT NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (tool, cwd)
            )
          `)
        },
      },
      {
        to: 7,
        breaksOlderReaders: false,
        run: () => {
          // Remember the reasoning effort per session too — the same kind of property as the
          // model, so it lives in the same place
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'effort')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN effort TEXT`)
          }
        },
      },
      {
        to: 8,
        breaksOlderReaders: false,
        run: () => {
          // Let the person set the sidebar order (projects already had this column)
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'sidebar_order')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN sidebar_order INTEGER NOT NULL DEFAULT 0`)
          }
        },
      },
      {
        to: 9,
        breaksOlderReaders: false,
        run: () => {
          /*
           * Sessions placed on the grid.
           *
           * Kept **separate** from the sessions table rather than as a column: being on the
           * grid and the session existing are different facts, and removing it from the grid
           * leaves the session in place. As a column, "not on the grid" would stay ambiguous
           * between 0 and NULL forever.
           */
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS grid_panels (
              session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
              position   INTEGER NOT NULL
            )
          `)
        },
      },
      {
        to: 10,
        // Same columns, one NOT NULL relaxed: an older build reads and writes it as before. The table is tens of rows
        breaksOlderReaders: false,
        ownTransaction: true,
        run: () => {
          /*
           * The orchestrator **does not belong to a project.**
           *
           * It is the single, project-crossing session in the app, so if project_id were
           * NOT NULL it would have to hang off some project, and deleting that project would
           * take it down with it via CASCADE. Both are wrong.
           *
           * SQLite cannot drop a column's NOT NULL — the table is rebuilt following the
           * standard procedure. This is the riskiest change in this project, so the number of
           * rows moved is **counted and checked**. Silently losing even one row would be
           * unrecoverable.
           */
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as {
            name: string
            notnull: number
          }[]
          const pid = cols.find((c) => c.name === 'project_id')
          if (!pid || pid.notnull === 0) return // already nullable

          const before = (this.db.prepare(`SELECT COUNT(*) as n FROM sessions`).get() as { n: number }).n
          const names = cols.map((c) => c.name).join(', ')

          /*
           * **This runs as one unit.**
           *
           * If anything goes wrong between the DROP and the RENAME, the database is left with
           * no sessions table at all. There is no way back from that state.
           *
           * The foreign_keys pragma **is ignored inside a transaction** (SQLite rule), so the
           * order here is: turn it off, run the transaction, turn it back on.
           */
          this.db.pragma('foreign_keys = OFF')
          try {
            this.db.transaction(() => this.rebuildSessionsTable(names, before))()
          } finally {
            this.db.pragma('foreign_keys = ON')
          }
        },
      },
      {
        to: 11,
        // Rebuilds the whole index and vacuums. Same shape: an older build's plain INSERTs only bring the duplicates back
        breaksOlderReaders: false,
        heavy: true,
        run: () => {
          /*
           * Pin the index back to its message.
           *
           * The index has been a plain INSERT so far, so rewriting the same message added
           * another row every time. In the real database that came to 28,892 messages against
           * 249,809 index rows — **8.6x**. That made recall return the same line over and
           * over (limit became meaningless), and the index had bloated to tens of times the
           * size of the actual text.
           *
           * Existing rows cannot be picked out because their rowid has no relation to the
           * message — the whole index is rebuilt from scratch. This runs as one unit: if it is
           * interrupted partway, search is left entirely empty.
           */
          const tx = this.db.transaction(() => {
            this.db.exec(`DROP TABLE IF EXISTS messages_fts`)
            this.db.exec(`
              CREATE VIRTUAL TABLE messages_fts USING fts5(
                body, session_id UNINDEXED, seq UNINDEXED, tokenize='trigram'
              );
            `)
            const rows = this.db.prepare(`SELECT rowid, session_id, seq, kind, payload FROM messages`).all() as {
              rowid: number
              session_id: string
              seq: number
              kind: string
              payload: string
            }[]
            const insert = this.db.prepare(
              `INSERT INTO messages_fts (rowid, body, session_id, seq) VALUES (?, ?, ?, ?)`,
            )
            for (const r of rows) {
              const body = indexedText(r.kind, r.payload)
              if (body) insert.run(r.rowid, body, r.session_id, r.seq)
            }
          })
          tx()
          /*
           * SQLite does not hand back freed space on its own. The room the duplicate rows took
           * up is still sitting in the file, so it is reclaimed once here — measured on the
           * real database, 165MB to 21MB. (VACUUM does not run inside a transaction, so it waits
           * for the step's commit, recorded as owed until it has run.)
           */
          this.vacuumAfterStep()
        },
      },
      {
        to: 12,
        breaksOlderReaders: false,
        run: () => {
          /*
           * Worktree sessions (FR-2, optional).
           *
           * Why the path is written to the database: resuming has to **return to the same
           * worktree.** Falling back to the project's path would silently drop the isolation
           * while the user still believes it is isolated.
           */
          const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
          if (!cols.some((c) => c.name === 'worktree_path')) {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree_path TEXT`)
            this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree_branch TEXT`)
          }
        },
      },
    ]
  }

  /** v10: drops the NOT NULL on project_id. SQLite cannot alter a column, so the table is rebuilt */
  private rebuildSessionsTable(names: string, before: number): void {
    this.db.exec(`
      CREATE TABLE sessions_new (
              id            TEXT PRIMARY KEY,
              project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
              tool          TEXT NOT NULL,
              external_id   TEXT,
              name          TEXT NOT NULL,
              auto_named    INTEGER NOT NULL DEFAULT 1,
              state         TEXT NOT NULL DEFAULT 'idle',
              archived      INTEGER NOT NULL DEFAULT 0,
              is_orchestrator INTEGER NOT NULL DEFAULT 0,
              last_read_seq INTEGER NOT NULL DEFAULT 0,
              waiting_since INTEGER,
              created_at    INTEGER NOT NULL,
              touched_paths TEXT NOT NULL DEFAULT '[]',
              model         TEXT,
              effort        TEXT,
              verbosity     TEXT,
              permission_preset TEXT NOT NULL DEFAULT 'normal',
              imported_from TEXT,
              worktree_path TEXT,
              worktree_branch TEXT,
              sidebar_order INTEGER NOT NULL DEFAULT 0
            )
          `)
    this.db.exec(`INSERT INTO sessions_new (${names}) SELECT ${names} FROM sessions`)
    this.db.exec(`DROP TABLE sessions`)
    this.db.exec(`ALTER TABLE sessions_new RENAME TO sessions`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, archived)`)

    // Silently losing even one row is unrecoverable — throwing here rolls back the whole transaction
    const after = (this.db.prepare(`SELECT COUNT(*) as n FROM sessions`).get() as { n: number }).n
    if (after !== before) throw new Error(`Lost rows while migrating sessions: ${before} → ${after}`)
  }
}
