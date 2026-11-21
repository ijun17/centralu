import { MigrationRange, type MigrationStep } from './context.js'

/** The migration steps v41 to v47, in order. The rule they follow is written above `migrationSteps` in `index.ts` */
export class StepsV41ToV47 extends MigrationRange {
  steps(): MigrationStep[] {
    return [
      {
        to: 41,
        breaksOlderReaders: false,
        /**
         * What a native subagent did, kept under the card that launched it (#222).
         *
         *   parent_call_id  the parent's launch call: Claude's `Agent` tool_use id, Codex's `spawnAgent` item id
         *   seq             the step's number within that launch — not the conversation's seq
         *   role, kind, payload, ts   as in `messages`; payload is the step as the adapter sent it, tool `input` and
         *                   `output` included (#221)
         *
         * A table, not a column on `messages`: every reader of `messages` (history, unread, handoff, `read_session`,
         * `recall`, sync, ...) would have to filter it, and one that forgot would put a subagent's tool output in another
         * session's prompt (#73) or count it as unread. Only `loadSubagentMessages` reads it, and a running subagent never
         * moves `lastSeq`. Not search-indexed: the parent's report is. The rows follow the session through the trash (FK,
         * `purgeSession` deletes them in chunks); old subagent runs are not back-filled.
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS subagent_messages (
              session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
              parent_call_id TEXT NOT NULL,
              seq            INTEGER NOT NULL,
              role           TEXT NOT NULL,
              kind           TEXT NOT NULL,
              payload        TEXT NOT NULL,
              ts             INTEGER NOT NULL,
              PRIMARY KEY (session_id, parent_call_id, seq)
            );
          `)
        },
      },
      {
        to: 42,
        breaksOlderReaders: false,
        /**
         * The grid holds apps as well as sessions (#288), in `grid_layout`.
         *
         *   panel_key   `session:<id>` or `app:<project id | _user>/<app id>`, the primary key so a panel is placed once.
         *               Not (kind, session_id, project_id, app_id): SQLite's PRIMARY KEY treats NULLs as distinct (v36)
         *   session_id  a session panel's session, NULL for an app; CASCADE, so a session deleted for good takes its panel
         *   project_id  an app's project, NULL for a user-folder app (and for a session)
         *
         * Expand only (#292): `grid_panels` stays as v9 made it for a v41 host, whose insert names neither NOT NULL
         * `panel_key` nor `kind`. Its rows whose session still exists (an orphan would fail the key; listGridView joins
         * `sessions`) are copied once, when this table is created; after that the builds' grids may differ, a layout,
         * not a record. Dropping `grid_panels` is a later, breaking step.
         */
        run: () => {
          const has = (name: string) =>
            this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name) !== undefined
          if (has('grid_layout')) return
          this.db.transaction(() => {
            this.db.exec(`
              CREATE TABLE grid_layout (
                panel_key  TEXT PRIMARY KEY,
                kind       TEXT NOT NULL CHECK (kind IN ('session', 'app')),
                session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                project_id TEXT,
                app_id     TEXT,
                position   INTEGER NOT NULL
              )
            `)
            if (!has('grid_panels')) return
            this.db.exec(`
              INSERT OR IGNORE INTO grid_layout (panel_key, kind, session_id, position)
              SELECT 'session:' || session_id, 'session', session_id, position
                FROM grid_panels WHERE session_id IN (SELECT id FROM sessions)
            `)
          })()
        },
      },
      {
        to: 43,
        breaksOlderReaders: false,
        /**
         * An app panel's span on the grid, in cells (#306): `span_cols` × `span_rows`, both NULL when the person has not
         * chosen one for this placement — the panel then takes their setting for the app, else the app's recommendation,
         * else 1 × 1 (the UI decides; the host only keeps the choice).
         *
         * On the placement's row rather than per app, because the top bar's choice is about this panel: removing the
         * panel forgets it, and placing the app again starts from the defaults. The per-app default is the person's
         * setting, kept with the rest of the UI's way of looking (the workspace snapshot), and the app's own
         * recommendation comes from its manifest.
         *
         * **Expand only (#292's rule).** Two nullable columns. A v42 host reads the table as it did; its `setGridView`
         * rewrites the rows without naming them, so the spans it writes are NULL — a layout falling back to the
         * defaults, not a broken one.
         */
        run: () => {
          const cols = new Set(
            this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(grid_layout)`).all().map((c) => c.name),
          )
          if (!cols.has('span_cols')) this.db.exec(`ALTER TABLE grid_layout ADD COLUMN span_cols INTEGER`)
          if (!cols.has('span_rows')) this.db.exec(`ALTER TABLE grid_layout ADD COLUMN span_rows INTEGER`)
        },
      },
      {
        to: 44,
        breaksOlderReaders: false,
        /**
         * The person's consent for one project to reach another (#371): one row per (from, to, kind) allowed "always".
         *
         *   from_project_id  the project whose session asks
         *   to_project_id    the project it reaches
         *   kind             'delegate' (ask_project starts a session in the target, part B) or 'apps' (the target's apps
         *                    attach to the caller's session, part A); one table, so Settings lists and revokes them in one place
         *
         * Only "always" is stored: "once" lives for that call, and a denial is not remembered (the next call asks again).
         * Both ids CASCADE (better-sqlite3 turns the foreign-key pragma on for every connection), so a deleted project
         * takes its consents either way round and a folder registered again is asked again. Expand only (#292).
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS project_consents (
              from_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              to_project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              kind            TEXT NOT NULL,
              decided_at      INTEGER NOT NULL,
              PRIMARY KEY (from_project_id, to_project_id, kind)
            )
          `)
        },
      },
      {
        to: 45,
        breaksOlderReaders: false,
        /**
         * The session that asked for this one (#371 part B) — `sessions.asked_by_session_id`, set when another
         * project's session started it through ask_project. On the row, like `parent_session_id`, because the mark
         * must outlive the process: the person reads "asked by" on the session and follows the link back after a
         * restart, and the next ask from the same caller reuses the session it already asked.
         *
         * Not a foreign key: the caller can go to the trash or be deleted for good while the delegated session stays,
         * and the mark then names a session no longer here (the screen says so) rather than vanishing.
         *
         * **Expand only (#292's rule).** A nullable column; an older host's upsert does not name it and leaves it as
         * it was.
         */
        run: () => {
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(sessions)`).all()
          if (!cols.some((c) => c.name === 'asked_by_session_id')) this.db.exec(`ALTER TABLE sessions ADD COLUMN asked_by_session_id TEXT`)
        },
      },
      {
        to: 46,
        breaksOlderReaders: false,
        /**
         * Linked machines (#82, docs/plans/remote-hub.md): the hub's links, what it last heard from each, and grid panels
         * of another machine's session. A link's token is not kept: it is asked from the remote over ssh at every start.
         *
         *   linked_machines   per linked machine: its id (the `<machine>.` of every id it hands over), name, ssh target and
         *                     shell, `slot` for folding numeric ids (links/machine-ids.ts), the version pair accepted anyway
         *   machine_headers   each machine's sessions and projects as last listed, JSON in the remote's terms, never a
         *                     conversation: it answers `sessions.list`/`projects.list` for an unreachable machine (§5)
         *   grid_layout.remote_session_id  a remote session's panel (`session_id` references only this host's sessions);
         *                     it lives as long as the mirror knows the session
         *
         * Expand only (#292): an older host never reads the tables, its join leaves a remote panel out, and its
         * `setGridView` drops those rows, losing a panel, not the layout.
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS linked_machines (
              id                TEXT PRIMARY KEY,
              name              TEXT NOT NULL,
              ssh_target        TEXT NOT NULL,
              shell             TEXT NOT NULL DEFAULT 'posix',
              wsl_distro        TEXT,
              command           TEXT,
              slot              INTEGER NOT NULL UNIQUE,
              added_at          INTEGER NOT NULL,
              accepted_versions TEXT
            );
            CREATE TABLE IF NOT EXISTS machine_headers (
              machine_id TEXT NOT NULL REFERENCES linked_machines(id) ON DELETE CASCADE,
              kind       TEXT NOT NULL CHECK (kind IN ('session', 'project')),
              item_id    TEXT NOT NULL,
              info       TEXT NOT NULL,
              position   INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (machine_id, kind, item_id)
            );
          `)
          const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(grid_layout)`).all()
          if (cols.length > 0 && !cols.some((c) => c.name === 'remote_session_id')) {
            this.db.exec(`ALTER TABLE grid_layout ADD COLUMN remote_session_id TEXT`)
          }
        },
      },
      {
        to: 47,
        breaksOlderReaders: false,
        /**
         * Grid panels of another machine's apps (#82, docs/plans/remote-hub.md §11.8).
         *
         *   grid_layout.remote_app_id   the app of such a panel, with `app_id` left NULL
         *   grid_layout.app_machine     the machine it is on; `project_id` is its qualified project, or NULL for that
         *                               machine's user-folder app
         *
         * **Expand only (#292's rule).** Two nullable columns. An older host reads app rows only where `app_id` is set,
         * so it never mistakes a machine's `notes` for its own; its `setGridView` drops those rows when it rewrites the
         * layout, which loses a panel, not the layout.
         */
        run: () => {
          const cols = new Set(this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(grid_layout)`).all().map((c) => c.name))
          if (cols.size === 0) return
          if (!cols.has('remote_app_id')) this.db.exec(`ALTER TABLE grid_layout ADD COLUMN remote_app_id TEXT`)
          if (!cols.has('app_machine')) this.db.exec(`ALTER TABLE grid_layout ADD COLUMN app_machine TEXT`)
        },
      },
    ]
  }
}
