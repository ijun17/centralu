import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AppRunRecords, type AppRunRecord } from './store/app-runs.js'
import { KeptRuns } from './store/kept-runs.js'
import { ChildOwnershipRecords, type QueuedRequest } from './store/child-ownership.js'
import { GridRecords } from './store/grid.js'
import { HandoffMarkers } from './store/handoff-markers.js'
import { LinkedMachineRecords, type LinkedMachineRow } from './store/linked-machines.js'
import { MessageRecords, type ReadOpts } from './store/messages.js'
import { MigrationRunner, type StoreInspection, type StoreOptions } from './store/migrate-runner.js'
import { type MigrationStep } from './store/migrations/context.js'
import { migrationSteps } from './store/migrations/index.js'
import {
  PermissionRecords,
  type AppPermissionRecord,
  type ConsentRow,
  type ProjectConsentKind,
} from './store/permissions.js'
import { ProjectRecords } from './store/projects.js'
import { StoreTooNewError, storeTooNewMessage } from './store/reader-gate.js'
import { SessionRecords } from './store/sessions.js'
import { SettingsRecords } from './store/settings.js'
import { TrashRecords, type TrashedRow, type TrashRecord } from './store/trash.js'

// The shapes the store hands out are defined beside the code that reads them; they are named here as they always were
export type {
  AppPermissionRecord,
  AppRunRecord,
  LinkedMachineRow,
  ConsentRow,
  ProjectConsentKind,
  QueuedRequest,
  ReadOpts,
  StoreInspection,
  StoreOptions,
  TrashedRow,
  TrashRecord,
}

// The migration runner and the reader gate `Store` stands on are named here as they always were
export { StoreTooNewError, storeTooNewMessage }

/**
 * Where the schema lives depends on how the process is running.
 * Dev (tsx) reads it from the source tree; the bundled (shipped `.app`) build reads it next to
 * the build output — the source path does not exist after bundling, so the candidates are
 * tried in order (F-0).
 */
function resolveSchemaPath(): string {
  const candidates = [
    new URL('./schema.sql', import.meta.url), // bundled output layout
    new URL('../../../protocol/src/schema/schema.sql', import.meta.url), // source tree
  ].map((u) => fileURLToPath(u))
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`schema.sql not found: ${candidates.join(', ')}`)
  return found
}

const SCHEMA_PATH = resolveSchemaPath()

/**
 * The dev-only store (docs/agent-host.md §5). Replaced by rusqlite once the app moves to
 * Tauri; the schema file (protocol/src/schema/schema.sql) is shared as-is.
 */
export class Store extends MigrationRunner {
  protected db: Database.Database
  /*
   * The records, one module per concept in `store/`, each holding its queries and the comments that say what they do.
   * Callers reach them through these fields (`store.projects.listProjects()`), so `Store` itself is only the
   * connection, the migration runner and these fields.
   */
  readonly projects: ProjectRecords
  readonly sessions: SessionRecords
  readonly grid: GridRecords
  readonly messages: MessageRecords
  readonly handoffs: HandoffMarkers
  readonly trash: TrashRecords
  readonly settings: SettingsRecords
  readonly permissions: PermissionRecords
  readonly appRuns: AppRunRecords
  /** The records of deleted app-agent sessions, kept in the trash (#378) */
  readonly keptRuns: KeptRuns
  readonly children: ChildOwnershipRecords
  readonly machines: LinkedMachineRecords

