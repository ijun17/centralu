import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AgentUse, GridPanel, ProjectInfo, SavedCommand, SessionInfo, StoredMessage, ToolDefaults } from '@cc/protocol'
import { AppRunRecords, type AppRunRecord } from './store/app-runs.js'
import { ChildOwnershipRecords, type QueuedRequest } from './store/child-ownership.js'
import { GridRecords } from './store/grid.js'
import { HandoffMarkers } from './store/handoff-markers.js'
import { LinkedMachineRecords, type LinkedMachineRow } from './store/linked-machines.js'
import { MessageRecords, type ReadOpts } from './store/messages.js'
import { APP_SETTINGS_DDL, type MigrationStep } from './store/migrations/context.js'
import { migrationSteps } from './store/migrations/index.js'
import {
  PermissionRecords,
  type AppPermissionRecord,
  type ConsentRow,
  type ProjectConsentKind,
} from './store/permissions.js'
import { ProjectRecords } from './store/projects.js'
import { SessionRecords } from './store/sessions.js'
import { SettingsRecords } from './store/settings.js'
import { TrashRecords, type TrashedRow, type TrashRecord } from './store/trash.js'
import { mb, type VacuumDone } from './store/vacuum.js'

// The shapes the store hands out are defined beside the code that reads them; they are named here as they always were
export type {
  AppPermissionRecord,
  AppRunRecord,
  LinkedMachineRow,
  ConsentRow,
  ProjectConsentKind,
  QueuedRequest,
  ReadOpts,
  TrashedRow,
  TrashRecord,
}

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
 * The `app_settings` key that holds the lowest schema version that can still read this store (#292). A row, not a
 * `PRAGMA`: SQLite has one integer of its own to spare (`user_version`, already the migration counter), and this sits
 * next to the host's other settings, where an older host that has never heard of it leaves it alone.
 */
const MIN_READER_KEY = 'min_reader_version'

/**
 * The `app_settings` key listing steps a host swap left for later (#280 step 3): a JSON array of their `to` numbers.
 * `user_version` has moved past them, so the list is how the next open knows they still have to run.
 */
const DEFERRED_KEY = 'deferred_migrations'

/**
 * The `app_settings` key present while a `VACUUM` a migration step queued has not run yet (#396). Written in the step's
 * own transaction and deleted once the vacuum is over, so a host stopped during the vacuum (which SQLite rolls back
 * whole) leaves it for the next open. The step's version has already committed by then: without the row, nothing would
 * vacuum again and the file would keep its free pages for good.
 */
const VACUUM_OWED_KEY = 'vacuum_owed'

export type StoreOptions = {
  /**
   * Opened by a host that is taking over from another one (#280 step 3, a blue-green swap). Only the steps the
   * previous build can still read run now; heavy and breaking steps are left for `runDeferred`, which the host calls
   * once the swap is over. See "During a swap" above the list in `migrationSteps`.
   */
  swap?: boolean
}

/** What a host about to take over sees in the store, without writing to it (#280 step 3, `Store.inspect`) */
export type StoreInspection = {
  /** False for a store that does not exist yet */
  exists: boolean
  userVersion: number
  minReaderVersion: number
  latestKnownVersion: number
  /** Set when this host cannot open the store: the message it would refuse with */
  tooNew: string | null
  /** The steps this host would run, with how a swap treats each */
  pending: { to: number; heavy: boolean; breaksOlderReaders: boolean }[]
}


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
 * this at once instead of retrying (`sidecar.rs`, `is_final_refusal`): a retry gets the same answer.
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
 * The dev-only store (docs/agent-host.md §5). Replaced by rusqlite once the app moves to
 * Tauri; the schema file (protocol/src/schema/schema.sql) is shared as-is.
 */
export class Store {
  private db: Database.Database
  private readonly projects: ProjectRecords
  private readonly sessions: SessionRecords
  private readonly grid: GridRecords
  private readonly messages: MessageRecords
  private readonly handoffs: HandoffMarkers
  private readonly trash: TrashRecords
  private readonly settings: SettingsRecords
  private readonly permissions: PermissionRecords
  private readonly appRuns: AppRunRecords
  private readonly children: ChildOwnershipRecords
  private readonly machines: LinkedMachineRecords

  /**
   * The number of migration steps **actually run** this time.
   *
   * This is both a diagnostic and a guard against regression. The property "a step that has
   * already run does not run again" is invisible, so once it breaks (as it did when
   * schema.sql kept rewriting `PRAGMA user_version`) the result stays correct while only the
   * cost quietly grows, and nobody notices. Counting it lets a test ask.
   */
  migrationsRun = 0

  constructor(
    private readonly dbPath = ':memory:',
    private readonly opts: StoreOptions = {},
  ) {
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

  /**
   * The migration runner (E-0).
   *
   * The schema file only has `CREATE TABLE IF NOT EXISTS`, so **adding a column or index is
   * silently ignored on an existing database.** There is already a file with real user data
   * on it (~/.centralu/store.db), so steps are applied in sequence based on user_version.
   *
   * **A step that has already run does not run again.** For a long time that was not true —
   * schema.sql rewrote `PRAGMA user_version = 1` on every open, so even a v27 database replayed
   * all 26 steps from scratch on every run. Every step happened to be written idempotently
   * (guarded), so the result stayed correct, and **only the cost quietly grew**: 4.4 to 5.0
   * seconds per open, of which v3, v11 and v21 each scanned the entire messages table
   * (66,700 rows). Removing that PRAGMA is what gives migrations this property.
   *
   * The steps in `store/migrations/` still **have to be written idempotently.** A new database starts at 0 and
   * runs all 26 steps in order in one go, and many steps run on top of tables schema.sql has
   * already created (for example v13 sees the empty table v9 made and skips it).
   *
   * Which builds can still read the store is kept alongside (#292): see the rule above the list in
   * `migrationSteps`. A store newer than this host runs no step at all — the loop below only knows
   * steps up to `latestKnownVersion` — and the constructor has already refused one this host cannot read.
   */
  private migrate(): void {
    const current = this.schemaVersion
    const steps = this.migrationSteps()
    /*
     * A store from before #292 has no record, so it is computed once from the steps it has already run. From then on
     * the record only goes up: a newer host may have raised it past anything this host knows, and a lower guess here
     * must not undo that.
     */
    const stored = this.storedMinReader()
    let floor = stored ?? Math.max(0, ...steps.filter((s) => s.breaksOlderReaders && s.to <= current).map((s) => s.to))
    if (stored === null) this.writeMinReader(floor)

    const t0 = Date.now()
    /*
     * Steps an earlier swap left for later (#280 step 3) run now, in their place in the order, unless this open is
     * itself a swap. A host that died before `runDeferred` finished leaves them here for the next one.
     */
    const deferred = new Set(this.storedDeferred())
    // A swap only ever meets a store an earlier host already built; a new store has nothing heavy to do
    const swap = this.opts.swap === true && current > 0
    for (const step of steps) {
      const due = current < step.to || deferred.has(step.to)
      if (!due) continue
      const bump = () => {
        if (step.to > this.schemaVersion) this.db.pragma(`user_version = ${step.to}`)
      }
      if (swap && (step.heavy || step.breaksOlderReaders)) {
        deferred.add(step.to)
        /*
         * The list and the version past the step commit together (#396). The list used to be written once the loop
         * was over: a start stopped before then left `user_version` past a step no list remembered, and it never ran.
         */
        this.db.transaction(() => {
          this.writeDeferred([...deferred])
          bump()
        })()
      } else {
        floor = this.runStep(step, floor, () => {
          bump()
          // A step an earlier swap left for later is crossed off in its own commit, as `runDeferred` does
          if (deferred.delete(step.to)) this.writeDeferred([...deferred])
        })
      }
    }
    if (deferred.size > 0 && this.dbPath !== ':memory:') {
      console.error(`[store] left for after the swap: v${[...deferred].sort((a, b) => a - b).join(', v')}`)
    }
    /*
     * A vacuum a stopped host left owed (#396) runs now. In a swap it waits for `runDeferred` with the heavy steps: it
     * holds the file for as long as they do.
     */
    if (!swap && this.vacuumOwed) this.runOwedVacuum('a host stopped during it left it owed')
    /*
     * If migrations ran, **say so** (a lesson from a dogfooding incident: beta.4 silently
     * reworked a 151k-message database for over ten seconds, and with neither the UI nor the
     * log saying anything, it read as "frozen" and the person killed it with Cmd+Q). One line
     * is enough for host.log to explain that silence. An in-memory database (tests) runs every
     * step every time, so this would just be noise there — file databases only.
     */
    if (this.migrationsRun > 0 && this.dbPath !== ':memory:') {
      console.error(
        `[store] migrated v${current} → v${this.schemaVersion} (${this.migrationsRun} steps, ${Date.now() - t0}ms)`,
      )
    }
    // An older host on a newer store is allowed (the record says so) but unusual — host.log should show it happened
    if (current > this.latestKnownVersion && this.dbPath !== ':memory:') {
      console.error(
        `[store] v${current} was written by a newer Centralu; this one knows up to v${this.latestKnownVersion} and ` +
          `opens it without migrating (it can be read from v${floor} on)`,
      )
    }
  }

  /**
   * Runs one step, raising `min_reader_version` first when the step breaks older readers. Returns the new floor.
   *
   * Raised **before** the step runs, in the same commit. A store an older host opens and breaks on is what the record
   * exists to prevent; since the step and the record commit together (#396), a step that fails takes the raise back
   * with it and the store stays one any older host could read. A step that commits on its own (`ownTransaction`) keeps
   * the old order: the record first, then the step.
   */
  private runStep(step: MigrationStep, floor: number, record: () => void): number {
    const raise = step.breaksOlderReaders && step.to > floor
    const apply = () => {
      if (raise) this.writeMinReader(step.to)
      step.run()
      record()
    }
    /*
     * **A step and the record that it ran commit together (#396).** Each statement used to commit on its own, and the
     * version a moment later: a start killed between two ALTERs of one step left the first column added and the next
     * start, finding that column, skipped the step for good, so every later query on the missing column failed. A
     * swap makes that kill likelier: the keeper stops a host that has not finished activating. What cannot run inside a
     * transaction (VACUUM) waits for the commit (`afterStep`), and the step records in its commit that the vacuum is
     * owed (`vacuumAfterStep`): one that is cut off is run again by the next open.
     */
    if (step.ownTransaction) {
      apply()
    } else {
      this.pendingAfterStep = []
      let later: (() => void)[]
      try {
        this.db.transaction(apply)()
      } finally {
        later = this.pendingAfterStep
        this.pendingAfterStep = null
      }
      for (const work of later) work()
    }
    this.migrationsRun += 1
    return raise ? step.to : floor
  }

  /** Work a migration step leaves for after its commit; outside a step it runs at once */
  private pendingAfterStep: (() => void)[] | null = null
  private afterStep(work: () => void): void {
    if (this.pendingAfterStep) this.pendingAfterStep.push(work)
    else work()
  }

  /**
   * A step's `VACUUM` (#396): recorded as owed inside the step's transaction, run after its commit. `report` is told
   * what the vacuum did when it ran.
   */
  private vacuumAfterStep(report?: (done: VacuumDone) => void): void {
    this.db.exec(APP_SETTINGS_DDL)
    this.db
      .prepare(`INSERT INTO app_settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(VACUUM_OWED_KEY)
    this.afterStep(() => {
      const done = this.runOwedVacuum()
      if (done) report?.(done)
    })
  }

  /** A `VACUUM` a step queued has not run yet: the host was stopped during it (#396) */
  get vacuumOwed(): boolean {
    const table = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'`).get()
    return !!table && !!this.db.prepare(`SELECT 1 FROM app_settings WHERE key = ?`).get(VACUUM_OWED_KEY)
  }

  /**
   * Runs the owed `VACUUM` and deletes the record of it. `why`, when given, is said in host.log on success.
   *
   * A vacuum that fails (no room for its temporary copy, say) is reported and passed over, its record deleted too: the
   * free pages stay in the file and later writes reuse them, and a store that cannot shrink must neither keep the host
   * from starting nor make every start try again. Only a host stopped during the vacuum leaves the record behind.
   */
  private runOwedVacuum(why?: string): VacuumDone | null {
    const pageSize = this.db.pragma('page_size', { simple: true }) as number
    const size = () => (this.db.pragma('page_count', { simple: true }) as number) * pageSize
    const before = size()
    const t0 = Date.now()
    try {
      this.db.exec('VACUUM')
    } catch (err) {
      const free = (this.db.pragma('freelist_count', { simple: true }) as number) * pageSize
      console.error(`[store] could not vacuum; ${mb(free)} stay free in the file: ${(err as Error).message}`)
      return null
    } finally {
      this.db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(VACUUM_OWED_KEY)
    }
    const done = { before, after: size(), ms: Date.now() - t0 }
    if (why) console.error(`[store] vacuumed ${mb(done.before)} -> ${mb(done.after)} (${done.ms}ms): ${why}`)
    return done
  }

  /** Steps a swap left for later that have not run yet (#280 step 3) */
  get deferredSteps(): number[] {
    return this.storedDeferred()
  }

  /**
   * Runs the steps a swap left for later, in order (#280 step 3). Called by a host once it has taken over, when the
   * host it replaced is gone for good: a breaking step here is what stops that build from coming back, so it must not
   * run while the swap could still fall back to it. Returns how many ran.
   */
  runDeferred(): number {
    const left = new Set(this.storedDeferred())
    // A swap's open leaves an owed vacuum (#396) here too, so this may have that alone to do
    const owed = this.vacuumOwed
    if (left.size === 0 && !owed) return 0
    const t0 = Date.now()
    let floor = this.minReaderVersion
    let ran = 0
    for (const step of this.migrationSteps()) {
      if (!left.has(step.to)) continue
      // One at a time, and in the step's own commit, so a host that dies half way leaves exactly what is still owed
      floor = this.runStep(step, floor, () => {
        left.delete(step.to)
        this.writeDeferred([...left])
      })
      ran += 1
    }
    // Paid by a step above if one vacuumed; otherwise still owed from before the swap
    if (owed && this.vacuumOwed) this.runOwedVacuum('a host stopped during it left it owed')
    if (this.dbPath !== ':memory:') console.error(`[store] ran ${ran} step(s) left from the swap (${Date.now() - t0}ms)`)
    // A deferred VACUUM goes through the WAL whole; folded now, not at this host's close days from now
    this.checkpoint()
    return ran
  }

  /**
   * Reads what a host would do to this store, without writing to it (#280 step 3). A host started in standby for a
   * swap calls this before it takes the ownership lock: it must not touch a store another host is serving from.
   */
  static inspect(dbPath: string): StoreInspection {
    const empty = (known: number): StoreInspection => ({
      exists: false,
      userVersion: 0,
      minReaderVersion: 0,
      latestKnownVersion: known,
      tooNew: null,
      pending: [],
    })
    // The steps' flags are read off an object that never runs them: `run` closes over `db`, which stays unused here
    // A probe has no concept modules (store/*.ts): it may only call the migration methods
    const probe = Object.create(Store.prototype) as Store
    const steps = probe.migrationSteps()
    const known = steps[steps.length - 1]!.to
    if (dbPath === ':memory:' || !existsSync(dbPath)) return empty(known)
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      probe.db = db
      const userVersion = db.pragma('user_version', { simple: true }) as number
      const floor = probe.storedMinReader()
      const deferred = new Set(probe.storedDeferred())
      return {
        exists: true,
        userVersion,
        minReaderVersion: floor ?? 0,
        latestKnownVersion: known,
        tooNew: floor !== null && floor > known ? storeTooNewMessage(floor, known, dbPath) : null,
        pending: steps
          .filter((s) => userVersion < s.to || deferred.has(s.to))
          .map((s) => ({ to: s.to, heavy: s.heavy === true, breaksOlderReaders: s.breaksOlderReaders })),
      }
    } finally {
      db.close()
    }
  }

  private storedDeferred(): number[] {
    const table = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'`).get()
    if (!table) return []
    const row = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(DEFERRED_KEY) as
      | { value: string }
      | undefined
    if (!row) return []
    try {
      const v: unknown = JSON.parse(row.value)
      return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0) : []
    } catch {
      return []
    }
  }

  private writeDeferred(steps: number[]): void {
    this.db.exec(APP_SETTINGS_DDL)
    if (steps.length === 0) {
      this.db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(DEFERRED_KEY)
      return
    }
    this.db
      .prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(DEFERRED_KEY, JSON.stringify([...steps].sort((a, b) => a - b)))
  }

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

  private refuseIfTooNew(): void {
    const floor = this.storedMinReader()
    const known = this.latestKnownVersion
    if (floor === null || floor <= known) return
    this.db.close()
    throw new StoreTooNewError(floor, known, this.dbPath)
  }

  /** null when nothing is recorded yet: a new store, or one last opened by a host from before #292 */
  private storedMinReader(): number | null {
    const table = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'`).get()
    if (!table) return null
    const row = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(MIN_READER_KEY) as
      | { value: string }
      | undefined
    const n = row ? Number(row.value) : NaN
    // Only a hand-edited store holds something else here; computing it again is better than trusting it
    return Number.isInteger(n) && n >= 0 ? n : null
  }

  private writeMinReader(version: number): void {
    // v13 raises it before v16 has made the table; the DDL is the same, so v16 then finds it in place
    this.db.exec(APP_SETTINGS_DDL)
    this.db
      .prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(MIN_READER_KEY, String(version))
  }

  /** The migration list. `store/migrations/index.ts` holds it, and the rule a new step follows */
  private migrationSteps(): MigrationStep[] {
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

  /*
   * Everything below only passes the call on to the module named in its heading, which holds the code and the comment
   * that says what it does. The methods stay here so that no caller names a module.
   */

  // ── ProjectRecords (store/projects.ts) ──

  addProject(p: { id: string; path: string; name: string; trusted?: boolean }): void {
    return this.projects.addProject(p)
  }

  listProjects(): Omit<ProjectInfo, 'git' | 'commands' | 'defaultModels'>[] {
    return this.projects.listProjects()
  }

  projectCommands(projectId: string): SavedCommand[] {
    return this.projects.projectCommands(projectId)
  }

  setProjectCommands(projectId: string, commands: readonly SavedCommand[]): void {
    return this.projects.setProjectCommands(projectId, commands)
  }

  worktreeSetup(projectId: string): { command: string; copyFiles: string[] } | null {
    return this.projects.worktreeSetup(projectId)
  }

  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): void {
    return this.projects.setWorktreeSetup(projectId, setup)
  }

  worktreeManager(projectId: string): { sessionId: string; baseBranch: string } | null {
    return this.projects.worktreeManager(projectId)
  }

  worktreeTrunk(projectId: string): string | null {
    return this.projects.worktreeTrunk(projectId)
  }

  setWorktreeTrunk(projectId: string, baseBranch: string): void {
    return this.projects.setWorktreeTrunk(projectId, baseBranch)
  }

  setWorktreeManager(projectId: string, manager: { sessionId: string; baseBranch: string } | null): void {
    return this.projects.setWorktreeManager(projectId, manager)
  }

  setProjectDefaultTool(projectId: string, tool: string): void {
    return this.projects.setProjectDefaultTool(projectId, tool)
  }

  projectToolDefaults(projectId: string): Record<string, ToolDefaults> {
    return this.projects.projectToolDefaults(projectId)
  }

  setProjectToolDefaults(projectId: string, tool: string, d: ToolDefaults): void {
    return this.projects.setProjectToolDefaults(projectId, tool, d)
  }

  projectRoots(): { id: string; path: string; trusted: boolean }[] {
    return this.projects.projectRoots()
  }

  setProjectTrusted(projectId: string, trusted: boolean): boolean {
    return this.projects.setProjectTrusted(projectId, trusted)
  }

  findProjectByPath(path: string): { id: string } | undefined {
    return this.projects.findProjectByPath(path)
  }

  setProjectOrder(orderedIds: readonly string[]): void {
    return this.projects.setProjectOrder(orderedIds)
  }

  // ── SessionRecords (store/sessions.ts) ──

  upsertSession(s: SessionInfo): void {
    return this.sessions.upsertSession(s)
  }

  setSessionOrder(orderedIds: readonly string[]): void {
    return this.sessions.setSessionOrder(orderedIds)
  }

  orchestratorId(): string | null {
    return this.sessions.orchestratorId()
  }

  listSessions(): SessionInfo[] {
    return this.sessions.listSessions()
  }

  sessionCwd(sessionId: string): string | null {
    return this.sessions.sessionCwd(sessionId)
  }

  setSessionCwd(sessionId: string, cwd: string): void {
    return this.sessions.setSessionCwd(sessionId, cwd)
  }

  setTouchedPaths(sessionId: string, paths: string[]): void {
    return this.sessions.setTouchedPaths(sessionId, paths)
  }

  getTouchedPaths(sessionId: string): string[] {
    return this.sessions.getTouchedPaths(sessionId)
  }

  recordCommit(projectId: string, sha: string, sessionId: string): void {
    return this.sessions.recordCommit(projectId, sha, sessionId)
  }

  commitSessions(projectId: string): { sha: string; sessionId: string }[] {
    return this.sessions.commitSessions(projectId)
  }

  markRead(sessionId: string, seq: number): void {
    return this.sessions.markRead(sessionId, seq)
  }

  // ── GridRecords (store/grid.ts) ──

  listGridView(): GridPanel[] {
    return this.grid.listGridView()
  }

  setGridView(panels: readonly GridPanel[], remote?: (sessionId: string) => boolean, appMachine?: (panel: Extract<GridPanel, { kind: 'app' }>) => string | null): void {
    return this.grid.setGridView(panels, remote, appMachine)
  }

  // ── MessageRecords (store/messages.ts) ──

  appendMessages(msgs: StoredMessage[]): void {
    return this.messages.appendMessages(msgs)
  }

  searchMessages(query: string, limit?: number): { sessionId: string; seq: number; body: string }[] {
    return this.messages.searchMessages(query, limit)
  }

  loadMessages(sessionId: string, limit?: number, beforeSeq?: number, opts?: ReadOpts): StoredMessage[] {
    return this.messages.loadMessages(sessionId, limit, beforeSeq, opts)
  }

  replyTextsContaining(sessionId: string, needle: string): string[] {
    return this.messages.replyTextsContaining(sessionId, needle)
  }

  loadMessagesFrom(sessionId: string, afterSeq: number, limit?: number, opts?: ReadOpts): StoredMessage[] {
    return this.messages.loadMessagesFrom(sessionId, afterSeq, limit, opts)
  }

  upsertMessageNoIndex(m: StoredMessage): void {
    return this.messages.upsertMessageNoIndex(m)
  }

  appendSubagentMessage(sessionId: string, parentCallId: string, m: Pick<StoredMessage, 'role' | 'kind' | 'payload' | 'ts'>): number {
    return this.messages.appendSubagentMessage(sessionId, parentCallId, m)
  }

  loadSubagentMessages(sessionId: string, parentCallId: string, opts?: ReadOpts & { afterSeq?: number; limit?: number }): StoredMessage[] {
    return this.messages.loadSubagentMessages(sessionId, parentCallId, opts)
  }

  nextSeq(sessionId: string): number {
    return this.messages.nextSeq(sessionId)
  }

  // ── HandoffMarkers (store/handoff-markers.ts) ──

  handoffPredecessors(): Set<string> {
    return this.handoffs.handoffPredecessors()
  }

  handoffHeirs(fromSessionId: string): { sessionId: string; trashed: boolean }[] {
    return this.handoffs.handoffHeirs(fromSessionId)
  }

  hasNotice(sessionId: string, text: string): boolean {
    return this.handoffs.hasNotice(sessionId, text)
  }

  inheritsHandoff(sessionId: string): boolean {
    return this.handoffs.inheritsHandoff(sessionId)
  }

  // ── TrashRecords (store/trash.ts) ──

  trashSession(sessionId: string, record: TrashRecord, chunk?: number): Promise<boolean> {
    return this.trash.trashSession(sessionId, record, chunk)
  }

  restoreSession(sessionId: string, projectId: string | null, chunk?: number): Promise<SessionInfo | null> {
    return this.trash.restoreSession(sessionId, projectId, chunk)
  }

  purgeSession(sessionId: string, chunk?: number): Promise<boolean> {
    return this.trash.purgeSession(sessionId, chunk)
  }

  isTrashed(sessionId: string): boolean {
    return this.trash.isTrashed(sessionId)
  }

  trashedIds(): Set<string> {
    return this.trash.trashedIds()
  }

  trashedSession(sessionId: string): { session: SessionInfo; record: TrashRecord; deletedAt: number } | null {
    return this.trash.trashedSession(sessionId)
  }

  listTrash(): TrashedRow[] {
    return this.trash.listTrash()
  }

  deleteProject(projectId: string): void {
    return this.trash.deleteProject(projectId)
  }

  // ── SettingsRecords (store/settings.ts) ──

  saveCommands(tool: string, cwd: string, commands: unknown): void {
    return this.settings.saveCommands(tool, cwd, commands)
  }

  loadCommands<T>(tool: string, cwd: string): T | null {
    return this.settings.loadCommands(tool, cwd)
  }

  saveWorkspace(layout: unknown): void {
    return this.settings.saveWorkspace(layout)
  }

  loadWorkspace<T = unknown>(): T | null {
    return this.settings.loadWorkspace()
  }

  appSetting(key: string): string | null {
    return this.settings.appSetting(key)
  }

  setAppSetting(key: string, value: string): void {
    return this.settings.setAppSetting(key, value)
  }

  updateAppSetting(key: string, next: (current: string | null) => string): void {
    return this.settings.updateAppSetting(key, next)
  }

  deleteAppSetting(key: string): void {
    return this.settings.deleteAppSetting(key)
  }

  // ── PermissionRecords (store/permissions.ts) ──

  addApprovalRule(r: {
    scope: string
    projectId?: string
    sessionId?: string
    matcher: string
    decision: string
  }): void {
    return this.permissions.addApprovalRule(r)
  }

  listApprovalRules(): {
    id: number
    scope: string
    matcher: string
    decision: string
    projectId: string | null
    sessionId: string | null
    createdAt: number
  }[] {
    return this.permissions.listApprovalRules()
  }

  deleteApprovalRule(id: number): void {
    return this.permissions.deleteApprovalRule(id)
  }

  getAppPermission(appKey: string, capability: string): AppPermissionRecord | null {
    return this.permissions.getAppPermission(appKey, capability)
  }

  putAppPermission(appKey: string, projectId: string | null, r: AppPermissionRecord): void {
    return this.permissions.putAppPermission(appKey, projectId, r)
  }

  forgetAppPermission(appKey: string, capability: string): void {
    return this.permissions.forgetAppPermission(appKey, capability)
  }

  listAppPermissions(appKey: string): AppPermissionRecord[] {
    return this.permissions.listAppPermissions(appKey)
  }

  getProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): ConsentRow | null {
    return this.permissions.getProjectConsent(fromProjectId, toProjectId, kind)
  }

  setProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): void {
    return this.permissions.setProjectConsent(fromProjectId, toProjectId, kind)
  }

  forgetProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): boolean {
    return this.permissions.forgetProjectConsent(fromProjectId, toProjectId, kind)
  }

  listProjectConsents(): ConsentRow[] {
    return this.permissions.listProjectConsents()
  }

  // ── AppRunRecords (store/app-runs.ts) ──

  beginAppRun(r: AppRunRecord): void {
    return this.appRuns.beginAppRun(r)
  }

  linkAppRunSession(id: string, sessionId: string): void {
    return this.appRuns.linkAppRunSession(id, sessionId)
  }

  endAppRun(id: string, end: { status: string; durationMs: number; error: string | null; tokens?: { input: number; output: number } | null }): void {
    return this.appRuns.endAppRun(id, end)
  }

  appAgentUse(projectId: string | null, appId: string, since: number): AgentUse {
    return this.appRuns.appAgentUse(projectId, appId, since)
  }

  keepAppRunFailure(f: { runId: string; projectId: string | null; appId: string; args: string; result: string | null; createdAt: number }, keep: number): void {
    return this.appRuns.keepAppRunFailure(f, keep)
  }

  listAppRuns(projectId: string | null, appId: string, limit: number): (AppRunRecord & { tokens: { input: number; output: number } | null; failure: { args: string; result: string | null } | null })[] {
    return this.appRuns.listAppRuns(projectId, appId, limit)
  }

  pruneAppRuns(before: number): number {
    return this.appRuns.pruneAppRuns(before)
  }

  settleUnfinishedAppRuns(error: string): number {
    return this.appRuns.settleUnfinishedAppRuns(error)
  }

  // ── ChildOwnershipRecords (store/child-ownership.ts) ──

  listReportMarks(): { sessionId: string; callerSessionId: string }[] {
    return this.children.listReportMarks()
  }

  setReportMark(sessionId: string, callerSessionId: string): void {
    return this.children.setReportMark(sessionId, callerSessionId)
  }

  clearReportMark(sessionId: string): void {
    return this.children.clearReportMark(sessionId)
  }

  listAgentStartRequests(): { requestId: string; callerSessionId: string; request: unknown; askedAt: number }[] {
    return this.children.listAgentStartRequests()
  }

  putAgentStartRequest(requestId: string, callerSessionId: string, request: unknown): void {
    return this.children.putAgentStartRequest(requestId, callerSessionId, request)
  }

  deleteAgentStartRequest(requestId: string): void {
    return this.children.deleteAgentStartRequest(requestId)
  }

  listDelegatedTurns(): { sessionId: string; callerSessionId: string; told: string[]; turnId: string }[] {
    return this.children.listDelegatedTurns()
  }

  setDelegatedTurn(sessionId: string, callerSessionId: string, turnId: string): void {
    return this.children.setDelegatedTurn(sessionId, callerSessionId, turnId)
  }

  setDelegatedTurnTold(sessionId: string, told: readonly string[]): void {
    return this.children.setDelegatedTurnTold(sessionId, told)
  }

  listQueuedRequests(): QueuedRequest[] {
    return this.children.listQueuedRequests()
  }

  addQueuedRequest(r: QueuedRequest): void {
    return this.children.addQueuedRequest(r)
  }

  markQueuedDelivering(id: string, at: number | null): void {
    return this.children.markQueuedDelivering(id, at)
  }

  removeQueuedRequest(id: string): void {
    return this.children.removeQueuedRequest(id)
  }

  clearDelegatedTurn(sessionId: string): void {
    return this.children.clearDelegatedTurn(sessionId)
  }

  moveChildren(from: string, to: string, move: { sessions: readonly string[]; startRequests: readonly { requestId: string; request: unknown }[]; armReports?: readonly string[]; queued?: boolean }): void {
    return this.children.moveChildren(from, to, move)
  }

  // ── LinkedMachineRecords (store/linked-machines.ts) ──

  listLinkedMachines(): LinkedMachineRow[] {
    return this.machines.listLinkedMachines()
  }

  addLinkedMachine(m: Omit<LinkedMachineRow, 'slot'>): LinkedMachineRow {
    return this.machines.addLinkedMachine(m)
  }

  removeLinkedMachine(id: string): void {
    return this.machines.removeLinkedMachine(id)
  }

  setLinkedMachineAcceptedVersions(id: string, key: string | null): void {
    return this.machines.setLinkedMachineAcceptedVersions(id, key)
  }

  machineHeaders(machineId: string, kind: 'session' | 'project'): unknown[] | null {
    return this.machines.machineHeaders(machineId, kind)
  }

  replaceMachineHeaders(machineId: string, kind: 'session' | 'project', items: readonly { id: string }[]): void {
    return this.machines.replaceMachineHeaders(machineId, kind, items)
  }

  upsertMachineSession(machineId: string, item: { id: string }): void {
    return this.machines.upsertMachineSession(machineId, item)
  }

  patchMachineSession(machineId: string, sessionId: string, patch: Record<string, unknown>): void {
    return this.machines.patchMachineSession(machineId, sessionId, patch)
  }

  removeMachineSession(machineId: string, sessionId: string): void {
    return this.machines.removeMachineSession(machineId, sessionId)
  }
}

/** What a reset WAL is cut back to (`journal_size_limit`) */
const WAL_SIZE_LIMIT = 64 * 1024 * 1024
