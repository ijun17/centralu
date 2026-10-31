import type Database from 'better-sqlite3'
import type { VacuumDone } from '../vacuum.js'

/** One step of the migration list. The rule the two flags serve is written above the list in `migrationSteps` */
export interface MigrationStep {
  to: number
  /** A host that knows only versions below `to` cannot run against the store, or silently loses data, once this has run */
  breaksOlderReaders: boolean
  /** Rewrites or re-indexes every message, or `VACUUM`s the file: too long to run while another host waits (#280) */
  heavy?: true
  run: () => void
}

/** What the steps need from the store that runs them: its connection and the vacuum a step leaves for after it */
export interface MigrationHost {
  /** The connection, read when a step runs: a probe store gets its connection after its list is made */
  getDb(): Database.Database
  vacuumAfterStep(report?: (done: VacuumDone) => void): void
}

/** What every file of steps stands on: `this.db` and the store's own `vacuumAfterStep` */
export abstract class MigrationRange {
  constructor(private readonly host: MigrationHost) {}

  protected get db(): Database.Database {
    return this.host.getDb()
  }

  protected vacuumAfterStep(report?: (done: VacuumDone) => void): void {
    this.host.vacuumAfterStep(report)
  }

  abstract steps(): MigrationStep[]
}
