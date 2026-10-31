import { MigrationRange, type MigrationStep } from './context.js'

/** The store version every new store starts from, and the oldest store this host opens (#1143) */
export const BASELINE_VERSION = 27

/**
 * What steps v2 to v27 made of a new store, in their order, so its tables come out as they did (#1143). Those steps
 * are gone: every store in use is past them, and a store between v1 and v26 is refused (`StoreTooOldError`).
 * Columns are added in the order the steps added them, so `sqlite_master` holds the same SQL as before
 * (`store-new.golden.json`).
 */
export class BaselineV27 extends MigrationRange {
  steps(): MigrationStep[] {
    return [
      {
        to: BASELINE_VERSION,
        breaksOlderReaders: false,
        run: () => {
          const add = (table: string, ...columns: string[]) => {
            for (const c of columns) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${c}`)
          }
          add('sessions', `touched_paths TEXT NOT NULL DEFAULT '[]'`, 'model TEXT', `permission_preset TEXT NOT NULL DEFAULT 'normal'`)
          add('sessions', 'imported_from TEXT')
          this.db.exec(`CREATE TABLE command_cache (
              tool TEXT NOT NULL,
              cwd TEXT NOT NULL,
              commands TEXT NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (tool, cwd)
            )`)
          add('sessions', 'effort TEXT', 'sidebar_order INTEGER NOT NULL DEFAULT 0')
          this.db.exec(`CREATE TABLE grid_panels (
              session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
              position   INTEGER NOT NULL
            )`)
          add('sessions', 'worktree_path TEXT', 'worktree_branch TEXT', 'cwd TEXT')
          add('projects', `commands TEXT NOT NULL DEFAULT '[]'`)
          add('sessions', 'context_used INTEGER', 'context_window INTEGER', 'context_exactness TEXT', 'verbosity TEXT', 'service_tier TEXT')
          this.db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(
          body, session_id UNINDEXED, seq UNINDEXED, tokenize='trigram'
        )`)
          add('sessions', 'parent_session_id TEXT')
          add('projects', 'worktree_setup TEXT')
          add('sessions', 'worktree_base TEXT')
          add('projects', 'default_effort TEXT', 'worktree_manager TEXT')
        },
      },
    ]
  }
}
