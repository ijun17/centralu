import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { readJsonList } from './json.js'
import { type MigrationStep } from './migrations/context.js'
import { ReaderGate, storeTooNewMessage } from './reader-gate.js'
import { readStoreKey, writeStoreKey } from './store-keys.js'
import { OwedVacuum, VACUUM_OWED_KEY, type VacuumDone } from './vacuum.js'

/**
 * The `app_settings` key listing steps a host swap left for later (#280 step 3): a JSON array of their `to` numbers.
 * `user_version` has moved past them, so the list is how the next open knows they still have to run.
 */
const DEFERRED_KEY = 'deferred_migrations'

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
 * The migration runner (E-0, #280, #396): runs the steps a store has not run yet, each in one commit with the record that
 * it ran, leaves heavy and breaking ones for after a swap, and runs a vacuum a stopped host left owed. `Store` extends it
 * rather than holding it, for the reason the gate below it gives (store/reader-gate.ts).
 */
export abstract class MigrationRunner extends ReaderGate {
  protected abstract readonly opts: StoreOptions
  abstract get schemaVersion(): number
  abstract checkpoint(): boolean

  /**
   * The number of migration steps **actually run** this time.
   *
   * This is both a diagnostic and a guard against regression. The property "a step that has
   * already run does not run again" is invisible, so once it breaks (as it did when
   * schema.sql kept rewriting `PRAGMA user_version`) the result stays correct while only the
   * cost quietly grows, and nobody notices. Counting it lets a test ask.
   */
  migrationsRun = 0

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
  protected migrate(): void {
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
  protected vacuumAfterStep(report?: (done: VacuumDone) => void): void {
    writeStoreKey(this.db, VACUUM_OWED_KEY, '1')
    this.afterStep(() => {
      const done = this.runOwedVacuum()
      if (done) report?.(done)
    })
  }

  /** A `VACUUM` a step queued has not run yet (store/vacuum.ts) */
  get vacuumOwed(): boolean {
    return new OwedVacuum(this.db).vacuumOwed
  }

  private runOwedVacuum(why?: string): VacuumDone | null {
    return new OwedVacuum(this.db).runOwedVacuum(why)
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
    const probe = Object.create(this.prototype) as MigrationRunner
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
    return readJsonList(readStoreKey(this.db, DEFERRED_KEY), z.number().int().positive())
  }

  private writeDeferred(steps: number[]): void {
    writeStoreKey(this.db, DEFERRED_KEY, steps.length === 0 ? null : JSON.stringify([...steps].sort((a, b) => a - b)))
  }
}
