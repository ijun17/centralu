import { z } from 'zod'
import { parseJson, readJsonList } from './json.js'
import { type MigrationStep } from './migrations/context.js'
import { ReaderGate } from './reader-gate.js'
import { readStoreKey, writeStoreKey } from './store-keys.js'
import { OwedVacuum, VACUUM_OWED_KEY, type VacuumDone } from './vacuum.js'

/**
 * The `app_settings` key listing steps a host swap left for later (#280 step 3): a JSON array of their `to` numbers.
 * `user_version` has moved past them, so the list is how the next open knows they still have to run. No host swaps
 * since #1895 and nothing adds to the list any more; a store a host of an earlier build left one in runs them at open.
 */
const DEFERRED_KEY = 'deferred_migrations'
/** One element of that list */
const DeferredStep = z.number().int().positive()

/**
 * The migration runner (E-0, #280, #396): runs the steps a store has not run yet, each in one commit with the record that
 * it ran, the steps an earlier host swap left for later among them, and runs a vacuum a stopped host left owed. `Store`
 * extends it rather than holding it, for the reason the gate below it gives (store/reader-gate.ts).
 */
export abstract class MigrationRunner extends ReaderGate {
  abstract get schemaVersion(): number

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
    if (stored === null) {
      // A record that is not a version reaches here only on a store this host knows every step of (`tooNew`, #384)
      const unreadable = this.unreadableMinReader()
      if (unreadable !== null) {
        console.error(
          `[store] app_settings.min_reader_version in ${this.dbPath} held ${JSON.stringify(unreadable.slice(0, 40))}, not a store version; worked out again from the steps this store has run: ${floor}`,
        )
      }
      this.writeMinReader(floor)
    }

    const t0 = Date.now()
    /*
     * Steps a swap of an earlier build left for later (#280 step 3) run now, in their place in the order. A host of
     * that build that died before it ran them left them here for the next one.
     */
    const deferred = new Set(this.storedDeferred())
    this.sayUnreadableDeferred()
    for (const step of steps) {
      const due = current < step.to || deferred.has(step.to)
      if (!due) continue
      floor = this.runStep(step, floor, () => {
        if (step.to > this.schemaVersion) this.db.pragma(`user_version = ${step.to}`)
        // A step an earlier swap left for later is crossed off in its own commit
        if (deferred.delete(step.to)) this.writeDeferred([...deferred])
      })
    }
    // A vacuum a stopped host left owed (#396) runs now
    if (this.vacuumOwed) this.runOwedVacuum('a host stopped during it left it owed')
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
     * start, finding that column, skipped the step for good, so every later query on the missing column failed. What cannot run inside a
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

  private storedDeferred(): number[] {
    return readJsonList(readStoreKey(this.db, DEFERRED_KEY), DeferredStep)
  }

  /**
   * A list of owed steps that does not read whole is said, naming the row (#384): `user_version` is already past the
   * steps it named, so a step it lost never runs. Not guessed at: a step a swap left owes an index, a vacuum or a
   * contraction, never data, and only a hand edit or a write cut short leaves such a list.
   */
  private sayUnreadableDeferred(): void {
    const raw = readStoreKey(this.db, DEFERRED_KEY)
    if (raw === null) return
    const list = parseJson(raw)
    if (Array.isArray(list) && list.every((x) => DeferredStep.safeParse(x).success)) return
    console.error(
      `[store] app_settings.${DEFERRED_KEY} in ${this.dbPath} holds ${JSON.stringify(raw.slice(0, 80))}, not a list of steps; a step it named that a host swap left for later will not run`,
    )
  }

  private writeDeferred(steps: number[]): void {
    writeStoreKey(this.db, DEFERRED_KEY, steps.length === 0 ? null : JSON.stringify([...steps].sort((a, b) => a - b)))
  }
}
