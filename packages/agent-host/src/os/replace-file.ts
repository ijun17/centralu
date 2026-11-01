import { randomBytes } from 'node:crypto'
import { sleepSync } from '../timing.js'
import { errnoCode } from './errors.js'
import type { OsFiles } from './port.js'

/**
 * A data file replaced whole, in one place (#1143): the text is written to a temp file of its own beside `path` and
 * moved onto it, so a reader (another host of a swap, an editor, a watcher) sees the old file or the new one, never half of one.
 * Four copies of this had drifted: a fixed `<file>.<pid>.tmp`, no `wx`, a cleanup that could throw over the error that
 * mattered, and no retry of a rename Windows refuses for a moment.
 *
 * - **The temp name is the writer's own**: `<file>.<pid>-<8 hex>.tmp`. During a host swap two hosts may write one file at
 *   once; `wx` makes a name that somehow exists an error rather than a write through someone else's file. The form is the
 *   one `PrivateJsonFile` sweeps after a crash.
 * - **The mode** is given to the temp file when it is created (`mode`), so a private file is never readable at the default
 *   permissions, not even for the moment between writing and tightening it. Without `mode` the file gets the default.
 * - **A failure leaves no temp file** unless the OS will not let it go (a scanner holds it); that failure is never the one
 *   reported, the write's own is.
 * - **Windows may refuse a rename for a moment** (`EPERM`, `EBUSY`, `EACCES`: a virus scanner or an indexer holds the file just
 *   written, or a reader holds the one being replaced). It is tried again a few times, a moment apart, then the last
 *   refusal is thrown. The waits block this thread (a sync call has no other way) for at most `RENAME_WAITS_MS` in all.
 */

/** The waits between the tries of a refused rename; one more try than waits */
export const RENAME_WAITS_MS: readonly number[] = [20, 40, 80, 160]
/** What Windows answers a rename that an open handle holds up */
const HELD = new Set(['EPERM', 'EBUSY', 'EACCES'])

export type ReplaceOptions = {
  /** The mode of the new file (0o600 for a private one) */
  mode?: number
  /** How the retry waits; blocks by default. A test passes its own */
  sleep?: (ms: number) => void
}

/** Writes `text` as the whole of the file at `path`, replacing what is there. Throws the write's or the rename's error, leaving the old file */
export function replaceFileSync(files: OsFiles, path: string, text: string, opts: ReplaceOptions = {}): void {
  const sleep = opts.sleep ?? sleepSync
  viaTemp(files, path, text, opts.mode, (tmp) => {
    for (let attempt = 0; ; attempt++) {
      try {
        files.renameSync(tmp, path)
        return
      } catch (e) {
        const wait = RENAME_WAITS_MS[attempt]
        if (wait === undefined || !HELD.has(errnoCode(e) ?? '')) throw e
        sleep(wait)
      }
    }
  })
}

/**
 * Writes `text` as the file at `path` **only while there is none**, and says whether it did. A check for the file and then
 * `replaceFileSync` leaves a window in which a file the other host of a swap wrote is replaced; a hard link to the finished
 * temp file never replaces anything: `EEXIST` means another file won, and it is left as it is (false)
 */
export function createFileSync(files: OsFiles, path: string, text: string, opts: Pick<ReplaceOptions, 'mode'> = {}): boolean {
  let created = true
  viaTemp(files, path, text, opts.mode, (tmp) => {
    try {
      files.linkSync(tmp, path)
    } catch (e) {
      if (errnoCode(e) !== 'EEXIST') throw e
      created = false
    }
  })
  return created
}

/** Writes the temp file, hands it to `place`, and removes it however that ended (a link leaves it standing, a rename has moved it) */
function viaTemp(files: OsFiles, path: string, text: string, mode: number | undefined, place: (tmp: string) => void): void {
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    files.writeFileSync(tmp, text, { mode, flag: 'wx' })
    place(tmp)
  } finally {
    try {
      files.rmSync(tmp, { force: true })
    } catch {
      // Held open by a scanner: the leftover is not worth hiding the write's own error for (`PrivateJsonFile` sweeps its own at the next start)
    }
  }
}
