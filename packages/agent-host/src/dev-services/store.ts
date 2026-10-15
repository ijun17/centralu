import type { WorktreeRecovery } from './worktree-recovery.js'
import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { GridPanel, ProjectInfo, SavedCommand, SessionInfo, StoredMessage, ToolDefaults } from '@cc/protocol'
import { APP_SETTINGS_DDL, type MigrationStep } from './store/migrations/context.js'
import { migrationSteps } from './store/migrations/index.js'
import { indexedText } from './store/search-index.js'
import { mb, type VacuumDone } from './store/vacuum.js'
import { GridSpan, Interruption as InterruptionSchema, ProjectConsentKind as ProjectConsentKindSchema, sessionLiveDefaults } from '@cc/protocol'

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
/** A request held for a busy session until its turn ends (#677, `queued_requests`) */
export type QueuedRequest = {
  id: string
  sessionId: string
  callerSessionId: string
  via: 'ask_project' | 'agent_session' | 'send_to_session'
  text: string
  queuedAt: number
  /** When delivery began, until the session's turn starts (#684 review); null while it waits */
  deliveringAt?: number | null
  /**
   * An ask_project request that passed only because its requester was `auto`, with no remembered consent for the pair
   * (v54): delivered only while the requester still is, or the pair has consent by then. Null in a row an older build
   * wrote, which does not say.
   */
  openedByAuto?: boolean | null
}

