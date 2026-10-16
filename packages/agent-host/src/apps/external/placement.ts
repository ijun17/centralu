import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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
 */
export function placeAppFolder(root: string, projectId: string | null, id: string, fill: (staging: string) => void): string {
  const parent = appsFolderOf(root, projectId)
  const dir = join(parent, id)
  const staging = join(parent, `.${id}.${randomUUID()}`)
  try {
    fill(staging)
    renameSync(staging, dir)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
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
