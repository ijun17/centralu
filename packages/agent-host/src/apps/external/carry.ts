import { randomUUID } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