export class Store {
  private db: Database.Database

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
   * The steps below still **have to be written idempotently.** A new database starts at 0 and
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
      checkpoint: () => this.checkpoint(),
    })
  }

  get schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number
  }

  close() {
    this.checkpoint()
    this.db.close()
  }

  /**
   * `trusted` is the trust a NEW row starts with (#655); absent means untrusted, as before. It is an insert-only
   * value: registering a path that already has a row renames it and leaves its trust alone, so neither an earlier
   * "no" nor a later "yes" is overwritten by a second registration.
   */
  addProject(p: { id: string; path: string; name: string; trusted?: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, path, name, created_at, trusted) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name`,
      )
      .run(p.id, p.path, p.name, Date.now(), p.trusted ? 1 : 0)
  }

  /**
   * `commands` is deliberately not in here (issue #44) — `projectCommands` answers that one.
   *
   * The column holds JSON, so it needs decoding, and every caller of this method wants a
   * path or a name. Leaving it out of the row type means the omission is stated rather than
   * silently cast away, which is how `Omit<ProjectInfo, 'git'>` would have become a lie the
   * moment the field was added.
   */
  listProjects(): Omit<ProjectInfo, 'git' | 'commands' | 'defaultModels'>[] {
    const rows = this.db
      .prepare(
        `SELECT id, path, name, default_tool as defaultTool, trusted FROM projects ORDER BY sidebar_order, created_at`,
      )
      .all() as (Omit<ProjectInfo, 'git' | 'commands' | 'defaultModels' | 'trusted'> & { trusted: number })[]
    // SQLite has no boolean — passing 0/1 straight through would still satisfy `if (p.trusted)` on screen, but fail schema validation
    return rows.map((r) => ({ ...r, trusted: r.trusted === 1 }))
  }

  /**
   * The shell commands saved on a project (issue #44).
   *
   * Unreadable JSON reads as "none". A row that somehow got corrupted must not take the
   * project list — and with it the sidebar — down with it; the worst it can cost is a menu
   * you have to fill in again.
   */
  projectCommands(projectId: string): SavedCommand[] {
    const row = this.db.prepare(`SELECT commands FROM projects WHERE id = ?`).get(projectId) as
      { commands: string } | undefined
    if (!row) return []
    try {
      const parsed = JSON.parse(row.commands) as unknown
      if (!Array.isArray(parsed)) return []
      // Old rows are an array of strings (before labels, ~2026-09-06) — upgraded on read, and the next save fixes the new shape
      return parsed.flatMap((c): SavedCommand[] => {
        if (typeof c === 'string') return [{ command: c }]
        if (c && typeof c === 'object' && typeof (c as { command?: unknown }).command === 'string') {
          const label = (c as { label?: unknown }).label
          return [{ command: (c as { command: string }).command, ...(typeof label === 'string' && label ? { label } : {}) }]
        }
        return []
      })
    } catch {
      return []
    }
  }

  /** The whole list at once — add and delete both arrive here as "it looks like this now" */
  setProjectCommands(projectId: string, commands: readonly SavedCommand[]): void {
    this.db.prepare(`UPDATE projects SET commands = ? WHERE id = ?`).run(JSON.stringify(commands), projectId)
  }

  /**
   * The worktree provisioning setup (#69). null means nothing runs — it is not enforced.
   * The same rule as projectCommands: read whole, written whole.
   */
  worktreeSetup(projectId: string): { command: string; copyFiles: string[] } | null {
    const row = this.db.prepare(`SELECT worktree_setup FROM projects WHERE id = ?`).get(projectId) as
      { worktree_setup: string | null } | undefined
    if (!row?.worktree_setup) return null
    try {
      const parsed = JSON.parse(row.worktree_setup) as { command?: unknown; copyFiles?: unknown }
      const command = typeof parsed.command === 'string' ? parsed.command : ''
      const copyFiles = Array.isArray(parsed.copyFiles)
        ? parsed.copyFiles.filter((f): f is string => typeof f === 'string')
        : []
      if (!command && copyFiles.length === 0) return null
      return { command, copyFiles }
    } catch {
      return null
    }
  }

  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): void {
    this.db
      .prepare(`UPDATE projects SET worktree_setup = ? WHERE id = ?`)
      .run(setup ? JSON.stringify(setup) : null, projectId)
  }

  /**
   * This project's worktree manager slot and trunk (#76).
   *
   * **This does not check whether the session it points at actually still exists** — that is
   * the job of the side that knows sessions (SessionManager); the store just hands back what
   * it was told to write down. Putting the "is this link broken" judgment (session deleted or
   * archived) in two places would let the two places disagree.
   */
  worktreeManager(projectId: string): { sessionId: string; baseBranch: string } | null {
    const row = this.db.prepare(`SELECT worktree_manager FROM projects WHERE id = ?`).get(projectId) as
      { worktree_manager: string | null } | undefined
    if (!row?.worktree_manager) return null
    try {
      const parsed = JSON.parse(row.worktree_manager) as { sessionId?: unknown; baseBranch?: unknown }
      if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null
      return {
        sessionId: parsed.sessionId,
        baseBranch: typeof parsed.baseBranch === 'string' ? parsed.baseBranch : '',
      }
    } catch {
      return null
    }
  }

  /**
   * The project's worktree trunk (#76), from the same row as the former manager slot (#561 part 3): read whatever the
   * slot's session, since the trunk is the project's and no longer a manager's. Empty or unreadable: none.
   */
  worktreeTrunk(projectId: string): string | null {
    const row = this.db.prepare(`SELECT worktree_manager FROM projects WHERE id = ?`).get(projectId) as
      { worktree_manager: string | null } | undefined
    if (!row?.worktree_manager) return null
    try {
      const parsed = JSON.parse(row.worktree_manager) as { baseBranch?: unknown }
      return typeof parsed.baseBranch === 'string' && parsed.baseBranch ? parsed.baseBranch : null
    } catch {
      return null
    }
  }

  /**
   * Sets the trunk, keeping the slot's session id when there is one, so an older build still finds the manager it made
   * there (agent-host.md §5.1: the shape is expanded, not changed)
   */
  setWorktreeTrunk(projectId: string, baseBranch: string): void {
    this.setWorktreeManager(projectId, { sessionId: this.worktreeManager(projectId)?.sessionId ?? '', baseBranch })
  }

  setWorktreeManager(projectId: string, manager: { sessionId: string; baseBranch: string } | null): void {
    this.db
      .prepare(`UPDATE projects SET worktree_manager = ? WHERE id = ?`)
      .run(manager ? JSON.stringify(manager) : null, projectId)
  }

  /**
   * The tool a new session in this project starts on.
   *
   * Written when a session is created with an explicit tool, not from a settings screen:
   * the column was set to 'claude' at project creation and never updated again, so a Codex
   * user re-picked the pill on every single new session, forever.
   */
  setProjectDefaultTool(projectId: string, tool: string): void {
    this.db.prepare(`UPDATE projects SET default_tool = ? WHERE id = ?`).run(tool, projectId)
  }

  /**
   * The last model and effort chosen becomes the default (#69 finding 5) — but **per tool**
   * (#107).
   *
   * Read whole and written whole, the same rule as projectCommands. Unparsable JSON reads as
   * "none": the cost of losing one remembered value is a click, while throwing here would take
   * the project list — and with it the sidebar — down with it.
   */
  projectToolDefaults(projectId: string): Record<string, ToolDefaults> {
    const row = this.db.prepare(`SELECT default_models FROM projects WHERE id = ?`).get(projectId) as
      { default_models: string | null } | undefined
    if (!row?.default_models) return {}
    try {
      const parsed = JSON.parse(row.default_models) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, ToolDefaults> = {}
      for (const [tool, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue
        const { model, effort } = v as { model?: unknown; effort?: unknown }
        out[tool] = {
          model: typeof model === 'string' && model ? model : null,
          effort: typeof effort === 'string' && effort ? effort : null,
        }
      }
      return out
    } catch {
      return {}
    }
  }

  /** Only one tool's slot is rewritten — another tool's remembered value has nothing to do with this choice (#107) */
  setProjectToolDefaults(projectId: string, tool: string, d: ToolDefaults): void {
    const all = { ...this.projectToolDefaults(projectId), [tool]: d }
    this.db.prepare(`UPDATE projects SET default_models = ? WHERE id = ?`).run(JSON.stringify(all), projectId)
  }

  /**
   * The projects the app runtime sees — root path and trust (M4 A-2).
   *
   * Worktrees are not here. A worktree is a copy of a project, not a project, and if an app
   * instance stood up per copy, the same app would end up running multiple times over a single
   * data folder — the app only reads from a registered root (plan A-2).
   */
  projectRoots(): { id: string; path: string; trusted: boolean }[] {
    const rows = this.db
      .prepare(`SELECT id, path, trusted FROM projects ORDER BY sidebar_order, created_at`)
      .all() as { id: string; path: string; trusted: number }[]
    return rows.map((r) => ({ id: r.id, path: r.path, trusted: r.trusted === 1 }))
  }

  /** @returns whether the project existed — this does not silently succeed on an unknown id */
  setProjectTrusted(projectId: string, trusted: boolean): boolean {
    return this.db.prepare(`UPDATE projects SET trusted = ? WHERE id = ?`).run(trusted ? 1 : 0, projectId).changes > 0
  }

  findProjectByPath(path: string): { id: string } | undefined {
    return this.db.prepare(`SELECT id FROM projects WHERE path = ?`).get(path) as { id: string } | undefined
  }

  /**
   * The UPDATE clause has to list **everything that can change.**
   * It used to be missing tool, so switching agents (claude to codex) was never saved — on
   * restart the tool reverted, but by then the thread to resume from (external_id) had already
   * broken, turning the session into one that could not even be recovered. (project_id and
   * created_at do not change, by definition.)
   */
  upsertSession(s: SessionInfo): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, tool, external_id, name, auto_named, state, is_orchestrator, last_read_seq, waiting_since, created_at, model, effort, verbosity, service_tier, permission_preset, imported_from, worktree_path, worktree_branch, worktree_base, parent_session_id, scope_session_ids, role_append, app_id, asked_by_session_id, forked_from_session_id, context_used, context_window, context_exactness, interruption)
         VALUES (@id, @projectId, @tool, @externalId, @name, @autoNamed, @state, @isOrchestrator, @lastReadSeq, @waitingSince, @createdAt, @model, @effort, @verbosity, @serviceTier, @permissionPreset, @importedFrom, @worktreePath, @worktreeBranch, @worktreeBase, @parentSessionId, @scopeSessionIds, @roleAppend, @appId, @askedBy, @forkedFrom, @contextUsed, @contextWindow, @contextExactness, @interruption)
         ON CONFLICT(id) DO UPDATE SET
           tool = excluded.tool,
           external_id = excluded.external_id, name = excluded.name, auto_named = excluded.auto_named,
           state = excluded.state, last_read_seq = excluded.last_read_seq,
           is_orchestrator = excluded.is_orchestrator,
           waiting_since = excluded.waiting_since, model = excluded.model, effort = excluded.effort,
           verbosity = excluded.verbosity,
           service_tier = excluded.service_tier,
           permission_preset = excluded.permission_preset, imported_from = excluded.imported_from,
           worktree_path = excluded.worktree_path, worktree_branch = excluded.worktree_branch,
           worktree_base = excluded.worktree_base,
           parent_session_id = excluded.parent_session_id,
           scope_session_ids = excluded.scope_session_ids,
           role_append = excluded.role_append,
           app_id = excluded.app_id,
           asked_by_session_id = excluded.asked_by_session_id,
           forked_from_session_id = excluded.forked_from_session_id,
           context_used = excluded.context_used, context_window = excluded.context_window,
           context_exactness = excluded.context_exactness,
           interruption = excluded.interruption`,
      )
      .run({
        ...s,
        autoNamed: s.autoNamed ? 1 : 0,
        // The marker (#13) rides the ordinary upsert too — with two write paths, only one would end up fixed
        isOrchestrator: s.kind === 'orchestrator' ? 1 : 0,
        effort: s.effort ?? null,
        verbosity: s.verbosity ?? null,
        serviceTier: s.serviceTier ?? null,
        importedFrom: s.importedFrom ?? null,
        worktreePath: s.worktree?.path ?? null,
        worktreeBranch: s.worktree?.branch ?? null,
        worktreeBase: s.worktree?.base ?? null,
        parentSessionId: s.parentSessionId ?? null,
        // Visibility is flattened into a JSON array (#80, #81) — the relationship lives in the row (lesson of the orphan)
        scopeSessionIds: s.scopeSessionIds ? JSON.stringify(s.scopeSessionIds) : null,
        roleAppend: s.roleAppend ?? null,
        appId: s.appId ?? null,
        askedBy: s.askedBy ?? null,
        forkedFrom: s.forkedFrom ?? null,
        /*
         * Context rides the ordinary upsert (issue #48), which the manager already runs after
         * every event — so a reading is on disk the instant it arrives, with no second write
         * path to remember. Saving at session close instead would lose exactly the sessions
         * that matter: the ones a crash or a force-quit ends.
         */
        contextUsed: s.context?.used ?? null,
        contextWindow: s.context?.window ?? null,
        contextExactness: s.context?.exactness ?? null,
        // `reconnecting` describes the running process and is not kept (#698)
        interruption: s.interruption && s.interruption.reason !== 'reconnecting' ? JSON.stringify(s.interruption) : null,
      })
  }

  /**
   * Saves the sidebar order.
   *
   * **The whole order is taken and renumbered from scratch.** Touching only the neighboring
   * items in a "move this after that" way would eventually need a reshuffle once the values
   * get packed too tight, and would drift if the list changed in between. The list is short
   * (it is a sidebar a person looks at), so rewriting all of it is simple and safe.
   */
  setProjectOrder(orderedIds: readonly string[]): void {
    const stmt = this.db.prepare(`UPDATE projects SET sidebar_order = ? WHERE id = ?`)
    this.db.transaction(() => orderedIds.forEach((id, i) => stmt.run(i, id)))()
  }

  setSessionOrder(orderedIds: readonly string[]): void {
    const stmt = this.db.prepare(`UPDATE sessions SET sidebar_order = ? WHERE id = ?`)
    this.db.transaction(() => orderedIds.forEach((id, i) => stmt.run(i, id)))()
  }

  /**
   * The grid layout — sessions and apps, in the order the panels were placed (#288).
   *
   * A session panel shows only while its session is live: `trashSession` takes the panel away, and the join keeps a
   * panel written by an older build out of the grid too. An app panel shows while its project is registered (a
   * user-folder app has none); `deleteProject` takes its panels away, and the join covers a row it missed. Whether the
   * app itself still exists is not asked here — the app list is read from folders, it can lag behind, and the screen
   * leaves out an app it cannot find without the list losing its place.
   */
  listGridView(): GridPanel[] {
    const rows = this.db
      .prepare(
        `SELECT g.kind, COALESCE(g.session_id, g.remote_session_id) AS session_id, g.project_id,
                COALESCE(g.app_id, g.remote_app_id) AS app_id, g.app_machine, g.span_cols, g.span_rows
           FROM grid_layout g
           LEFT JOIN sessions s ON g.kind = 'session' AND s.id = g.session_id
           LEFT JOIN projects p ON g.kind = 'app' AND p.id = g.project_id
          WHERE (g.kind = 'session' AND s.id IS NOT NULL AND s.deleted_at IS NULL)
             OR (g.kind = 'session' AND g.session_id IS NULL AND g.remote_session_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM machine_headers h
                   WHERE h.kind = 'session' AND h.machine_id || '.' || h.item_id = g.remote_session_id))
             OR (g.kind = 'app' AND g.app_id IS NOT NULL AND (g.project_id IS NULL OR p.id IS NOT NULL))
             OR (g.kind = 'app' AND g.app_id IS NULL AND g.remote_app_id IS NOT NULL
                 AND EXISTS (SELECT 1 FROM linked_machines m WHERE m.id = g.app_machine)
                 AND (g.project_id IS NULL OR EXISTS (
                  SELECT 1 FROM machine_headers h
                   WHERE h.kind = 'project' AND h.machine_id = g.app_machine AND h.machine_id || '.' || h.item_id = g.project_id)))
          ORDER BY g.position`,
      )
      .all() as {
      kind: string
      session_id: string | null
      project_id: string | null
      app_id: string | null
      app_machine: string | null
      span_cols: number | null
      span_rows: number | null
    }[]
    return rows.map((r) => {
      if (r.kind === 'session') return { kind: 'session' as const, sessionId: r.session_id! }
      // A span is kept only whole: a row with one half, or a value outside the protocol's bounds, reads as none chosen
      const span = GridSpan.safeParse({ cols: r.span_cols, rows: r.span_rows })
      return {
        kind: 'app' as const,
        projectId: r.project_id,
        appId: r.app_id!,
        // A linked machine's user-folder app names its machine; a project app's qualified id already does (#82)
        ...(r.app_machine && r.project_id === null ? { machine: r.app_machine } : {}),
        ...(span.success ? { span: span.data } : {}),
      }
    })
  }

  /**
   * Rewrites the layout whole.
   *
   * Adding, removing and reordering all arrive as this one call, so deleting and reinserting
   * is the simplest approach. The list is short (a screen a person looks at), and being one
   * transaction means no intermediate state is ever visible. A panel named twice keeps its first
   * place (`panel_key` is the primary key).
   */
  setGridView(
    panels: readonly GridPanel[],
    remote: (sessionId: string) => boolean = () => false,
    /** The linked machine an app panel's app is on (#82), or null for this host's own */
    appMachine: (panel: Extract<GridPanel, { kind: 'app' }>) => string | null = () => null,
  ): void {
    const del = this.db.prepare(`DELETE FROM grid_layout`)
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO grid_layout (panel_key, kind, session_id, project_id, app_id, position, span_cols, span_rows)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // Another machine's session is not in `sessions`, so it goes in a column without the reference (v46, #82)
    const insRemote = this.db.prepare(
      `INSERT OR IGNORE INTO grid_layout (panel_key, kind, session_id, remote_session_id, position) VALUES (?, 'session', NULL, ?, ?)`,
    )
    // Another machine's app keeps `app_id` empty, so a host from before v47 never reads it as its own (v47, #82)
    const insRemoteApp = this.db.prepare(
      `INSERT OR IGNORE INTO grid_layout (panel_key, kind, session_id, project_id, app_id, remote_app_id, app_machine, position, span_cols, span_rows)
       VALUES (?, 'app', NULL, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    this.db.transaction(() => {
      del.run()
      panels.forEach((p, i) => {
        if (p.kind === 'session' && remote(p.sessionId)) insRemote.run(`session:${p.sessionId}`, p.sessionId, i)
        else if (p.kind === 'session') ins.run(`session:${p.sessionId}`, 'session', p.sessionId, null, null, i, null, null)
        else {
          const machine = appMachine(p)
          if (machine) {
            // The UI's key (`gridPanelKey`): a machine's user-folder app names the machine, a project app its qualified project
            const key = p.projectId ? `app:${p.projectId}/${p.appId}` : `app:${machine}:_user/${p.appId}`
            insRemoteApp.run(key, p.projectId, p.appId, machine, i, p.span?.cols ?? null, p.span?.rows ?? null)
            return
          }
          const key = `app:${p.projectId ?? '_user'}/${p.appId}`
          ins.run(key, 'app', null, p.projectId, p.appId, i, p.span?.cols ?? null, p.span?.rows ?? null)
        }
      })
    })()
  }

  /**
   * The id of the **central** orchestrator (null if there is none).
   *
   * There used to be only one orchestrator per app, so this query was the whole answer. Once
   * project orchestrators existed (#13), the marker (is_orchestrator=1) could be set on more
   * than one row, and the central one is whichever of those has no project. The marker itself
   * rides SessionInfo.kind through the ordinary upsert — at one point this was the only place
   * that answered, on the reasoning that "keeping it in two places lets one drift out of sync,"
   * but the project orchestrator broke the premise that reasoning relied on (that projectId
   * being null was the same fact as the marker), so kind is now the single source of truth and
   * this query just reads it.
   */
  orchestratorId(): string | null {
    /*
     * A trashed session has no project (see `trashSession`), so without the filter a trashed project orchestrator
     * would answer here as the central one.
     */
    const row = this.db
      .prepare(`SELECT id FROM sessions WHERE is_orchestrator = 1 AND project_id IS NULL AND deleted_at IS NULL LIMIT 1`)
      .get() as { id: string } | undefined
    return row?.id ?? null
  }

  /** Live sessions only — the trash (#204) is listed by `listTrash` and nowhere else */
  listSessions(): SessionInfo[] {
    return this.readSessions(`s.deleted_at IS NULL`)
  }

  /** The rows of `listSessions`, for any condition on `sessions s` — the one place a row becomes a `SessionInfo` */
  private readSessions(where: string, ...params: unknown[]): SessionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.project_id as projectId, s.tool, s.external_id as externalId, s.name,
                s.auto_named as autoNamed, s.state, s.is_orchestrator as isOrchestrator,
                s.last_read_seq as lastReadSeq,
                s.waiting_since as waitingSince, s.created_at as createdAt,
                s.model, s.effort, s.verbosity, s.service_tier as serviceTier, s.permission_preset as permissionPreset, s.imported_from as importedFrom,
                s.worktree_path as worktreePath, s.worktree_branch as worktreeBranch,
                s.worktree_base as worktreeBase,
                s.parent_session_id as parentSessionId,
                s.scope_session_ids as scopeSessionIdsJson, s.role_append as roleAppend, s.app_id as appId,
                s.asked_by_session_id as askedBy,
                s.forked_from_session_id as forkedFrom,
                s.context_used as contextUsed, s.context_window as contextWindow,
                s.context_exactness as contextExactness,
                s.interruption as interruptionJson,
                COALESCE((SELECT MAX(seq) FROM messages m WHERE m.session_id = s.id), 0) as lastSeq
         FROM sessions s WHERE ${where} ORDER BY s.sidebar_order, s.created_at`,
      )
      .all(...params) as (Omit<SessionInfo, 'autoNamed' | 'worktree' | 'kind'> & {
      autoNamed: number
      isOrchestrator: number
      worktreePath: string | null
      worktreeBranch: string | null
      worktreeBase: string | null
      contextUsed: number | null
      contextWindow: number | null
      contextExactness: string | null
      scopeSessionIdsJson: string | null
      interruptionJson: string | null
    })[]
    // Live-only fields are not in the database — a restored session correctly has none of them (facts that die with the host)
    return rows.map(
      ({
        worktreePath,
        worktreeBranch,
        worktreeBase,
        contextUsed,
        contextWindow,
        contextExactness,
        isOrchestrator,
        scopeSessionIdsJson,
        interruptionJson,
        ...r
      }) => ({
        ...r,
        autoNamed: !!r.autoNamed,
        /*
         * Whether a session coordinates is also relational (#80, #81): having a visibility list
         * makes it a coordinating session — a separate marker column would eventually drift out
         * of sync with the relationship it is meant to reflect (the lesson of #13).
         */
        kind: isOrchestrator
          ? ('orchestrator' as const)
          : scopeSessionIdsJson
            ? ('coordinator' as const)
            : ('worker' as const),
        scopeSessionIds: scopeSessionIdsJson ? (JSON.parse(scopeSessionIdsJson) as string[]) : null,
        live: false,
        worktree: worktreePath
          ? {
              path: worktreePath,
              branch: worktreeBranch ?? '',
              ...(worktreeBase ? { base: worktreeBase } : {}),
            }
          : null,
        ...sessionLiveDefaults(),
        /*
         * **Context is the one that comes back** (issue #48), so it overrules the defaults above.
         *
         * The rest of that group are facts about *our* process — a request id nobody can answer
         * any more, a rate-limit window that expired while we were gone — and are rightly gone
         * with it. How full the context is, is not: it is a fact about the conversation, and the
         * conversation is the tool's and outlives us.
         *
         * It is shown plainly, with no staleness mark, and that is a decision rather than an
         * omission. The gauge has never claimed to be live — the reading arrives at the end of a
         * turn and is already a turn behind while the next one runs; restarting only lengthens a
         * gap that is always there. The event that really makes it wrong is the conversation
         * moving without us (someone continuing it in the terminal), which can happen with or
         * without a restart and which we cannot detect either way. A mark keyed on "we
         * restarted" would therefore flag the common case, where nothing moved and the number is
         * exact, and stay silent in the case that actually earns it. The first turn corrects it
         * regardless — at the very instant the old behaviour would have shown anything at all.
         */
        context:
          contextUsed !== null && contextWindow !== null
            ? {
                used: contextUsed,
                window: contextWindow,
                // Only the adapter can claim 'exact'; anything we cannot read back says 'estimate'
                exactness: contextExactness === 'exact' ? ('exact' as const) : ('estimate' as const),
              }
            : null,
        // Why the last turn did not finish (#698); a value this build cannot read is no interruption rather than a lost row
        interruption: readInterruption(interruptionJson),
      }),
    )
  }

  /**
   * Handoff notes that still **have an owner** — predecessor ids that a live session has
   * recorded inheriting (#106).
   *
   * The note's file name is the predecessor's id (#104). So "the predecessor is gone, so its
   * note can go too" is **wrong**: the last step of a handoff is deleting the predecessor
   * itself, and at that moment the successor has not even opened the note yet. Only the
   * successor's marker knows which file it inherited, so that is where cleanup has to get its
   * evidence.
   *
   * What the JOIN buys: a marker whose session is gone disappears along with it — a dead
   * session cannot hold on to a note.
   */
  handoffPredecessors(): Set<string> {
    /*
     * A successor in the trash still claims its note (#204): restoring it must find the note it was handed, so
     * only deleting it for good lets the note go.
     */
    const rows = this.db
      .prepare(
        `/* includes the trash: a trashed successor keeps its note */
         SELECT m.payload as payload FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.kind = 'marker'`,
      )
      .all() as { payload: string }[]
    const out = new Set<string>()
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as { type?: unknown; fromSessionId?: unknown }
        if (p.type === 'handoff' && typeof p.fromSessionId === 'string' && p.fromSessionId) out.add(p.fromSessionId)
      } catch {
        // A row that cannot be parsed claims nothing — cleanup only holds off when there is a claim
      }
    }
    return out
  }

  /**
   * The sessions that inherited a handoff from this one (#738), newest first, trashed ones included with their mark:
   * where a removed session's remaining children go. The same evidence as above, the successor's handoff marker.
   */
  handoffHeirs(fromSessionId: string): { sessionId: string; trashed: boolean }[] {
    /*
     * Filtered in SQL (#740 review): a handoff marker carries its whole note, megabytes, and this runs on every delete.
     * The CASE keeps a row that is not valid JSON from failing the query; it names no heir.
     */
    const rows = this.db
      .prepare(
        `SELECT m.session_id as sessionId, MAX(m.ts) as ts, s.deleted_at IS NOT NULL as trashed
           FROM messages m JOIN sessions s ON s.id = m.session_id
          WHERE m.kind = 'marker'
            AND CASE WHEN json_valid(m.payload)
                  THEN json_extract(m.payload, '$.type') = 'handoff' AND json_extract(m.payload, '$.fromSessionId') = ?
                  ELSE 0 END
          GROUP BY m.session_id ORDER BY ts DESC`,
      )
      .all(fromSessionId) as { sessionId: string; trashed: number }[]
    return rows.map((r) => ({ sessionId: r.sessionId, trashed: !!r.trashed }))
  }

  /**
   * Whether this session already has a stored notice with this text (#304) — so a notice the tool repeats on every
   * start (`oncePerSession`, Codex's configuration warnings) is kept once. Only marker rows are read, and a session has
   * a handful of those; the text is compared after parsing, as stored.
   */
  hasNotice(sessionId: string, text: string): boolean {
    const rows = this.db
      .prepare(`SELECT payload FROM messages WHERE session_id = ? AND kind = 'marker'`)
      .all(sessionId) as { payload: string }[]
    return rows.some((r) => {
      try {
        const p = JSON.parse(r.payload) as { type?: unknown; text?: unknown }
        return p.type === 'notice' && p.text === text
      } catch {
        return false
      }
    })
  }

  /**
   * Whether this session inherited a handoff (#142) — asked so that waking it can reopen access to the notes
   * folder it can read from. The same test as above: a handoff marker carrying `fromSessionId`. A session only
   * ever has a handful of markers, so only those are read.
   */
  inheritsHandoff(sessionId: string): boolean {
    const rows = this.db
      .prepare(`SELECT payload FROM messages WHERE session_id = ? AND kind = 'marker'`)
      .all(sessionId) as { payload: string }[]
    return rows.some((r) => {
      try {
        const p = JSON.parse(r.payload) as { type?: unknown; fromSessionId?: unknown }
        return p.type === 'handoff' && typeof p.fromSessionId === 'string' && !!p.fromSessionId
      } catch {
        return false
      }
    })
  }

  // ── The trash (#204) ──
  //
  // Deleting a session moves it here; only Settings removes it for good. While it is here its rows stay as they
  // were, except its search index, which is dropped: no search and no agent's `recall` can reach it, and the index is
  // the larger half of the store (71MB of 137MB, measured for #96). Restoring rebuilds the index from the messages.

  /**
   * Moves a live session into the trash. `record` carries where it came from and what the person chose to remove
   * with it once it is deleted for good. Returns false when there was no live session to move.
   *
   * The session leaves every listing in the first transaction: `deleted_at` is set before anything slow runs. It
   * also leaves its project: `project_id` becomes NULL and the project is kept in `record`. That is what lets a
   * project be deleted while its sessions sit in the trash — `sessions.project_id` cascades a project delete (FK), so
   * a session still pointing at the project would be destroyed with it. The grid panel goes too: it is layout, not a
   * record, and a restored session is opened from the sidebar.
   *
   * The index rows are then dropped in chunks, letting the event loop go between them (#179: the biggest session in
   * a copy of the real store held 32,323 index rows, and dropping them in one transaction froze the host for 2.9s).
   * If the host stops halfway, the session is in the trash with part of its index left; searches still skip it
   * (`searchMessages` filters the trash), and restoring or purging finishes the job.
   */
  async trashSession(sessionId: string, record: TrashRecord, chunk = DELETE_CHUNK): Promise<boolean> {
    const move = this.db.transaction((): boolean => {
      const moved = this.db
        .prepare(`UPDATE sessions SET deleted_at = ?, trash = ?, project_id = NULL WHERE id = ? AND deleted_at IS NULL`)
        .run(Date.now(), JSON.stringify(record), sessionId).changes
      if (moved === 0) return false
      // Both lists: this build's, and the one an older host still reads (v42)
      this.db.prepare(`DELETE FROM grid_panels WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM grid_layout WHERE session_id = ?`).run(sessionId)
      return true
    })
    if (!move()) return false
    const dropFts = this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`)
    await this.walkMessages(sessionId, chunk, false, (rows) => {
      for (const r of rows) dropFts.run(r.rowid)
    })
    return true
  }

  /**
   * Takes a session out of the trash into `projectId` (null for one that had no project). Returns null when it was
   * not in the trash.
   *
   * The index is rebuilt first, in chunks, and the session becomes live only in the last step. A restore cut short
   * therefore leaves it in the trash with part of its index, which the search filter hides and the next restore
   * overwrites (the index row is keyed by the message's rowid, so writing it again replaces it).
   */
  async restoreSession(sessionId: string, projectId: string | null, chunk = DELETE_CHUNK): Promise<SessionInfo | null> {
    if (!this.isTrashed(sessionId)) return null
    const put = this.db.prepare(`INSERT OR REPLACE INTO messages_fts (rowid, body, session_id, seq) VALUES (?, ?, ?, ?)`)
    const drop = this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`)
    await this.walkMessages(sessionId, chunk, true, (rows) => {
      for (const r of rows) {
        const body = indexedText(r.kind ?? '', r.payload ?? '')
        if (body) put.run(r.rowid, body, sessionId, r.seq)
        else drop.run(r.rowid)
      }
    })
    const back = this.db
      .prepare(`UPDATE sessions SET deleted_at = NULL, trash = NULL, project_id = ? WHERE id = ? AND deleted_at IS NOT NULL`)
      .run(projectId, sessionId).changes
    if (back === 0) return null
    return this.readSessions(`s.id = ? AND s.deleted_at IS NULL`, sessionId)[0] ?? null
  }

  /**
   * Deletes a session in the trash for good. It is the only way a session's rows leave the store, and it takes only
   * a session already in the trash: a live one has to be moved there first, so nothing skips the way back.
   *
   * Everything that points at the session goes with it: its messages and whatever is left of their index, the steps
   * of the subagents it launched (`subagent_messages`, #222), its approval rules, its commit links (`commit_sessions` — #96 found 57 of 304 links pointing at sessions that no
   * longer existed, because deleting used to leave them behind), and the app runs it started or ran in
   * (`app_runs.session_id` / `caller_session_id`, with their kept failures).
   *
   * Chunked like `trashSession` (#179: on the same copy of the real store the longest pause went from 2.9s to 84ms;
   * the whole took 4.1s, with the event loop turning 231 times). The rows that are not messages, and the session row, go in the same
   * transaction as the last chunk, so a purge cut short leaves the session in the trash with fewer messages, to be
   * purged again, and never messages without a session.
   */
  async purgeSession(sessionId: string, chunk = DELETE_CHUNK): Promise<boolean> {
    if (!this.isTrashed(sessionId)) return false
    const pick = this.db.prepare(`SELECT rowid FROM messages WHERE session_id = ? LIMIT ?`)
    const dropFts = this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`)
    const dropMsg = this.db.prepare(`DELETE FROM messages WHERE rowid = ?`)
    // A subagent's steps (#222) go first, in the same chunks: they can outnumber the conversation's own rows
    const pickSub = this.db.prepare(`SELECT rowid FROM subagent_messages WHERE session_id = ? LIMIT ?`)
    const dropSub = this.db.prepare(`DELETE FROM subagent_messages WHERE rowid = ?`)
    const step = this.db.transaction((): boolean => {
      const subs = pickSub.all(sessionId, chunk) as { rowid: number }[]
      for (const { rowid } of subs) dropSub.run(rowid)
      if (subs.length === chunk) return false
      const rows = pick.all(sessionId, chunk) as { rowid: number }[]
      for (const { rowid } of rows) {
        dropFts.run(rowid)
        dropMsg.run(rowid)
      }
      if (rows.length === chunk) return false
      this.db.prepare(`DELETE FROM approval_rules WHERE session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM commit_sessions WHERE session_id = ?`).run(sessionId)
      this.db
        .prepare(`DELETE FROM app_run_failures WHERE run_id IN (SELECT id FROM app_runs WHERE session_id = ? OR caller_session_id = ?)`)
        .run(sessionId, sessionId)
      this.db.prepare(`DELETE FROM app_runs WHERE session_id = ? OR caller_session_id = ?`).run(sessionId, sessionId)
      this.db.prepare(`DELETE FROM report_marks WHERE session_id = ? OR caller_session_id = ?`).run(sessionId, sessionId)
      this.db.prepare(`DELETE FROM agent_start_requests WHERE caller_session_id = ?`).run(sessionId)
      this.db.prepare(`DELETE FROM delegated_turns WHERE session_id = ? OR caller_session_id = ?`).run(sessionId, sessionId)
      this.db.prepare(`DELETE FROM queued_requests WHERE session_id = ? OR caller_session_id = ?`).run(sessionId, sessionId)
      this.db.prepare(`DELETE FROM sessions WHERE id = ? AND deleted_at IS NOT NULL`).run(sessionId)
      return true
    })
    while (!step()) await new Promise<void>((resolve) => setImmediate(resolve))
    return true
  }

  /** One session's messages in seq order, one transaction per chunk, letting the event loop go between chunks (#179) */
  private async walkMessages(
    sessionId: string,
    chunk: number,
    withPayload: boolean,
    each: (rows: { rowid: number; seq: number; kind?: string; payload?: string }[]) => void,
  ): Promise<void> {
    const pick = this.db.prepare(
      `SELECT rowid, seq${withPayload ? ', kind, payload' : ''} FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    )
    let after = Number.MIN_SAFE_INTEGER
    const step = this.db.transaction((): boolean => {
      const rows = pick.all(sessionId, after, chunk) as { rowid: number; seq: number; kind?: string; payload?: string }[]
      each(rows)
      if (rows.length > 0) after = rows[rows.length - 1]!.seq
      return rows.length < chunk
    })
    while (!step()) await new Promise<void>((resolve) => setImmediate(resolve))
  }

  isTrashed(sessionId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sessions WHERE id = ? AND deleted_at IS NOT NULL`).get(sessionId)
  }

  /** The ids in the trash — for the few callers that must tell "in the trash" from "gone" */
  trashedIds(): Set<string> {
    const rows = this.db.prepare(`SELECT id FROM sessions WHERE deleted_at IS NOT NULL`).all() as { id: string }[]
    return new Set(rows.map((r) => r.id))
  }

  /** A session in the trash as it will come back, with its record — null when it is not in the trash */
  trashedSession(sessionId: string): { session: SessionInfo; record: TrashRecord; deletedAt: number } | null {
    const session = this.readSessions(`s.id = ? AND s.deleted_at IS NOT NULL`, sessionId)[0]
    if (!session) return null
    const row = this.db.prepare(`SELECT deleted_at as deletedAt, trash FROM sessions WHERE id = ?`).get(sessionId) as {
      deletedAt: number
      trash: string | null
    }
    return { session, record: parseTrashRecord(row.trash), deletedAt: row.deletedAt }
  }

  /**
   * What is in the trash, most recently deleted first, with how much of the store each one holds: the bytes of its
   * messages (the index is already gone). Settings shows the total, because nothing empties the trash on its own.
   * Measured on a copy of the real store (135,828 messages): summing every session's messages takes about 40ms.
   */
  listTrash(): TrashedRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.name, s.tool, s.deleted_at as deletedAt, s.trash as trash,
                s.worktree_path as worktreePath, s.worktree_branch as worktreeBranch,
                (s.external_id IS NOT NULL OR s.imported_from IS NOT NULL) as hasConversationFile,
                COUNT(m.seq) as messages,
                COALESCE(SUM(LENGTH(CAST(m.payload AS BLOB))), 0)
                  /* a subagent's steps (#222) are part of what it holds, though not of its message count */
                  + COALESCE((SELECT SUM(LENGTH(CAST(sm.payload AS BLOB))) FROM subagent_messages sm WHERE sm.session_id = s.id), 0) as bytes
         FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
         WHERE s.deleted_at IS NOT NULL GROUP BY s.id ORDER BY s.deleted_at DESC`,
      )
      .all() as (Omit<TrashedRow, 'record' | 'worktree' | 'hasConversationFile'> & {
      hasConversationFile: number
      trash: string | null
      worktreePath: string | null
      worktreeBranch: string | null
    })[]
    return rows.map(({ trash, worktreePath, worktreeBranch, hasConversationFile, ...r }) => ({
      ...r,
      hasConversationFile: !!hasConversationFile,
      record: parseTrashRecord(trash),
      worktree: worktreePath ? { path: worktreePath, branch: worktreeBranch ?? '' } : null,
    }))
  }

  /**
   * Deletes a project. Its sessions go to the trash (#204), not with it.
   *
   * The manager moves each session to the trash first (`SessionManager.deleteProject`), which also stops its
   * process. This step catches any live row that did not get there, in the same transaction as the project row, so
   * deleting a project cannot destroy a conversation. Such a row is marked to keep the tool's conversation file and
   * the worktree: nobody was asked about them.
   *
   * **This does not rely on an FK's CASCADE.** `messages_fts` is a virtual table with no foreign key at all, so the index rows
   * of a session caught here are dropped by hand — a session in the trash must not turn up in a search.
   *
   * The rows that belong to the project go with it as before: project-scope rules, the answers given to its apps, and
   * the app runs and commit links that point at no session still here. (`usage_facts` is not touched: no build ever
   * wrote a row to it, and this build is the first that leaves it alone, so a later step can drop it; schema.sql.) Rows that point at a session in the trash stay with that session until it is
   * deleted for good: its own rules, its commit links, the app runs it started or ran in. A restore that registers
   * the folder again under the same id finds them where they were.
   */
  deleteProject(projectId: string): void {
    const tx = this.db.transaction(() => {
      const project = this.db.prepare(`SELECT name, path FROM projects WHERE id = ?`).get(projectId) as
        | { name: string; path: string }
        | undefined
      const record: TrashRecord = {
        projectId,
        projectName: project?.name ?? null,
        projectPath: project?.path ?? null,
        removeExternal: false,
        removeWorktree: false,
      }
      const left = this.db.prepare(`SELECT id FROM sessions WHERE project_id = ? AND deleted_at IS NULL`).all(projectId) as {
        id: string
      }[]
      for (const { id } of left) {
        this.db.prepare(`DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE session_id = ?)`).run(id)
        this.db
          .prepare(`UPDATE sessions SET deleted_at = ?, trash = ?, project_id = NULL WHERE id = ? AND deleted_at IS NULL`)
          .run(Date.now(), JSON.stringify(record), id)
        this.db.prepare(`DELETE FROM grid_panels WHERE session_id = ?`).run(id)
        this.db.prepare(`DELETE FROM grid_layout WHERE session_id = ?`).run(id)
      }
      // The project's apps leave the grid with it: layout, like a session's panel
      this.db.prepare(`DELETE FROM grid_layout WHERE kind = 'app' AND project_id = ?`).run(projectId)
      this.db
        .prepare(
          `/* includes the trash: a rule of a session in the trash stays with it */
           DELETE FROM approval_rules WHERE project_id = ? AND (session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions))`,
        )
        .run(projectId)
      this.db
        .prepare(
          `/* includes the trash: a commit link of a session in the trash stays with it */
           DELETE FROM commit_sessions WHERE project_id = ? AND session_id NOT IN (SELECT id FROM sessions)`,
        )
        .run(projectId)
      // The run log for that project's apps is part of this deletion too (M4 A-6) — a run that points at a session in the trash stays with it
      this.db
        .prepare(
          `/* includes the trash: a run of a session in the trash stays with it */
           DELETE FROM app_runs WHERE project_id = ?
             AND (session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions))
             AND (caller_session_id IS NULL OR caller_session_id NOT IN (SELECT id FROM sessions))`,
        )
        .run(projectId)
      this.db.prepare(`DELETE FROM app_run_failures WHERE project_id = ? AND run_id NOT IN (SELECT id FROM app_runs)`).run(projectId)
      // Answers given to that project's apps' capabilities too (M4 D-4) — a folder registered again, even under the same id by a restore, is asked again
      this.db.prepare(`DELETE FROM app_permissions WHERE project_id = ?`).run(projectId)
      this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId)
    })
    tx()
  }

  /**
   * Writes messages — **writing the same spot twice overwrites it, index included.**
   *
   * messages used to be the only INSERT OR REPLACE; the index was a plain INSERT. So rewriting
   * the same (session, seq) added **another row to the index** every time. In the real database
   * that came to 28,892 messages against 249,809 index rows — 8.6x — and some had piled up as
   * many as 13 duplicates.
   *
   * The cost showed up in two places: recall results were papered over with the same line
   * repeated (dogfooding: "limit was 8 and the same thing came back 5 times"), and the index had
   * bloated to tens of times the size of the actual text.
   *
   * The fix is to **pin the index row to its message row.** Using the messages rowid as the
   * index's own rowid lets INSERT OR REPLACE overwrite it automatically. (session_id and seq
   * are UNINDEXED, so deleting by a WHERE clause on them would scan all 250,000 rows — that
   * cannot happen on every write.)
   *
   * messages also has to be UPDATE, not REPLACE. REPLACE deletes and reinserts, which **changes
   * the rowid**, and once that happens the spot the index was pointing at is gone.
   */
  appendMessages(msgs: StoredMessage[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO messages (session_id, seq, role, kind, payload, ts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET role = excluded.role, kind = excluded.kind,
         payload = excluded.payload, ts = excluded.ts`,
    )
    const rowidOf = this.db.prepare(`SELECT rowid FROM messages WHERE session_id = ? AND seq = ?`)
    const fts = this.db.prepare(
      `INSERT OR REPLACE INTO messages_fts (rowid, body, session_id, seq) VALUES (?, ?, ?, ?)`,
    )
    /*
     * Deletes by rowid. FTS5's `'delete'` command only works on contentless or external-content
     * tables, and messages_fts is an ordinary table that holds its own text, so that command
     * always failed with `SQL logic error` and rolled back other messages in the same batch
     * along with it (#179).
     */
    const dropFts = this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`)
    const tx = this.db.transaction((rows: StoredMessage[]) => {
      for (const m of rows) {
        const payload = JSON.stringify(m.payload)
        stmt.run(m.sessionId, m.seq, m.role, m.kind, payload, m.ts)
        const body = indexedText(m.kind, payload)
        const rid = (rowidOf.get(m.sessionId, m.seq) as { rowid: number } | undefined)?.rowid
        if (rid === undefined) continue
        if (body) {
          fts.run(rid, body, m.sessionId, m.seq)
        } else {
          // A spot whose text disappeared is removed from the index too (otherwise the old text stays searchable)
          dropFts.run(rid)
        }
      }
    })
    tx(msgs)
  }

  /**
   * Full-text search over conversations (E-1). Archived sessions are included too — what is
   * being looked for may be sitting in one of them.
   */
  /**
   * Full-text search over conversations. **Returns the whole body** — trimming it is left to
   * the caller.
   *
   * This used to trim with `snippet(..., 12)` here, but that 12 counted not characters but
   * **tokens**, and with the trigram tokenizer that cut off after roughly 15 real characters.
   * The orchestrator would receive something like `"the policy list already said the…"` and
   * **could not tell whether this was even the passage it was looking for.** How much
   * surrounding context is needed is something only the caller knows, so that judgment is
   * left to it.
   */
  searchMessages(query: string, limit = 50): { sessionId: string; seq: number; body: string }[] {
    const q = query.trim()
    if (!q) return []

    // The trigram tokenizer **cannot find anything shorter than 3 characters** (measured).
    // Two-character searches like '승인' or '배포' are common in Korean, so this falls back to LIKE.
    if (q.length < 3) {
      return this.db
        .prepare(
          `SELECT session_id as sessionId, seq, body FROM messages_fts
           WHERE body LIKE ? AND ${OUT_OF_TRASH} ORDER BY seq DESC LIMIT ?`,
        )
        .all(`%${q}%`, limit) as { sessionId: string; seq: number; body: string }[]
    }

    try {
      return this.db
        .prepare(
          `SELECT session_id as sessionId, seq, body
           FROM messages_fts WHERE messages_fts MATCH ? AND ${OUT_OF_TRASH} ORDER BY rank LIMIT ?`,
        )
        .all(`"${q.replace(/"/g, '""')}"`, limit) as { sessionId: string; seq: number; body: string }[]
    } catch {
      // An FTS syntax error (special characters, etc.) quietly returns an empty result — the search box must not break
      return []
    }
  }

  /**
   * The directory this session was created in — the one its tool-side history is filed under.
   *
   * Deliberately **not** part of `SessionInfo`: it is not something the screen shows, and
   * `upsertSession` must never carry it. The whole point (issue #28) is that this value is
   * written once and then left alone; routing it through the same upsert that saves names and
   * states would let any later save quietly replace it with whatever the caller happened to
   * hold. `touched_paths` lives on the same terms.
   *
   * null means "we do not know yet" — an orchestrator row that predates v14. The manager
   * resolves it the first time it needs the path and writes it back.
   */
  sessionCwd(sessionId: string): string | null {
    const row = this.db.prepare(`SELECT cwd FROM sessions WHERE id = ?`).get(sessionId) as
      { cwd: string | null } | undefined
    return row?.cwd ?? null
  }

  setSessionCwd(sessionId: string, cwd: string): void {
    this.db.prepare(`UPDATE sessions SET cwd = ? WHERE id = ?`).run(cwd, sessionId)
  }

  setTouchedPaths(sessionId: string, paths: string[]): void {
    this.db
      .prepare(`UPDATE sessions SET touched_paths = ? WHERE id = ?`)
      .run(JSON.stringify(paths), sessionId)
  }

  getTouchedPaths(sessionId: string): string[] {
    const row = this.db.prepare(`SELECT touched_paths as p FROM sessions WHERE id = ?`).get(sessionId) as
      { p: string } | undefined
    try {
      return row ? (JSON.parse(row.p) as string[]) : []
    } catch {
      return []
    }
  }

  /**
   * Reads a conversation — **one row is one message** (#77).
   *
   * In the delta era (before #66), one token was one row, so this used to join consecutive
   * assistant rows back into a single message when reading. Those rows were merged once by v21,
   * and writes now write one row per message. Since then, neighboring assistant rows are
   * **genuinely different messages** — a new reply with no human turn in between (a background
   * task finished, a question card was answered), and rows written per reply by transcript
   * import. Joining them the old way would run two replies together into one paragraph with no
   * space, like "…still running.All six reviews are in." So rows are handed back as-is — limit
   * also counts rows (= messages).
   */
  loadMessages(sessionId: string, limit = 200, beforeSeq?: number, opts: ReadOpts = {}): StoredMessage[] {
    const raw = this.db
      .prepare(
        `SELECT session_id as sessionId, seq, role, kind, ${payloadColumn(opts)}, ts FROM messages
         WHERE session_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`,
      )
      .all(sessionId, beforeSeq ?? null, beforeSeq ?? null, limit) as (StoredMessage & { payload: string })[]
    return raw.reverse().map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
  }

  /**
   * The text of this session's replies that contain `needle`: the agent's own words (`assistant` `text` rows), and
   * those of the subagents it launched, which the window shows under their cards. The person's messages, reasoning and
   * tool output are not replies. Asked by `messages.image`, which reads only an image a reply names.
   *
   * `instr` over the stored JSON narrows the rows in SQLite; the needle is JSON-escaped the way the payload was
   * written, so a path with a quote or a backslash is still found. The caller decides on the parsed text.
   */
  replyTextsContaining(sessionId: string, needle: string): string[] {
    const escaped = JSON.stringify(needle).slice(1, -1)
    const rows = this.db
      .prepare(
        `SELECT payload FROM messages
           WHERE session_id = ? AND role = 'assistant' AND kind = 'text' AND instr(payload, ?) > 0
         UNION ALL
         SELECT payload FROM subagent_messages
           WHERE session_id = ? AND role = 'assistant' AND kind = 'text' AND instr(payload, ?) > 0`,
      )
      .all(sessionId, escaped, sessionId, escaped) as { payload: string }[]
    const texts: string[] = []
    for (const r of rows) {
      try {
        const text = (JSON.parse(r.payload) as { text?: unknown }).text
        if (typeof text === 'string') texts.push(text)
      } catch {
        // A row that is not JSON names nothing
      }
    }
    return texts
  }

  /**
   * The conversation **after** afterSeq — loadMessages's forward-going counterpart (#66).
   * Used to read "what was said next" from a spot recall handed back. Same rule: one row is one message (#77).
   */
  loadMessagesFrom(sessionId: string, afterSeq: number, limit = 20, opts: ReadOpts = {}): StoredMessage[] {
    const raw = this.db
      .prepare(
        `SELECT session_id as sessionId, seq, role, kind, ${payloadColumn(opts)}, ts FROM messages
         WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, afterSeq, limit) as (StoredMessage & { payload: string })[]
    return raw.map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
  }

  /**
   * Updates a row while it is still streaming — **the index is left untouched** (#66).
   *
   * Re-indexing a growing body with trigram on every delta would make the cost grow with the
   * square of the message's length. appendMessages indexes it once when the stream closes (the
   * turn_complete boundary).
   */
  upsertMessageNoIndex(m: StoredMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (session_id, seq, role, kind, payload, ts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, seq) DO UPDATE SET role = excluded.role, kind = excluded.kind,
           payload = excluded.payload, ts = excluded.ts`,
      )
      .run(m.sessionId, m.seq, m.role, m.kind, JSON.stringify(m.payload), m.ts)
  }

  /**
   * Keeps one step of a native subagent under the call that launched it (#222) and returns its number within that
   * launch. Never indexed, and never in `messages`: see v41 for why the steps have a table of their own.
   */
  appendSubagentMessage(
    sessionId: string,
    parentCallId: string,
    m: Pick<StoredMessage, 'role' | 'kind' | 'payload' | 'ts'>,
  ): number {
    const next = this.db.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 as seq FROM subagent_messages WHERE session_id = ? AND parent_call_id = ?`,
    )
    const put = this.db.prepare(
      `INSERT INTO subagent_messages (session_id, parent_call_id, seq, role, kind, payload, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    return this.db.transaction((): number => {
      const { seq } = next.get(sessionId, parentCallId) as { seq: number }
      put.run(sessionId, parentCallId, seq, m.role, m.kind, JSON.stringify(m.payload), m.ts)
      return seq
    })()
  }

  /**
   * The steps of the subagent one call launched (#222), oldest first, from after `afterSeq`. `seq` in what comes back
   * is the step's number within that launch.
   *
   * The only reader of `subagent_messages`, and it names one launch card: nothing reads a session's subagent steps by
   * the way. A tool step reads as its card unless `full` is asked for, the same as `loadMessages`.
   */
  loadSubagentMessages(
    sessionId: string,
    parentCallId: string,
    opts: ReadOpts & { afterSeq?: number; limit?: number } = {},
  ): StoredMessage[] {
    const raw = this.db
      .prepare(
        `SELECT session_id as sessionId, seq, role, kind, ${payloadColumn(opts)}, ts FROM subagent_messages
         WHERE session_id = ? AND parent_call_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, parentCallId, opts.afterSeq ?? 0, opts.limit ?? -1) as (StoredMessage & { payload: string })[]
    return raw.map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
  }

  /** Records the skill list (per tool and directory) */
  /** Records commit attribution (#50) — kept here only, not in the repository */
  recordCommit(projectId: string, sha: string, sessionId: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO commit_sessions (project_id, sha, session_id, ts) VALUES (?, ?, ?, ?)`)
      .run(projectId, sha, sessionId, Date.now())
  }

  commitSessions(projectId: string): { sha: string; sessionId: string }[] {
    return this.db
      .prepare(`SELECT sha, session_id AS sessionId FROM commit_sessions WHERE project_id = ?`)
      .all(projectId) as { sha: string; sessionId: string }[]
  }

  saveCommands(tool: string, cwd: string, commands: unknown): void {
    this.db
      .prepare(
        `INSERT INTO command_cache (tool, cwd, commands, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tool, cwd) DO UPDATE SET commands = excluded.commands, updated_at = excluded.updated_at`,
      )
      .run(tool, cwd, JSON.stringify(commands), Date.now())
  }

  loadCommands<T>(tool: string, cwd: string): T | null {
    const row = this.db
      .prepare(`SELECT commands FROM command_cache WHERE tool = ? AND cwd = ?`)
      .get(tool, cwd) as { commands: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.commands) as T
    } catch {
      return null
    }
  }

  nextSeq(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) as m FROM messages WHERE session_id = ?`)
      .get(sessionId) as { m: number }
    return row.m + 1
  }

  markRead(sessionId: string, seq: number): void {
    this.db
      .prepare(`UPDATE sessions SET last_read_seq = MAX(last_read_seq, ?) WHERE id = ?`)
      .run(seq, sessionId)
  }

  /**
   * A workspace snapshot (C-3). Saved on every change rather than at exit, so the last state
   * survives even a crash (docs/state-management.md §5).
   */
  saveWorkspace(layout: unknown): void {
    this.db
      .prepare(
        `INSERT INTO workspace (id, layout, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(layout), Date.now())
  }

  loadWorkspace<T = unknown>(): T | null {
    const row = this.db.prepare(`SELECT layout FROM workspace WHERE id = 1`).get() as
      { layout: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.layout) as T
    } catch {
      return null
    }
  }

  /**
   * A setting that belongs to this install rather than to any project or session (#43).
   *
   * `null` means never written, which is deliberately distinguishable from a stored
   * `'false'`: it is what lets a default move later without silently overruling the one
   * person who had turned the thing off (the same trade `showIgnored` makes in the UI).
   */
  appSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
      { value: string } | undefined
    return row?.value ?? null
  }

  setAppSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  }

  /**
   * Reads a setting, computes its next value from it and writes that, as one transaction that takes the write lock
   * first. Another process on the same file (the old and new host of a swap) cannot change the value between the
   * read and the write, which a separate appSetting and setAppSetting cannot promise.
   */
  updateAppSetting(key: string, next: (current: string | null) => string): void {
    this.db.transaction(() => this.setAppSetting(key, next(this.appSetting(key)))).immediate()
  }

  /** Deletes a setting — reading it back afterward is "never written" (null). Where an old key is cleaned up once everything is migrated off it (M4 A-7) */
  deleteAppSetting(key: string): void {
    this.db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key)
  }

  addApprovalRule(r: {
    scope: string
    projectId?: string
    sessionId?: string
    matcher: string
    decision: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO approval_rules (scope, project_id, session_id, matcher, decision, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.scope, r.projectId ?? null, r.sessionId ?? null, r.matcher, r.decision, Date.now())
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
    return this.db
      .prepare(
        `SELECT id, scope, matcher, decision, project_id as projectId, session_id as sessionId,
                created_at as createdAt
         FROM approval_rules
         WHERE session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions WHERE deleted_at IS NOT NULL)
         ORDER BY created_at DESC`,
      )
      .all() as never
  }

  /** A rule has to be deletable — saving without being able to delete would make "show the outcome" only half true */
  deleteApprovalRule(id: number): void {
    this.db.prepare(`DELETE FROM approval_rules WHERE id = ?`).run(id)
  }

  // ── The run log for external apps (M4 A-6) — this store fills in the app runtime's `RunLedger` ──
  //
  // The runtime does not import this class. The runtime declares the shape it needs (RunLedger),
  // and main.ts passes these methods in as that shape (inverting the dependency from #97).

  beginAppRun(r: AppRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO app_runs (id, project_id, app_id, kind, tool, caller_kind, caller_session_id, parent_run_id,
                               status, duration_ms, args_digest, args_summary, error, created_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id, r.projectId, r.appId, r.kind, r.tool, r.callerKind, r.callerSessionId, r.parentRunId,
        r.status, r.durationMs, r.argsDigest, r.argsSummary, r.error, r.createdAt, r.sessionId,
      )
  }

  /** Links a running run_agent row to the session that request set up (M4 D-6) */
  linkAppRunSession(id: string, sessionId: string): void {
    this.db.prepare(`UPDATE app_runs SET session_id = ? WHERE id = ?`).run(sessionId, id)
  }

  endAppRun(id: string, end: { status: string; durationMs: number; error: string | null; tokens?: { input: number; output: number } | null }): void {
    this.db
      .prepare(`UPDATE app_runs SET status = ?, duration_ms = ?, error = ?, tokens_in = ?, tokens_out = ? WHERE id = ?`)
      .run(end.status, end.durationMs, end.error, end.tokens?.input ?? null, end.tokens?.output ?? null, id)
  }

  /**
   * How much of the agents an app requested since `since` were used (M4 D-5) — only run_agent
   * rows that had a session stand up (a rejected request never set an agent up). A still-running
   * row is counted, but its duration is not in yet.
   */
  appAgentUse(projectId: string | null, appId: string, since: number): { runs: number; durationMs: number; tokens: { input: number; output: number } | null } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) as runs, COALESCE(SUM(duration_ms), 0) as durationMs, COUNT(tokens_in) as counted,
                COALESCE(SUM(tokens_in), 0) as input, COALESCE(SUM(tokens_out), 0) as output
         FROM app_runs
         WHERE app_id = ? AND project_id IS ? AND kind = 'broker' AND tool = 'run_agent' AND session_id IS NOT NULL AND created_at >= ?`,
      )
      .get(appId, projectId, since) as { runs: number; durationMs: number; counted: number; input: number; output: number }
    return { runs: r.runs, durationMs: r.durationMs, tokens: r.counted > 0 ? { input: r.input, output: r.output } : null }
  }

  /**
   * Keeps the raw text of a failure, but only the **most recent `keep`** for that app. The raw
   * text is large and rarely read — what an agent building the app needs to fix it is the last
   * handful of failures, not all of them.
   */
  keepAppRunFailure(f: { runId: string; projectId: string | null; appId: string; args: string; result: string | null; createdAt: number }, keep: number): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`INSERT OR REPLACE INTO app_run_failures (run_id, project_id, app_id, args, result, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(f.runId, f.projectId, f.appId, f.args, f.result, f.createdAt)
      this.db
        .prepare(
          `DELETE FROM app_run_failures WHERE app_id = ? AND project_id IS ? AND run_id NOT IN (
             SELECT run_id FROM app_run_failures WHERE app_id = ? AND project_id IS ? ORDER BY created_at DESC, rowid DESC LIMIT ?
           )`,
        )
        .run(f.appId, f.projectId, f.appId, f.projectId, keep)
    })
    tx()
  }

  /**
   * One app's run log, most recent first — **including the chain beneath each row** (M4 D-6).
   * A failure whose raw text is still kept is returned with it.
   *
   * A root is one of this app's rows whose parent is not also one of this app's rows (called
   * from the UI or a session, called by a different app, or requested with no open run at all).
   * `limit` counts roots. Everything below a root is included by following parent links down —
   * rows for other apps this app called, down to the rows for agents that app in turn requested.
   * That is what lets a single history screen read "what the UI clicked → another app → an
   * agent" as one chain. Rows below the roots are capped at `CHAIN_ROWS_MAX`, so an app that
   * makes requests without end inside a single call cannot hold the screen hostage.
   */
  listAppRuns(
    projectId: string | null,
    appId: string,
    limit: number,
  ): (AppRunRecord & { tokens: { input: number; output: number } | null; failure: { args: string; result: string | null } | null })[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE
           roots(id) AS (
             SELECT r.id FROM app_runs r
             WHERE r.app_id = ? AND r.project_id IS ?
               AND NOT EXISTS (SELECT 1 FROM app_runs p WHERE p.id = r.parent_run_id AND p.app_id = r.app_id AND p.project_id IS r.project_id)
             ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?
           ),
           chain(id) AS (
             SELECT id FROM roots
             UNION
             SELECT c.id FROM app_runs c JOIN chain ON c.parent_run_id = chain.id
           )
         SELECT r.id, r.project_id as projectId, r.app_id as appId, r.kind, r.tool, r.caller_kind as callerKind,
                r.caller_session_id as callerSessionId, r.parent_run_id as parentRunId, r.status,
                r.duration_ms as durationMs, r.args_digest as argsDigest, r.args_summary as argsSummary,
                r.error, r.created_at as createdAt, r.session_id as sessionId, r.tokens_in as tokensIn, r.tokens_out as tokensOut,
                f.args as failureArgs, f.result as failureResult,
                r.rowid as seq, r.id IN (SELECT id FROM roots) as isRoot
         FROM app_runs r LEFT JOIN app_run_failures f ON f.run_id = r.id
         WHERE r.id IN (SELECT id FROM chain)
         ORDER BY isRoot DESC, r.created_at DESC, r.rowid DESC LIMIT ?`,
      )
      .all(appId, projectId, limit, limit + CHAIN_ROWS_MAX) as (AppRunRecord & {
      tokensIn: number | null
      tokensOut: number | null
      failureArgs: string | null
      failureResult: string | null
      seq: number
      isRoot: number
    })[]
    // Filling roots first was only the order used for truncation — what is returned is chronological (most recent first)
    rows.sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)
    return rows.map(({ failureArgs, failureResult, tokensIn, tokensOut, seq: _seq, isRoot: _isRoot, ...r }) => ({
      ...r,
      tokens: tokensIn === null ? null : { input: tokensIn, output: tokensOut ?? 0 },
      failure: failureArgs === null ? null : { args: failureArgs, result: failureResult },
    }))
  }

  /** Removes run records outside the retention window. @returns the number of runs deleted */
  pruneAppRuns(before: number): number {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM app_run_failures WHERE created_at < ?`).run(before)
      return this.db.prepare(`DELETE FROM app_runs WHERE created_at < ?`).run(before).changes
    })
    return tx()
  }

  /**
   * Closes out runs that never saw an end (once, at startup). When the host dies, the app
   * process's input also closes and it ends — a row left at `running` would look like it is
   * running forever. The same reasoning as fixing session state at startup (`manager.ts`'s
   * LIVE_ONLY): a "live" state is only true while a process backs it.
   */
  settleUnfinishedAppRuns(error: string): number {
    return this.db.prepare(`UPDATE app_runs SET status = 'error', error = ? WHERE status = 'running'`).run(error).changes
  }

  // ── The person's answers to an app's capability requests (M4 D-4) — this store fills in the runtime's `CapabilityBook` ──

  getAppPermission(appKey: string, capability: string): AppPermissionRecord | null {
    const row = this.db
      .prepare(
        `SELECT capability, text, decision, uses_stamp as stamp, decided_at as decidedAt FROM app_permissions WHERE app_key = ? AND capability = ?`,
      )
      .get(appKey, capability) as AppPermissionRecord | undefined
    return row ?? null
  }

  putAppPermission(appKey: string, projectId: string | null, r: AppPermissionRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO app_permissions (app_key, project_id, capability, text, decision, uses_stamp, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(appKey, projectId, r.capability, r.text, r.decision, r.stamp, r.decidedAt)
  }

  forgetAppPermission(appKey: string, capability: string): void {
    this.db.prepare(`DELETE FROM app_permissions WHERE app_key = ? AND capability = ?`).run(appKey, capability)
  }

  listAppPermissions(appKey: string): AppPermissionRecord[] {
    return this.db
      .prepare(
        `SELECT capability, text, decision, uses_stamp as stamp, decided_at as decidedAt FROM app_permissions WHERE app_key = ? ORDER BY decided_at DESC`,
      )
      .all(appKey) as AppPermissionRecord[]
  }

  // ── The person's "always" for one project reaching another (#371) — see migration v44 ──

  getProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): ProjectConsent | null {
    const row = this.db
      .prepare(
        `SELECT from_project_id as fromProjectId, to_project_id as toProjectId, kind, decided_at as decidedAt
           FROM project_consents WHERE from_project_id = ? AND to_project_id = ? AND kind = ?`,
      )
      .get(fromProjectId, toProjectId, kind) as ProjectConsent | undefined
    return row ?? null
  }

  setProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): void {
    this.db
      .prepare(
        `INSERT INTO project_consents (from_project_id, to_project_id, kind, decided_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(from_project_id, to_project_id, kind) DO UPDATE SET decided_at = excluded.decided_at`,
      )
      .run(fromProjectId, toProjectId, kind, Date.now())
  }

  forgetProjectConsent(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): boolean {
    return (
      this.db
        .prepare(`DELETE FROM project_consents WHERE from_project_id = ? AND to_project_id = ? AND kind = ?`)
        .run(fromProjectId, toProjectId, kind).changes > 0
    )
  }

  /**
   * Only the kinds this build knows (#384). `kind` has no CHECK, so a newer build can add one without a breaking step;
   * a row of a kind this build cannot name is left in place for that build rather than listed here, where the settings
   * screen would show it without a label and could not revoke it (`projectConsents.revoke` takes known kinds only).
   */
  listProjectConsents(): ProjectConsent[] {
    const rows = this.db
      .prepare(
        `SELECT from_project_id as fromProjectId, to_project_id as toProjectId, kind, decided_at as decidedAt
           FROM project_consents ORDER BY decided_at DESC`,
      )
      .all() as ProjectConsent[]
    return rows.filter((r) => ProjectConsentKindSchema.safeParse(r.kind).success)
  }

  // ── Sessions that owe a report to the session that gave them work (#646) — see migration v49 ──

  listReportMarks(): { sessionId: string; callerSessionId: string }[] {
    return this.db
      .prepare(`SELECT session_id as sessionId, caller_session_id as callerSessionId FROM report_marks ORDER BY marked_at`)
      .all() as { sessionId: string; callerSessionId: string }[]
  }

  setReportMark(sessionId: string, callerSessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO report_marks (session_id, caller_session_id, marked_at) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET caller_session_id = excluded.caller_session_id, marked_at = excluded.marked_at`,
      )
      .run(sessionId, callerSessionId, Date.now())
  }

  clearReportMark(sessionId: string): void {
    this.db.prepare(`DELETE FROM report_marks WHERE session_id = ?`).run(sessionId)
  }

  // ── start_agent requests waiting for the person (#673) — see migration v50 ──

  listAgentStartRequests(): { requestId: string; callerSessionId: string; request: unknown; askedAt: number }[] {
    const rows = this.db
      .prepare(`SELECT request_id as requestId, caller_session_id as callerSessionId, request, asked_at as askedAt FROM agent_start_requests ORDER BY asked_at`)
      .all() as { requestId: string; callerSessionId: string; request: string; askedAt: number }[]
    return rows.flatMap((r) => {
      try {
        return [{ ...r, request: JSON.parse(r.request) as unknown }]
      } catch {
        return []
      }
    })
  }

  putAgentStartRequest(requestId: string, callerSessionId: string, request: unknown): void {
    this.db
      .prepare(
        `INSERT INTO agent_start_requests (request_id, caller_session_id, request, asked_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(request_id) DO UPDATE SET caller_session_id = excluded.caller_session_id, request = excluded.request`,
      )
      .run(requestId, callerSessionId, JSON.stringify(request), Date.now())
  }

  deleteAgentStartRequest(requestId: string): void {
    this.db.prepare(`DELETE FROM agent_start_requests WHERE request_id = ?`).run(requestId)
  }

  // ── Sessions running a turn another session gave them (#676) — see migration v51 ──

  listDelegatedTurns(): { sessionId: string; callerSessionId: string; told: string[]; turnId: string }[] {
    const rows = this.db
      .prepare(`SELECT session_id as sessionId, caller_session_id as callerSessionId, told_cards as told, turn_id as turnId FROM delegated_turns ORDER BY started_at`)
      .all() as { sessionId: string; callerSessionId: string; told: string; turnId: string }[]
    return rows.map((r) => ({ ...r, told: r.told.split(' ').filter(Boolean) }))
  }

  /** A new delegated turn: the cards told of the session's earlier one go with it */
  setDelegatedTurn(sessionId: string, callerSessionId: string, turnId: string): void {
    this.db
      .prepare(
        `INSERT INTO delegated_turns (session_id, caller_session_id, started_at, told_cards, turn_id) VALUES (?, ?, ?, '', ?)
           ON CONFLICT(session_id) DO UPDATE SET caller_session_id = excluded.caller_session_id, started_at = excluded.started_at, told_cards = '', turn_id = excluded.turn_id`,
      )
      .run(sessionId, callerSessionId, Date.now(), turnId)
  }

  setDelegatedTurnTold(sessionId: string, told: readonly string[]): void {
    this.db.prepare(`UPDATE delegated_turns SET told_cards = ? WHERE session_id = ?`).run(told.join(' '), sessionId)
  }

  // ── Requests held for a busy session (#677) — see migration v52 ──

  listQueuedRequests(): QueuedRequest[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id as sessionId, caller_session_id as callerSessionId, via, text, queued_at as queuedAt,
                delivering_at as deliveringAt, opened_by_auto as openedByAuto
           FROM queued_requests ORDER BY queued_at, rowid`,
      )
      .all() as (Omit<QueuedRequest, 'openedByAuto'> & { openedByAuto: number | null })[]
    return rows.map((r) => ({ ...r, openedByAuto: r.openedByAuto === null ? null : r.openedByAuto === 1 }))
  }

  addQueuedRequest(r: QueuedRequest): void {
    this.db
      .prepare(`INSERT INTO queued_requests (id, session_id, caller_session_id, via, text, queued_at, opened_by_auto) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.sessionId, r.callerSessionId, r.via, r.text, r.queuedAt, r.openedByAuto ? 1 : 0)
  }

  markQueuedDelivering(id: string, at: number | null): void {
    this.db.prepare(`UPDATE queued_requests SET delivering_at = ? WHERE id = ?`).run(at, id)
  }

  removeQueuedRequest(id: string): void {
    this.db.prepare(`DELETE FROM queued_requests WHERE id = ?`).run(id)
  }

  clearDelegatedTurn(sessionId: string): void {
    this.db.prepare(`DELETE FROM delegated_turns WHERE session_id = ?`).run(sessionId)
  }

  /**
   * A handoff's move of the original session's live children to the session that took over (#693), in one
   * transaction: each moved session's `asked_by_session_id` and `parent_session_id` where they name the original, the
   * report each owes it (`report_marks`), the delegated turn it gave each (`delegated_turns`), every request it queued
   * (`queued_requests`), and its start_agent requests still waiting for the person (`agent_start_requests`, whose
   * stored request names its caller too). A crash before the commit leaves every row on the original; after it, every
   * row on the new session, so the next host (a swap or a restart) reads one owner either way. `armReports`: children
   * whose report the original was waiting for in a call (its wait had taken the mark down), now owed to the new session.
   */
  moveChildren(
    from: string,
    to: string,
    move: { sessions: readonly string[]; startRequests: readonly { requestId: string; request: unknown }[]; armReports?: readonly string[]; queued?: boolean },
  ): void {
    this.db.transaction(() => {
      const owner = this.db.prepare(
        `UPDATE sessions SET
           asked_by_session_id = CASE WHEN asked_by_session_id = @from THEN @to ELSE asked_by_session_id END,
           parent_session_id = CASE WHEN parent_session_id = @from THEN @to ELSE parent_session_id END
         WHERE id = @id`,
      )
      const mark = this.db.prepare(`UPDATE report_marks SET caller_session_id = @to WHERE session_id = @id AND caller_session_id = @from`)
      const turn = this.db.prepare(`UPDATE delegated_turns SET caller_session_id = @to WHERE session_id = @id AND caller_session_id = @from`)
      for (const id of move.sessions) {
        owner.run({ from, to, id })
        mark.run({ from, to, id })
        turn.run({ from, to, id })
      }
      // A removed original's queue stays with it, for the trash to drop (#738)
      if (move.queued !== false) this.db.prepare(`UPDATE queued_requests SET caller_session_id = ? WHERE caller_session_id = ?`).run(to, from)
      const start = this.db.prepare(`UPDATE agent_start_requests SET caller_session_id = ?, request = ? WHERE request_id = ? AND caller_session_id = ?`)
      for (const r of move.startRequests) start.run(to, JSON.stringify(r.request), r.requestId, from)
      const arm = this.db.prepare(
        `INSERT INTO report_marks (session_id, caller_session_id, marked_at) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET caller_session_id = excluded.caller_session_id, marked_at = excluded.marked_at`,
      )
      for (const id of move.armReports ?? []) arm.run(id, to, Date.now())
    })()
  }

  // ── Linked machines (#82, v46) ─────────────────────────────────────────────────────────────

  listLinkedMachines(): LinkedMachineRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, ssh_target, shell, wsl_distro, command, slot, added_at, accepted_versions
           FROM linked_machines ORDER BY added_at, id`,
      )
      .all() as {
      id: string
      name: string
      ssh_target: string
      shell: string
      wsl_distro: string | null
      command: string | null
      slot: number
      added_at: number
      accepted_versions: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      sshTarget: r.ssh_target,
      remote: { shell: r.shell === 'powershell' || r.shell === 'wsl' ? r.shell : 'posix', wslDistro: r.wsl_distro, command: r.command },
      slot: r.slot,
      addedAt: r.added_at,
      acceptedVersions: r.accepted_versions,
    }))
  }

  /**
   * Adds a linked machine with the next slot. A slot is never handed out twice, even after its machine is removed:
   * an approval rule id folded with it may still be on a screen (links/machine-ids.ts), and must not come to name a
   * rule of the next machine. The high-water mark lives in app_settings.
   */
  addLinkedMachine(m: Omit<LinkedMachineRow, 'slot'>): LinkedMachineRow {
    return this.db.transaction(() => {
      const used = (this.db.prepare(`SELECT MAX(slot) AS s FROM linked_machines`).get() as { s: number | null }).s ?? 0
      const slot = Math.max(used, Number(this.appSetting(LINK_SLOT_KEY) ?? 0)) + 1
      this.db
        .prepare(
          `INSERT INTO linked_machines (id, name, ssh_target, shell, wsl_distro, command, slot, added_at, accepted_versions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.id, m.name, m.sshTarget, m.remote.shell, m.remote.wslDistro ?? null, m.remote.command ?? null, slot, m.addedAt, m.acceptedVersions)
      this.setAppSetting(LINK_SLOT_KEY, String(slot))
      return { ...m, slot }
    })()
  }

  /** Removes a machine with its mirrored headers and its grid panels */
  removeLinkedMachine(id: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM machine_headers WHERE machine_id = ?`).run(id)
      this.db.prepare(`DELETE FROM grid_layout WHERE remote_session_id IS NOT NULL AND substr(remote_session_id, 1, ?) = ?`).run(id.length + 1, `${id}.`)
      this.db.prepare(`DELETE FROM grid_layout WHERE remote_app_id IS NOT NULL AND app_machine = ?`).run(id)
      this.db.prepare(`DELETE FROM linked_machines WHERE id = ?`).run(id)
      this.deleteAppSetting(`${MIRRORED_KEY}${id}.session`)
      this.deleteAppSetting(`${MIRRORED_KEY}${id}.project`)
    })()
  }

  setLinkedMachineAcceptedVersions(id: string, key: string | null): void {
    this.db.prepare(`UPDATE linked_machines SET accepted_versions = ? WHERE id = ?`).run(key, id)
  }

  /** One machine's mirrored sessions or projects, in the order it last listed them; null when never mirrored */
  machineHeaders(machineId: string, kind: 'session' | 'project'): unknown[] | null {
    if (this.appSetting(`${MIRRORED_KEY}${machineId}.${kind}`) === null) return null
    const rows = this.db
      .prepare(`SELECT info FROM machine_headers WHERE machine_id = ? AND kind = ? ORDER BY position, item_id`)
      .all(machineId, kind) as { info: string }[]
    return rows.map((r) => JSON.parse(r.info) as unknown)
  }

  /** Replaces one machine's mirrored list whole, as it was just read */
  replaceMachineHeaders(machineId: string, kind: 'session' | 'project', items: readonly { id: string }[]): void {
    const del = this.db.prepare(`DELETE FROM machine_headers WHERE machine_id = ? AND kind = ?`)
    const ins = this.db.prepare(`INSERT OR REPLACE INTO machine_headers (machine_id, kind, item_id, info, position) VALUES (?, ?, ?, ?, ?)`)
    this.db.transaction(() => {
      // A machine removed meanwhile has no row to hang headers on
      if (!this.db.prepare(`SELECT 1 FROM linked_machines WHERE id = ?`).get(machineId)) return
      del.run(machineId, kind)
      items.forEach((item, i) => ins.run(machineId, kind, item.id, JSON.stringify(item), i))
      this.setAppSetting(`${MIRRORED_KEY}${machineId}.${kind}`, '1')
    })()
  }

  /** One session header, added or replaced; a new one goes last */
  upsertMachineSession(machineId: string, item: { id: string }): void {
    if (!this.db.prepare(`SELECT 1 FROM linked_machines WHERE id = ?`).get(machineId)) return
    const pos = (
      this.db
        .prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM machine_headers WHERE machine_id = ? AND kind = 'session'`)
        .get(machineId) as { p: number }
    ).p
    this.db
      .prepare(
        `INSERT INTO machine_headers (machine_id, kind, item_id, info, position) VALUES (?, 'session', ?, ?, ?)
         ON CONFLICT (machine_id, kind, item_id) DO UPDATE SET info = excluded.info`,
      )
      .run(machineId, item.id, JSON.stringify(item), pos)
  }

  /** Changes a few fields of one mirrored session (its name, its state) */
  patchMachineSession(machineId: string, sessionId: string, patch: Record<string, unknown>): void {
    const row = this.db
      .prepare(`SELECT info FROM machine_headers WHERE machine_id = ? AND kind = 'session' AND item_id = ?`)
      .get(machineId, sessionId) as { info: string } | undefined
    if (!row) return
    const next = { ...(JSON.parse(row.info) as Record<string, unknown>), ...patch }
    this.db
      .prepare(`UPDATE machine_headers SET info = ? WHERE machine_id = ? AND kind = 'session' AND item_id = ?`)
      .run(JSON.stringify(next), machineId, sessionId)
  }

  removeMachineSession(machineId: string, sessionId: string): void {
    this.db.prepare(`DELETE FROM machine_headers WHERE machine_id = ? AND kind = 'session' AND item_id = ?`).run(machineId, sessionId)
  }
}

/** One linked machine as stored (#82, v46): the registry's record (links/links.ts `MachineRecord`) */
export type LinkedMachineRow = {
  id: string
  name: string
  sshTarget: string
  remote: { shell: 'posix' | 'powershell' | 'wsl'; wslDistro?: string | null; command?: string | null }
  slot: number
  addedAt: number
  acceptedVersions: string | null
}

/** The highest slot ever handed to a linked machine (#82) */
const LINK_SLOT_KEY = 'links.slotHighWater'
/** Marks that a machine's list was mirrored at least once, so an empty mirror reads as empty rather than unknown */
const MIRRORED_KEY = 'links.mirrored.'

/**
 * What a remembered consent allows (#371): 'delegate' is part B's ask_project, 'apps' part A's app tools, 'agents' a
 * project's sessions starting agents in that same project (#561, start_agent; the row names the project twice)
 */
export type ProjectConsentKind = 'delegate' | 'apps' | 'agents'

/** One remembered "always" from one project to another (#371, migration v44) */
export type ProjectConsent = { fromProjectId: string; toProjectId: string; kind: ProjectConsentKind; decidedAt: number }

/**
 * What a session in the trash remembers (`sessions.trash`, #204).
 *
 *   projectId, projectName, projectPath   where it came from. A trashed session has no `project_id` (see
 *                                         `trashSession`), and its project may be deleted meanwhile; restoring
 *                                         then registers the folder again under the same id
 *   removeExternal   delete the tool's own conversation file (Claude JSONL, Codex rollout) when deleted for good
 *   removeWorktree   remove the session's worktree when deleted for good
 */
export type TrashRecord = {
  projectId: string | null
  projectName: string | null
  projectPath: string | null
  removeExternal: boolean
  removeWorktree: boolean
  recovery?: WorktreeRecovery
}

/** One row of `listTrash` */
export type TrashedRow = {
  id: string
  name: string
  tool: string
  deletedAt: number
  messages: number
  bytes: number
  /** The tool knows this conversation by an id of its own — there is a file of the tool's to keep or delete */
  hasConversationFile: boolean
  record: TrashRecord
  worktree: { path: string; branch: string } | null
}

/** A record written by an older or broken build reads as "keep everything" — deleting for good must be asked for */
function parseTrashRecord(json: string | null): TrashRecord {
  let r: Partial<Record<keyof TrashRecord, unknown>> = {}
  try {
    r = json ? (JSON.parse(json) as typeof r) : {}
  } catch {
    // unreadable: the defaults below keep the files
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return {
    projectId: str(r.projectId),
    projectName: str(r.projectName),
    projectPath: str(r.projectPath),
    removeExternal: r.removeExternal === true,
    removeWorktree: r.removeWorktree === true,
    ...(r.recovery && typeof r.recovery === 'object' &&
      typeof (r.recovery as WorktreeRecovery).snapshot === 'string' &&
      typeof (r.recovery as WorktreeRecovery).tip === 'string' &&
      typeof (r.recovery as WorktreeRecovery).changedFiles === 'number' &&
      typeof (r.recovery as WorktreeRecovery).commits === 'number'
      ? { recovery: r.recovery as WorktreeRecovery } : {}),
  }
}

/**
 * The condition that keeps the trash out of a search (#204). Its index rows are dropped when it goes to the trash;
 * this also covers the ones a trash step cut short left behind.
 */
const OUT_OF_TRASH = `session_id NOT IN (SELECT id FROM sessions WHERE deleted_at IS NOT NULL)`

/** One row of app_permissions — the same shape as the runtime's `CapabilityDecision` (locked together structurally, M4 D-4) */
export type AppPermissionRecord = { capability: string; text: string; decision: 'allow' | 'deny'; stamp: string; decidedAt: number }

/** The cap on chain rows the history screen loads beneath one app's roots (M4 D-6, `listAppRuns`) */
const CHAIN_ROWS_MAX = 500

/** One row of app_runs — the same shape as the runtime's `AppRunRow` (locked together structurally) */
export type AppRunRecord = {
  id: string
  projectId: string | null
  appId: string
  kind: string
  tool: string
  callerKind: string
  callerSessionId: string | null
  parentRunId: string | null
  status: string
  durationMs: number | null
  argsDigest: string
  argsSummary: string
  error: string | null
  createdAt: number
  sessionId: string | null
}


/** What a reset WAL is cut back to (`journal_size_limit`) */
const WAL_SIZE_LIMIT = 64 * 1024 * 1024



/**
 * One chunk of a session deletion (#179). Removing one index row from the real database took
 * about 0.064ms (1,774ms for 27,887 rows), so 250 rows keeps one chunk under about 20ms. Cutting
 * it finer would only add more commits and lengthen the total time.
 */
const DELETE_CHUNK = 250

/**
 * How a stored message is read back (`loadMessages`, `loadMessagesFrom`, and a subagent's steps, `loadSubagentMessages`).
 *
 *   full   include a tool call's `input` and a tool result's `output` — the whole record (#221)
 *
 * Without `full` a tool message reads as its card: `summary` and nothing more. That is the default because every
 * reader today hands what it reads to someone else: the UI (a history page), another session's prompt
 * (`read_session`, `recall`, the orchestrator's memory), a successor (the handoff record). Full tool output reaching
 * another session's prompt is the privilege path #73 closed, and an agent `cat`-ing a large file must not ride every
 * page load. A reader that needs the record asks for it by name here, where the question gets asked.
 */
export type ReadOpts = { full?: boolean }

/**
 * The payload column as `ReadOpts` asks for it. The fields are dropped by SQLite (`json_remove`) rather than after
 * `JSON.parse`, so a page never pulls a megabyte of tool output into the host only to throw it away.
 */
function payloadColumn(opts: ReadOpts): string {
  return opts.full
    ? 'payload'
    : `CASE WHEN kind IN ('tool_call', 'tool_result') THEN json_remove(payload, '$.input', '$.output') ELSE payload END as payload`
}


/** `sessions.interruption` back as `SessionInfo.interruption` (#698) */
function readInterruption(json: string | null): SessionInfo['interruption'] {
  if (!json) return null
  try {
    const r = InterruptionSchema.safeParse(JSON.parse(json))
    return r.success ? r.data : null
  } catch {
    return null
  }
}
