import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UPDATE_RESUME_FILE, type UpdateResumeFile } from './update-resume.js'

/**
 * The person's stop, kept in the data folder (#1143). A linked hub that finds no host running here starts one
 * (`centralu serve --detach`) unless this mark says the person stopped it: with `centralu serve --stop`, which the
 * launcher marks (`markStopped` in packaging/npm/centralu/bin/serve-files.mjs, the same file), or by quitting
 * Centralu here, which this host marks when the keeper stops it for good (`markQuit`). `serve --connection` reports
 * it while no host runs. Every host that starts in the folder removes it (`clearStoppedMark`): a start, by whoever,
 * is the person's again.
 */
export const STOPPED_MARK_FILE = 'stopped.json'

/** Removes the mark, once this host holds the folder's lock. Never fatal: a mark left behind only waits for a Start */
export function clearStoppedMark(dataDir: string): void {
  try {
    rmSync(join(dataDir, STOPPED_MARK_FILE), { force: true })
  } catch {
    // a folder this host could lock but not write in says so elsewhere
  }
}

/**
 * The keeper stops this host for good (Quit completely, the last window closed with background mode off). Restart
 * completely comes the same way; the host it starts next removes the mark
 */
export function markQuit(dataDir: string, now: number = Date.now()): void {
  try {
    writeFileSync(join(dataDir, STOPPED_MARK_FILE), `${JSON.stringify({ v: 1, by: 'quit', at: now })}\n`)
  } catch {
    // nothing to remember it in; the host stops all the same
  }
}

/**
 * The data folder's list of the turns an update cut (#1618, update-resume.ts): written by the host an update stops, read by
 * the next to start. Here beside the person's stop mark, the other file one host leaves in the folder for the next. A write
 * replaces it whole (a new file renamed over it), so a host stopped in the middle leaves the old list or the new, never half
 */
export function updateResumeFile(dataDir: string): UpdateResumeFile {
  const file = join(dataDir, UPDATE_RESUME_FILE)
  return {
    read: () => {
      try {
        return readFileSync(file, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    write: (text) => {
      const next = `${file}.${process.pid}.tmp`
      writeFileSync(next, text)
      renameSync(next, file)
    },
    remove: () => rmSync(file, { force: true }),
  }
}
