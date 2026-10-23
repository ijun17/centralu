import { MigrationRange, type MigrationStep } from './context.js'

/** The migration step v62. The rule it follows is written above `migrationSteps` in `index.ts` */
export class StepsV62 extends MigrationRange {
  steps(): MigrationStep[] {
    return [
      {
        to: 62,
        breaksOlderReaders: false,
        /**
         * Usage over time (docs/agent-host.md §6.2): the limit windows' readings and the tokens per hour.
         *
         * `usage_readings`: one row per change of a window's percent or reset time, per tool, account and window
         * (`window_id`, with the `scope` of a per-model window and its `label` as the tool names them)
         * (`at`, `resets_at` in ms; `resets_at` null when unknown). `account` is the login's fingerprint
         * (`agents.account`), empty when the tool did not say.
         *
         * `usage_buckets`: the requests the cache ledger counts, summed per hour (`hour`, the start of the hour
         * in ms) and per session, project, tool, model and machine. `project_id`, `model` and `machine` are ''
         * when there is none (the orchestrator has no project; the host's own requests have no machine). The
         * `cache_write_5m` and `cache_write_1h` columns are the part of `cache_write` the API said how long it
         * stays cached. `causes` is the JSON of the rebuilds by cause. A flush adds to a row (one upsert per
         * bucket), so a restart or a swap midway through an hour only adds.
         *
         * **Expand only (#292's rule).** Two new tables; an older host neither reads nor writes them, and
         * purging a session deletes its `usage_buckets` rows in the new build only (an older host leaves them,
         * which is harmless: they hold counts, no content).
         */
        run: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS usage_readings (
              tool       TEXT NOT NULL,
              account    TEXT NOT NULL,
              window_id  TEXT NOT NULL,
              scope      TEXT NOT NULL DEFAULT '',
              label      TEXT NOT NULL DEFAULT '',
              at         INTEGER NOT NULL,
              percent    REAL NOT NULL,
              resets_at  INTEGER,
              PRIMARY KEY (tool, account, window_id, scope, at)
            );
            CREATE INDEX IF NOT EXISTS idx_usage_readings_at ON usage_readings(at);
            CREATE TABLE IF NOT EXISTS usage_buckets (
              hour           INTEGER NOT NULL,
              session_id     TEXT NOT NULL,
              project_id     TEXT NOT NULL DEFAULT '',
              tool           TEXT NOT NULL,
              model          TEXT NOT NULL DEFAULT '',
              machine        TEXT NOT NULL DEFAULT '',
              requests       INTEGER NOT NULL DEFAULT 0,
              input          INTEGER NOT NULL DEFAULT 0,
              cache_read     INTEGER NOT NULL DEFAULT 0,
              cache_write    INTEGER NOT NULL DEFAULT 0,
              cache_write_5m INTEGER NOT NULL DEFAULT 0,
              cache_write_1h INTEGER NOT NULL DEFAULT 0,
              output         INTEGER NOT NULL DEFAULT 0,
              rebuilds       INTEGER NOT NULL DEFAULT 0,
              causes         TEXT NOT NULL DEFAULT '{}',
              PRIMARY KEY (hour, session_id, project_id, tool, model, machine)
            );
            CREATE INDEX IF NOT EXISTS idx_usage_buckets_session ON usage_buckets(session_id);
          `)
        },
      },
    ]
  }
}
