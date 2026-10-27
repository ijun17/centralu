import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UPDATE_RESUME_PREFIX, type UpdateResumeFolder } from './update-resume.js'

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
 * The data folder's lists of the turns an update cut (#1618, update-resume.ts): each written by a host an update stops,
 * read by the next to start. Here beside the person's stop mark, the other file one host leaves in the folder for the next.
 * Each list is written once, under a new name of its own (`wx`): nothing is renamed over a file another process may hold,
 * and a host killed while it wrote leaves text that is not JSON, which the next start removes
 */
export function updateResumeFolder(dataDir: string): UpdateResumeFolder {
  // `update-resume.<uuid>.json`, the names `add` gives (UPDATE_RESUME_PREFIX)
  const NAME = /^update-resume\.[0-9a-f-]{36}\.json$/
  return {
    names: () => readdirSync(dataDir).filter((n) => NAME.test(n)),
    read: (name) => {
      try {
        return readFileSync(join(dataDir, name), 'utf8')
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null
        throw err
      }
    },
    add: (text) => writeFileSync(join(dataDir, `${UPDATE_RESUME_PREFIX}${randomUUID()}.json`), text, { flag: 'wx' }),
    remove: (name) => rmSync(join(dataDir, name), { force: true }),
  }
}
