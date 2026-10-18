import { MigrationRange, type MigrationStep } from './context.js'

/** The words an ask_project task opened with before #617 (`askFrame`), which mark a session another project asked for */
const ASK_PROJECT_MARK = "through Centralu's ask_project"

/** The migration steps from v55, in order. The rule they follow is written above `migrationSteps` in `index.ts` */
export class StepsV55 extends MigrationRange {
  steps(): MigrationStep[] {
    return [
      {
        to: 55,
        breaksOlderReaders: false,
        /**
         * Old cross-project ownership goes (#614, #844). `asked_by_session_id` once named the session in another project
         * that asked for this one (ask_project, #371); it now names only the session that started this one in its own
         * project (start_agent). A row still holding the old meaning is cleared, so the session stands as an ordinary
         * one of its project; who asked stays in the conversation's `from`.
         *
         * The old meaning is told apart as the host start that did this until now told it (`SessionManager`), case by
         * case, for the listed sessions:
         *   - an asker listed with a project: cleared when that project is not the row's;
         *   - an asker in the trash: the same, with the project its trash record keeps (a trashed row's `project_id` is
         *     null), a record with none counting as no project;
         *   - otherwise (purged, or listed with no project, as the orchestrator is): cleared when the row's first message
         *     is the task that asker sent, framed as ask_project framed it.
         *
         * This ran at every host start until now (`SessionManager`), outside the step list. Builds up to beta.20 still
         * write the old meaning; a row one of them writes after this step has run keeps its "asked by" mark, which is
         * how that build showed it anyway.
         *
         * **Expand only (#292's rule).** A nullable column set to null, which every build reads as "nobody asked".
         */
        run: () => {
          const cols = new Set((this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name))
          if (!['asked_by_session_id', 'deleted_at', 'trash'].every((c) => cols.has(c))) return
          this.db
            .prepare(
              `UPDATE sessions AS s SET asked_by_session_id = NULL
                WHERE s.deleted_at IS NULL AND s.asked_by_session_id IS NOT NULL
                  AND CASE
                    WHEN EXISTS (SELECT 1 FROM sessions o WHERE o.id = s.asked_by_session_id AND o.deleted_at IS NULL AND o.project_id IS NOT NULL)
                      THEN (SELECT o.project_id FROM sessions o WHERE o.id = s.asked_by_session_id) IS NOT s.project_id
                    WHEN EXISTS (SELECT 1 FROM sessions o WHERE o.id = s.asked_by_session_id AND o.deleted_at IS NOT NULL)
                      THEN (SELECT CASE WHEN json_valid(o.trash) THEN json_extract(o.trash, '$.projectId') END FROM sessions o WHERE o.id = s.asked_by_session_id) IS NOT s.project_id
                    ELSE coalesce((
                      SELECT CASE WHEN json_valid(m.payload) THEN
                               json_extract(m.payload, '$.from.sessionId') = s.asked_by_session_id
                               AND instr(json_extract(m.payload, '$.text'), @mark) > 0
                             END
                        FROM messages m WHERE m.session_id = s.id AND m.seq > 0 ORDER BY m.seq ASC LIMIT 1
                    ), 0)
                  END`,
            )
            .run({ mark: ASK_PROJECT_MARK })
        },
      },
      {
        to: 56,
        // Drops `usage_facts`: an older schema.sql recreates it empty, and builds up to beta.10 still ran DELETE FROM it
        breaksOlderReaders: true,
        /**
         * The unused usage aggregate goes (#423). It was planned for the first milestone and never built: no build ever
         * wrote a row. Deleting a project was the last statement that named it, and #420 removed that; the table has
         * been left alone by every release since, which is the "one release later" that §5.1 rule 2 asks for.
         *
         * `schema.sql` no longer creates it either, so a new store and a migrated one end with the same tables. Nothing
         * is lost: there is no row to keep. `IF EXISTS` because a fresh store never had the table.
         */
        run: () => {
          this.db.exec(`DROP TABLE IF EXISTS usage_facts`)
        },
      },
    ]
  }
}
