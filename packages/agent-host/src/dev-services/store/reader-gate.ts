import type Database from 'better-sqlite3'
import { type MigrationStep } from './migrations/context.js'
import { readStoreKey, writeStoreKey } from './store-keys.js'

/**
 * The `app_settings` key that holds the lowest schema version that can still read this store (#292). A row, not a
 * `PRAGMA`: SQLite has one integer of its own to spare (`user_version`, already the migration counter), and this sits
 * next to the host's other settings, where an older host that has never heard of it leaves it alone.
 */
const MIN_READER_KEY = 'min_reader_version'

/**
 * The store needs a newer host than this one (#292). Thrown by the constructor before anything touches the file, so
 * the caller can refuse to start with this message rather than open the store and fail later on a missing column.
 */
export class StoreTooNewError extends Error {
  constructor(
    readonly minReaderVersion: number,
    readonly knownVersion: number,
    readonly dbPath: string,
  ) {
    super(storeTooNewMessage(minReaderVersion, knownVersion, dbPath))
    this.name = 'StoreTooNewError'
  }
}

/**
 * Said on startup refusal. The phrase "written by a newer Centralu" is what the desktop supervisor matches to show
 * this at once instead of retrying (`host_proc`, `is_final_refusal`): a retry gets the same answer.
 */
export function storeTooNewMessage(minReaderVersion: number, knownVersion: number, dbPath: string): string {
  return (
    `[agent-host] This data was written by a newer Centralu.\n` +
    `  It can be read from store version ${minReaderVersion} on; this Centralu knows store versions up to ${knownVersion}.\n` +
    `  Update Centralu to open it. Nothing in the data was changed.\n` +
    `  Store: ${dbPath}`
  )
}

/**
 * The min-reader version gate (#292): which builds can still read the store, and the refusal of one this host cannot.
 * The bottom of `Store`, below the migration runner (store/migrate-runner.ts). A base class rather than a module the
 * store holds: the runner raises the floor inside a step's commit, and `Store.inspect`, the schema-doc probe and tests
 * reach these methods on a `Store` that never ran its constructor.
 */
export abstract class ReaderGate {
  protected abstract db: Database.Database
  protected abstract readonly dbPath: string
  protected abstract migrationSteps(): MigrationStep[]

  /**
   * The newest version this host has a step for. A store whose `min_reader_version` is above it is refused; a store
   * whose `user_version` is above it, but whose `min_reader_version` is not, is opened and left as it is.
   */
  get latestKnownVersion(): number {
    const steps = this.migrationSteps()
    return steps[steps.length - 1]!.to
  }

  /** The lowest schema version that can still read this store (#292) */
  get minReaderVersion(): number {
    return this.storedMinReader() ?? 0
  }

  protected refuseIfTooNew(): void {
    const floor = this.storedMinReader()
    const known = this.latestKnownVersion
    if (floor === null || floor <= known) return
    this.db.close()
    throw new StoreTooNewError(floor, known, this.dbPath)
  }

  /** null when nothing is recorded yet: a new store, or one last opened by a host from before #292 */
  protected storedMinReader(): number | null {
    const raw = readStoreKey(this.db, MIN_READER_KEY)
    const n = raw !== null ? Number(raw) : NaN
    // Only a hand-edited store holds something else here; computing it again is better than trusting it
    return Number.isInteger(n) && n >= 0 ? n : null
  }

  protected writeMinReader(version: number): void {
    // v13 raises it before v16 has made the table (`writeStoreKey` makes it)
    writeStoreKey(this.db, MIN_READER_KEY, String(version))
  }
}