  constructor(
    protected readonly dbPath = ':memory:',
    protected readonly opts: StoreOptions = {},
  ) {
    super()
    const path = dbPath
    this.db = new Database(path)
    this.projects = new ProjectRecords(this.db)
    this.sessions = new SessionRecords(this.db)
    this.grid = new GridRecords(this.db)
    this.messages = new MessageRecords(this.db)
    this.handoffs = new HandoffMarkers(this.db)
    this.settings = new SettingsRecords(this.db)
    this.trash = new TrashRecords(this.db, this.sessions)
    this.permissions = new PermissionRecords(this.db)
    this.appRuns = new AppRunRecords(this.db)
    this.keptRuns = new KeptRuns(this.db)
    this.children = new ChildOwnershipRecords(this.db)
    this.machines = new LinkedMachineRecords(this.db, this.settings)
    try {
      /*
       * Before anything writes: not the WAL switch, not schema.sql, not a migration. schema.sql alone would already
       * recreate, empty, whatever a newer build dropped (v13's lesson), so a store this host cannot read is left exactly
       * as the newer build wrote it.
       */
      this.refuseIfTooNew()
      this.db.pragma('journal_mode = WAL')
      /*
       * Set here rather than left to how better-sqlite3 happens to be built (#396). CASCADE on project and session
       * deletion depends on `foreign_keys`, which plain SQLite (and rusqlite, the planned replacement) leaves off.
       * `synchronous = FULL` is what better-sqlite3's build already gave in WAL mode, kept on purpose: NORMAL can lose
       * the last commits on power loss or an OS crash, and those are conversations, the data the store must not lose.
       * `busy_timeout` is the library's default made visible.
       */
      this.db.pragma('foreign_keys = ON')
      this.db.pragma('synchronous = FULL')
      this.db.pragma('busy_timeout = 5000')
      /*
       * A checkpoint that resets the WAL also cuts the file back to this. Without a limit the WAL keeps the size of the
       * largest transaction it ever held until the next TRUNCATE, at open or close: after a swap's deferred VACUUM
       * (146 MB measured) that was the rest of a host's life, and under the keeper a host lives for days.
       */
      this.db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT}`)
      this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
      this.migrate()
    } catch (e) {
      /*
       * A store that is refused or fails a step is closed before the error leaves: nobody holds this object to close it
       * later. On Windows an open file cannot be deleted or renamed, so the handle would keep store.db (and its -wal)
       * locked until the process ended (#14).
       */
      this.db.close()
      throw e
    }
    /*
     * Fold any inherited WAL here. Measured (2026-08-26): a 91MB store.db sat next to a
     * 97MB store.db-wal — bigger than the database itself. close() folds the WAL, but if the
     * host is SIGKILLed before it reaches close() on the app's shutdown path (as with the old
     * Tauri 300ms budget), the WAL survives untouched until the next run. Fold once on start
     * and once on close — whichever side fails to run, the other side still folds it.
     */
    this.checkpoint()
  }

  /**
   * Folds the WAL into the main database and truncates the file to zero. Returns whether it did: a failure is not
   * fatal, and it is tried again at the next open or close.
   *
   * It never waits. With another connection reading, a TRUNCATE checkpoint waits out the whole busy timeout (5 s,
   * measured) on the event loop and then reports busy rather than throwing, which is longer than the 3 s a host has to
   * shut down (#396).
   *
   * On a closed store it does nothing and says so: a shutdown path that closes the store twice must not throw on the
   * second close, where it would hide why the shutdown went wrong.
   */
  checkpoint(): boolean {
    if (!this.db.open) return false
    const wait = this.db.pragma('busy_timeout', { simple: true }) as number
    try {
      this.db.pragma('busy_timeout = 0')
      const [row] = this.db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
      return row?.busy === 0
    } catch {
      return false
    } finally {
      this.db.pragma(`busy_timeout = ${wait}`)
    }
  }

  /** The migration list. `store/migrations/index.ts` holds it, and the rule a new step follows */
  protected migrationSteps(): MigrationStep[] {
    return migrationSteps({
      getDb: () => this.db,
      vacuumAfterStep: (report) => this.vacuumAfterStep(report),
    })
  }

  get schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number
  }

  close() {
    this.checkpoint()
    this.db.close()
  }
}

/** What a reset WAL is cut back to (`journal_size_limit`) */
const WAL_SIZE_LIMIT = 64 * 1024 * 1024
