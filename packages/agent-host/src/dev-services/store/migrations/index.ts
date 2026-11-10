import type { MigrationHost, MigrationStep } from './context.js'
import { StepsV2ToV12 } from './v02-v12.js'
import { StepsV13ToV27 } from './v13-v27.js'
import { StepsV28ToV40 } from './v28-v40.js'
import { StepsV41ToV47 } from './v41-v47.js'
import { StepsV48ToV54 } from './v48-v54.js'
import { StepsV55 } from './v55.js'
import { StepsV58 } from './v58.js'
import { StepsV62 } from './v62.js'
import { StepsV65 } from './v65.js'

/*
 * The steps are kept in files of 200 to 470 lines by version range, each a class with one `steps()` that returns
 * its slice of the list. Together they are the list, in order: a new step goes at the end of the last file, and when
 * that file is long a new one starts here.
 */
/**
 * The migration list.
 *
 * **How a step may change the store (#292): expand, then contract.** Two builds meet one store more often than it
 * looks: a person goes back to an older release, and a linked machine's `serve --switch` starts the previous build
 * again when the next one fails. (Until #1895 a host swap kept the previous host serving while the next one started.)
 * So:
 *
 * 1. **Expand.** A step may add tables, nullable or defaulted columns and indexes, or rewrite data into a form the
 *    previous build still reads. It declares `breaksOlderReaders: false`.
 * 2. **Contract, one release later.** A step that drops or renames a table, column or index, or leaves data an older
 *    build cannot read or would silently lose, lands one release after the code stopped reading and writing what it
 *    removes, and declares `breaksOlderReaders: true`. Dropping something an older schema.sql creates counts: the
 *    older host recreates it empty and carries on (v13).
 * 3. **A breaking step raises the store's `min_reader_version`** (an `app_settings` row) to its own `to`, or to the
 *    lower version it names (`minReader`) when the builds from there on already write everything it relies on, before it
 *    runs. A host whose newest step is below that refuses to start and says why (`StoreTooNewError`), instead of
 *    opening the store and failing on the first missing column. A host older than the store but at or above it
 *    opens it and runs nothing it does not know.
 * 4. **Heavy steps are marked `heavy: true`**: a step that rewrites or re-indexes every message, or `VACUUM`s. On the
 *    real store these take seconds (v40: 1.9s on 137,722 messages), which the host's start says in its log.
 *
 * **What a swap left (#280 step 3, gone since #1895).** A host of an earlier build that took over in a swap left every
 * heavy or breaking step for after it (`deferred_migrations`), with `user_version` already past them. A store that
 * still lists some runs them at the next open, in their place in the order (store/migrate-runner.ts), so a step that
 * was ever left that way must still be correct when it runs **after** later steps.
 *
 * Measured for #280 (2026-10-04): of the first 40 steps, v13, v28 and v32 broke an older build, the last two within
 * twelve days of each other, and nothing stopped an older host from opening the store.
 */
export function migrationSteps(host: MigrationHost): MigrationStep[] {
  return [
    ...new StepsV2ToV12(host).steps(),
    ...new StepsV13ToV27(host).steps(),
    ...new StepsV28ToV40(host).steps(),
    ...new StepsV41ToV47(host).steps(),
    ...new StepsV48ToV54(host).steps(),
    ...new StepsV55(host).steps(),
    ...new StepsV58(host).steps(),
    ...new StepsV62(host).steps(),
    ...new StepsV65(host).steps(),
  ]
}
