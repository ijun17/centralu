import type Database from 'better-sqlite3'
import type { VacuumDone } from '../vacuum.js'

// The host's own settings table (v16), named here for the steps as it always was
export { APP_SETTINGS_DDL } from '../store-keys.js'

/** One step of the migration list. The rule the two flags serve is written above the list in `migrationSteps` */
export interface MigrationStep {
  to: number
  /** A host that knows only versions below `to` cannot run against the store, or silently loses data, once this has run */
  breaksOlderReaders: boolean
  /**
   * The store version a breaking step raises `min_reader_version` to, when that is below its own `to`: the step keeps out
   * the builds below this version and admits the ones from it on. A step whose earlier steps already taught the builds
   * from that version on everything it relies on names it (#2133 step 4: v69 keeps out only the builds that write the
   * Assistant's settings under the old key alone). Absent, a breaking step's floor is its own `to`
   */
  minReader?: number
  /** Rewrites or re-indexes every message, or `VACUUM`s the file: too long to run while another host waits (#280) */
  heavy?: true
  /**
   * The step commits on its own instead of inside the runner's transaction: it switches `foreign_keys`, which SQLite
   * ignores inside a transaction. Such a step must be one unit by itself, and safe to run again.
   */
  ownTransaction?: true
  run: () => void
}

/** What the steps need from the store that runs them: its connection and the vacuum a step leaves for after it */
export interface MigrationHost {
  /** The connection, read when a step runs: a probe store gets its connection after its list is made */
  getDb(): Database.Database
  vacuumAfterStep(report?: (done: VacuumDone) => void): void
}

/** What every file of steps stands on: `this.db`, the store's own `vacuumAfterStep`, and `addColumn` */
export abstract class MigrationRange {
  constructor(private readonly host: MigrationHost) {}

  protected get db(): Database.Database {
    return this.host.getDb()
  }

  protected vacuumAfterStep(report?: (done: VacuumDone) => void): void {
    this.host.vacuumAfterStep(report)
  }

  /** Adds a column the table lacks. A table that does not exist (a test's partial schema) is left alone */
  protected addColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare<unknown[], { name: string }>(`PRAGMA table_info(${table})`).all()
    if (cols.length > 0 && !cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }

  abstract steps(): MigrationStep[]
}
