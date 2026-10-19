import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { removeDataQuietly } from '../../dev-services/data-folder.js'
import { assertExistingPathSync, isMissingPathError } from '../../dev-services/path-guard.js'
import { PROJECT_APPS_PARTS, USER_APPS_PARTS } from './discovery.js'

/**
 * Where an app folder goes (M4 A-7, C-1b, E-3) — the one place that knows it, for every way an app
 * folder comes to be: a new app from the template (`createApp`), an approved MCP server
 * (`installUserApp`), and an import moved in from its staging area (`AppHandover.commit`).
 *
 *   project app     `<project>/.centralu/apps/<id>/`
 *   user-folder app `<data folder>/apps/<id>/`
 *
 * Each of the three used to place its folder its own way, and one of them created the parent with
 * `mkdir -p`: an `apps/` in the data folder that is a link to somewhere else took the approved
 * server's folder outside the data folder, where discovery (which refuses that link) never saw it.
 */

/**
 * A name that is already taken: lstat, not exists, so a broken link of that name is a name taken too — and nothing is
 * ever written over what the person (or an agent) put there.
 */
export function nameTaken(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Where the folder of an app with this id goes, `<apps folder>/<id>`; nothing is created */
export function appFolderPath(root: string, projectId: string | null, id: string): string {
  return join(root, ...(projectId === null ? USER_APPS_PARTS : PROJECT_APPS_PARTS), id)
}

/** Whether something already stands where an app with this id goes — even a folder with a broken manifest belongs to someone */
export function appFolderTaken(root: string, projectId: string | null, id: string): boolean {
  return nameTaken(appFolderPath(root, projectId, id))
}

/** The folder of a new app is taken: `placeAppFolder` writes nothing and leaves what stands there as it is */
export class AppFolderTaken extends Error {
  constructor(readonly dir: string) {
    super(`Something is already at ${dir}`)
    this.name = 'AppFolderTaken'
  }
}

/**
 * The folder an app of this scope lives in, created down from `root` through the path guard
 * (`ensureDirInside`) — so a linked `.centralu` or `apps/` that points elsewhere stops it before
 * anything is written.
 */
export function appsFolderOf(root: string, projectId: string | null): string {
  return ensureDirInside(root, projectId === null ? USER_APPS_PARTS : PROJECT_APPS_PARTS)
}

/**
 * Writes a new app folder `<apps folder>/<id>` and returns its path. `fill` writes the app into a
 * temp folder starting with a dot (skipped by discovery), which is then renamed into place — there
 * is never a moment where discovery could read a half-written manifest as "a broken app". If
 * anything fails, the temp folder is removed and the error is passed on as it is.
 *
 * **A name that is taken is refused** (`AppFolderTaken`), before `fill` runs and again right before the rename: renaming
 * onto an empty folder would replace it without a word, and the first check cannot see one that appeared while `fill`
 * ran. Every door that makes a new app asks here, so none of them builds that path and that test by hand.
 */
export function placeAppFolder(root: string, projectId: string | null, id: string, fill: (staging: string) => void, remove?: (path: string) => void): string {
  const parent = appsFolderOf(root, projectId)
  const dir = join(parent, id)
  if (nameTaken(dir)) throw new AppFolderTaken(dir)
  const staging = join(parent, `.${id}.${randomUUID()}`)
  try {
    fill(staging)
    if (nameTaken(dir)) throw new AppFolderTaken(dir)
    renameSync(staging, dir)
  } catch (err) {
    removeDataQuietly(staging, '[apps]', remove)
    throw err
  }
  return dir
}

/**
 * Creates the folders down to `<root>/<parts…>` **one segment at a time** — checking at each
 * segment whether it is a link that escapes the root. Creating it all at once with `mkdir -p` would
 * mean an app gets written outside the repository whenever `.centralu` inside a project is a link
 * pointing elsewhere (the same link that discovery and watching reject with their guard — creation
 * has to agree with them).
 */
export function ensureDirInside(root: string, parts: readonly string[]): string {
  for (let i = 1; i <= parts.length; i++) {
    const prefix = join(...parts.slice(0, i))
    try {
      if (!assertExistingPathSync(root, prefix).isDirectory()) throw new Error(`${prefix} is not a folder`)
    } catch (err) {
      if (!isMissingPathError(err)) throw err
      mkdirSync(join(root, prefix))
      assertExistingPathSync(root, prefix)
    }
  }
  return join(root, ...parts)
}
