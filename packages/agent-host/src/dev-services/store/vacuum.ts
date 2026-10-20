import type Database from 'better-sqlite3'
import { errorMessage } from '@cc/protocol'
import { pragmaNumber } from './rows.js'
import { readStoreKey, writeStoreKey } from './store-keys.js'

/**
 * How much free space in the file is worth a vacuum at startup (v40). Below this the pages stay in the file for later
 * writes to reuse; a vacuum rewrites the whole file, which is not worth it for a few megabytes.
 */
export const VACUUM_FREE_BYTES = 16 * 1024 * 1024

/** What an owed `VACUUM` did: the file's size before and after, and how long it took */
export type VacuumDone = { before: number; after: number; ms: number }

export const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)}MB`

/**
 * The `app_settings` key present while a `VACUUM` a migration step queued has not run yet (#396). Written in the step's
 * own transaction and deleted once the vacuum is over, so a host stopped during the vacuum (which SQLite rolls back
 * whole) leaves it for the next open. The step's version has already committed by then: without the row, nothing would
 * vacuum again and the file would keep its free pages for good.
 */
export const VACUUM_OWED_KEY = 'vacuum_owed'

/** A `VACUUM` a migration step left owed (#396): whether one is, and running it. The runner records it (store/migrate-runner.ts) */
export class OwedVacuum {
  constructor(private readonly db: Database.Database) {}

  /** A `VACUUM` a step queued has not run yet: the host was stopped during it (#396) */
  get vacuumOwed(): boolean {
    return readStoreKey(this.db, VACUUM_OWED_KEY) !== null
  }

  /**
   * Runs the owed `VACUUM` and deletes the record of it. `why`, when given, is said in host.log on success.
   *
   * A vacuum that fails (no room for its temporary copy, say) is reported and passed over, its record deleted too: the
   * free pages stay in the file and later writes reuse them, and a store that cannot shrink must neither keep the host
   * from starting nor make every start try again. Only a host stopped during the vacuum leaves the record behind.
   */
  runOwedVacuum(why?: string): VacuumDone | null {
    const pageSize = pragmaNumber(this.db, 'page_size')
    const size = () => pragmaNumber(this.db, 'page_count') * pageSize
    const before = size()
    const t0 = Date.now()
    try {
      this.db.exec('VACUUM')
    } catch (err) {
      const free = pragmaNumber(this.db, 'freelist_count') * pageSize
      console.error(`[store] could not vacuum; ${mb(free)} stay free in the file: ${errorMessage(err)}`)
      return null
    } finally {
      writeStoreKey(this.db, VACUUM_OWED_KEY, null)
    }
    const done = { before, after: size(), ms: Date.now() - t0 }
    if (why) console.error(`[store] vacuumed ${mb(done.before)} -> ${mb(done.after)} (${done.ms}ms): ${why}`)
    return done
  }
}
