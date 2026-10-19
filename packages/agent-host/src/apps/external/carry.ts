import { randomUUID } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { removeDataQuietly } from '../../dev-services/data-folder.js'
import { VERSIONS_REL } from './versions.js'

/**
 * What an app keeps on disk, carried from one app key to another (#1141): a user-folder app (`_user/<id>`) registered
 * as a project in place becomes `<project id>/<id>`, and its data folder, log and kept versions follow it.
 *
 *   data       <data folder>/app-data/<key>/
 *   log        <data folder>/app-logs/<key>.log, and the older generation `.log.1`
 *   versions   <data folder>/app-versions/<key>/
 *
 * **Copied, never moved**: a previous build serving during a host swap (docs/agent-host.md §5.1) still reads and writes
 * the old key, and must not find its app's data gone. A later release removes the old copies.
 *
 * Only where the new key has nothing yet, so running it again after an interruption changes nothing, and never writes
 * over what the app has written under its new key since. A folder is copied beside its place and renamed into it, so
 * an interrupted copy never stands as a whole one that the next run would then skip.
 */
export function carryAppFiles(dataRoot: string, fromKey: string, toKey: string): void {
  copyFolderOnce(join(dataRoot, 'app-data', fromKey), join(dataRoot, 'app-data', toKey))
  for (const suffix of ['.log', '.log.1']) copyFileOnce(join(dataRoot, 'app-logs', fromKey + suffix), join(dataRoot, 'app-logs', toKey + suffix))
  copyFolderOnce(join(dataRoot, VERSIONS_REL, fromKey), join(dataRoot, VERSIONS_REL, toKey))
}

/**
 * The way back (#1204): what a deleted project's root app kept under its project's key goes back to the key it was
 * carried from, so a folder put back into the user folder finds it (its adoption carries that key into its new project).
 * Moved, not copied: the project's key has no reader left, since a project id is never reused.
 *
 * **Nothing the old key holds is deleted.** It is usually the copy the carry was taken from, but it can be the only
 * copy of something: a previous build serving after a rollback keeps working on the old key (root-apps.md §4), so what
 * the app wrote there is nowhere else. Where both keys hold an item, the old key's goes to `keep` first (in
 * `app-trash/`, beside the folder the project gave back, where no sweep looks), then the project's takes its place. A
 * host stopped between the two leaves both: the old key's in `keep`, the project's under the project's key, which the
 * next return moves. An item only the old key holds stays where it is.
 */
export function returnAppFiles(dataRoot: string, fromKey: string, toKey: string, keep: string): void {
  const item = (area: string, key: string, suffix = '') => join(dataRoot, area, key + suffix)
  const back = (area: string, suffix = '') =>
    returnOnce(item(area, fromKey, suffix), item(area, toKey, suffix), join(keep, area, basename(toKey) + suffix))
  back('app-data')
  for (const suffix of ['.log', '.log.1']) back('app-logs', suffix)
  back(VERSIONS_REL)
  // The key's scope folders (`<area>/<project id>/`), once nothing is left in them: a project id is never reused
  const scope = dirname(fromKey)
  if (scope !== '.') for (const area of ['app-data', 'app-logs', VERSIONS_REL]) removeIfEmpty(join(dataRoot, area, scope))
}

/** Removes a folder only when it is empty: `rmdir` refuses anything else */
function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir)
  } catch {
    // Absent, or something is still in it: left as it is
  }
}

function returnOnce(from: string, to: string, aside: string): void {
  if (!existsSync(from)) return
  mkdirSync(dirname(to), { recursive: true })
  const kept = existsSync(to)
  if (kept) {
    if (existsSync(aside)) throw new Error(`${aside} is already there`)
    mkdirSync(dirname(aside), { recursive: true })
    renameSync(to, aside)
  }
  try {
    renameSync(from, to)
  } catch (e) {
    if (kept) renameSync(aside, to)
    throw e
  }
}

/** A copy left beside its place by a host that stopped mid-carry: `<name>.carry-<uuid>` */
const LEFTOVER = /\.carry-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Removes the half copies an interrupted carry left (a host stopped between copying and renaming into place). Each is
 * only ever beside a scope's folder (`app-data/<scope>/`, `app-logs/<scope>/`, `app-versions/<scope>/`), so those are
 * the only places looked at; a carry under way in this host is not running when this is called
 */
export function sweepCarryLeftovers(dataRoot: string): void {
  for (const area of ['app-data', 'app-logs', VERSIONS_REL]) {
    let scopes: string[] = []
    try {
      scopes = readdirSync(join(dataRoot, area))
    } catch {
      continue
    }
    for (const scope of scopes) {
      let names: string[] = []
      try {
        names = readdirSync(join(dataRoot, area, scope))
      } catch {
        continue
      }
      for (const name of names) if (LEFTOVER.test(name)) removeDataQuietly(join(dataRoot, area, scope, name), '[apps]')
    }
  }
}

function copyFolderOnce(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return
  mkdirSync(dirname(to), { recursive: true })
  const tmp = `${to}.carry-${randomUUID()}`
  try {
    cpSync(from, tmp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
    renameSync(tmp, to)
  } catch (e) {
    removeDataQuietly(tmp, '[apps]')
    throw e
  }
}

function copyFileOnce(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return
  mkdirSync(dirname(to), { recursive: true })
  const tmp = `${to}.carry-${randomUUID()}`
  copyFileSync(from, tmp)
  renameSync(tmp, to)
}
