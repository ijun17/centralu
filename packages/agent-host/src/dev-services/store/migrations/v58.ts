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
          const cols = new Set((this.db.prepare(`PRAGMA table_info(subagent_messages)`).all() as { name: string }[]).map((c) => c.name))
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
          const cols = new Set((this.db.prepare(`PRAGMA table_info(linked_machines)`).all() as { name: string }[]).map((c) => c.name))
          if (cols.size > 0 && !cols.has('connect')) this.db.exec(`ALTER TABLE linked_machines ADD COLUMN connect TEXT`)
        },
      },
    ]
  }
}
