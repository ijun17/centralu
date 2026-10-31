import type { MigrationHost, MigrationStep } from './context.js'
import { BaselineV27 } from './v27-baseline.js'
import { StepsV28ToV40 } from './v28-v40.js'
import { StepsV41ToV47 } from './v41-v47.js'
import { StepsV48ToV54 } from './v48-v54.js'
import { StepsV55 } from './v55.js'
import { StepsV58 } from './v58.js'
import { StepsV62 } from './v62.js'

/*
 * The steps are kept in files of 200 to 470 lines by version range, each a class with one `steps()` that returns
 * its slice of the list. Together they are the list, in order: a new step goes at the end of the last file, and when
 * that file is long a new one starts here.
 */
/**
 * The migration list.
 *
 * **How a step may change the store (#292): expand, then contract.** Two builds meet one store more often than it
 * looks: a person goes back to an older release, and a host swap (#280) keeps the previous host serving while the
 * next one starts, and hands back to it if the next one fails. So:
 *
 * 1. **Expand.** A step may add tables, nullable or defaulted columns and indexes, or rewrite data into a form the
 *    previous build still reads. It declares `breaksOlderReaders: false`.
 * 2. **Contract, one release later.** A step that drops or renames a table, column or index, or leaves data an older
 *    build cannot read or would silently lose, lands one release after the code stopped reading and writing what it
 *    removes, and declares `breaksOlderReaders: true`. Dropping something an older schema.sql creates counts: the
 *    older host recreates it empty and carries on (v13).
 * 3. **A breaking step raises the store's `min_reader_version`** (an `app_settings` row) to its own `to`, before it
 *    runs. A host whose newest step is below that refuses to start and says why (`StoreTooNewError`), instead of
 *    opening the store and failing on the first missing column. A host older than the store but at or above it
 *    opens it and runs nothing it does not know.
 * 4. **Heavy steps are marked `heavy: true`**: a step that rewrites or re-indexes every message, or `VACUUM`s. On the
 *    real store these take seconds (v40: 1.9s on 137,722 messages), too long for a swap window, so a swap can run
 *    them after the switch rather than during it.
 *
 * **During a swap (#280 step 3).** The host taking over opens the store with `swap: true` after the previous host
 * has drained and let go of it. It runs the expand steps now and leaves every heavy or breaking step for
 * `runDeferred`, which runs once the swap is over: the previous build can still read an expanded store, so if the
 * new host fails before it is ready the keeper can start the previous build again. Because `user_version` moves
 * past a deferred step, two promises follow for such a step:
 *    - it must still be correct when it runs **after** later steps (out of order);
 *    - the build that ships it must work before it has run. A contract step keeps this by rule 2 (the code stopped
 *      using what it drops a release earlier); a heavy step keeps it by only reshaping data the code reads either
 *      way (a re-index, merged rows, a `VACUUM`).
 * A store whose `min_reader_version` is above the new host is refused before the swap begins (`Store.inspect`).
 *
 * Measured for #280 (2026-10-04): of the first 40 steps, v13, v28 and v32 broke an older build, the last two within
 * twelve days of each other, and nothing stopped an older host from opening the store.
 */
export function migrationSteps(host: MigrationHost): MigrationStep[] {
  return [
    ...new BaselineV27(host).steps(),
    ...new StepsV28ToV40(host).steps(),
    ...new StepsV41ToV47(host).steps(),
    ...new StepsV48ToV54(host).steps(),
    ...new StepsV55(host).steps(),
    ...new StepsV58(host).steps(),
    ...new StepsV62(host).steps(),
  ]
}
