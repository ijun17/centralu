import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
