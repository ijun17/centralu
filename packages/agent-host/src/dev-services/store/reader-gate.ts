import type Database from 'better-sqlite3'
import { type MigrationStep } from './migrations/context.js'
import { BASELINE_VERSION } from './migrations/v27-baseline.js'
import { pragmaNumber } from './rows.js'
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
    message = storeTooNewMessage(minReaderVersion, knownVersion, dbPath),
  ) {
    super(message)
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
 * The store is older than the oldest one this host migrates (#1143): the steps that brought it to v27 are gone. Thrown
 * by the constructor before anything touches the file, like `StoreTooNewError`.
 */
export class StoreTooOldError extends Error {
  constructor(
    readonly userVersion: number,
    readonly dbPath: string,
  ) {
    super(
      `[agent-host] This data was written by a Centralu too old for this one to update.
` +
        `  It is at store version ${userVersion}; this Centralu updates store versions from ${BASELINE_VERSION} on.
` +
        `  Open it once with Centralu 0.1.0-beta.45, then with this one. Nothing in the data was changed.
` +
        `  Store: ${dbPath}`,
    )
    this.name = 'StoreTooOldError'
  }
}

/**
 * Said when the record is not a version and the store is newer than this host (#384): nothing says which builds can
 * read it, so this one does not try. It keeps the phrase the supervisor matches, for the same reason.
 */
function unreadableFloorMessage(stored: string, userVersion: number, knownVersion: number, dbPath: string): string {
  return (
    `[agent-host] This data was written by a newer Centralu, and which versions can read it cannot be told.
` +
    `  app_settings.${MIN_READER_KEY} holds ${JSON.stringify(stored.slice(0, 40))}, not a store version; the store is at version ${userVersion}, and this Centralu knows store versions up to ${knownVersion}.
` +
    `  Update Centralu to open it. Nothing in the data was changed.
` +
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
    return steps.at(-1)?.to ?? 0
  }

  /** The lowest schema version that can still read this store (#292) */
  get minReaderVersion(): number {
    return this.storedMinReader() ?? 0
  }

  /** A new store (version 0) starts from the baseline; one between it and the baseline is refused */
  protected refuseIfTooOld(): void {
    const version = pragmaNumber(this.db, 'user_version')
    if (version > 0 && version < BASELINE_VERSION) throw new StoreTooOldError(version, this.dbPath)
  }

  protected refuseIfTooNew(): void {
    const refusal = this.tooNew(this.dbPath)
    if (!refusal) return
    this.db.close()
    throw refusal
  }

  /**
   * Why this host cannot open the store, or null. A record above this host refuses (#292). A record that is not a
   * version (#384), which only a hand edit or a write cut short leaves, is worked out again from the steps the store
   * has run when this host knows every one of them (`migrate`), and refuses when the store is newer than this host:
   * a floor worked out from fewer steps could open what this host cannot read, and would lower the record for good.
   */
  protected tooNew(dbPath: string): StoreTooNewError | null {
    const known = this.latestKnownVersion
    const floor = this.storedMinReader()
    if (floor !== null) return floor > known ? new StoreTooNewError(floor, known, dbPath) : null
    const stored = this.unreadableMinReader()
    const userVersion = pragmaNumber(this.db, 'user_version')
    if (stored === null || userVersion <= known) return null
    return new StoreTooNewError(userVersion, known, dbPath, unreadableFloorMessage(stored, userVersion, known, dbPath))
  }

  /** null when nothing is recorded yet (a new store, or one last opened by a host from before #292), or the record is not a version */
  protected storedMinReader(): number | null {
    const raw = readStoreKey(this.db, MIN_READER_KEY)
    return raw !== null ? floorOf(raw) : null
  }

  /** The record as stored, when it is there and is not a version (#384); null otherwise */
  protected unreadableMinReader(): string | null {
    const raw = readStoreKey(this.db, MIN_READER_KEY)
    return raw !== null && floorOf(raw) === null ? raw : null
  }

  protected writeMinReader(version: number): void {
    // v13 raises it before v16 has made the table (`writeStoreKey` makes it)
    writeStoreKey(this.db, MIN_READER_KEY, String(version))
  }
}

/** A stored record read as a version, or null for anything else */
function floorOf(raw: string): number | null {
  const n = Number(raw)
  return raw.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : null
}
