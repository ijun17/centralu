import { readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * The one walk over an app folder (M4 C-4, E-1, E-3) — what is an app's code, and how deep it goes.
 *
 * Every reader of an app folder walks it through here: the folder fingerprint (`fingerprint.ts`,
 * which decides whether a changed folder restarts the app), a version's capture and restore
 * (`versions.ts`), an import's copy and the re-review listing (`imports.ts`), the template's
 * expansion (`scaffold.ts`), and the subfolders discovery watches (`discovery.ts`). They used to
 * walk with their own code, and the depth had drifted: an import copied folders 16 deep while the
 * fingerprint and the versions stopped at 8 — so an edit deep in an imported app never restarted
 * it, and a version never captured nor restored those files. One depth now (`APP_FOLDER_DEPTH`).
 *
 * Two rules for what a walk skips, because the readers want two different things:
 *
 *   `hiddenName` — never moved into an app, never listed as its file: a name starting with a dot
 *   (`.git`, `.env`, and also `.claude/` and `.codex/`, settings a building session reads in the
 *   app folder — an imported bundle carrying a hook there could run it without the person's
 *   confirmation), and `__MACOSX`, what macOS's compressor adds beside an archive's content. An
 *   import's copy and its review walk with this one (`skip`).
 *
 *   `outsideAppCode` — the default: `hiddenName`, plus `node_modules`. What the fingerprint
 *   measures and a version keeps is the app's own code; installed dependencies are not, and walking
 *   them would take tens of thousands of entries every time the fingerprint is measured (inside the
 *   file cap they would also crowd out the app's own files: `node_modules` sorts before
 *   `server.mjs`). An import still copies a `node_modules` it brings, as it always did.
 *
 * A link is never followed: `Dirent` does not follow links, and each reader decides what a link
 * means to it (`link`). Entries are visited in name order, so the same folder always walks the same.
 */

/** How deep folders nest inside an app folder — a folder deeper than this is not walked (`tooDeep`) */
export const APP_FOLDER_DEPTH = 16

/** A name that is never moved into an app nor listed as its file — see the file comment */
export function hiddenName(name: string): boolean {
  return name.startsWith('.') || name === '__MACOSX'
}

/** A name that is not part of an app's own code: `hiddenName`, and `node_modules` — see the file comment */
export function outsideAppCode(name: string): boolean {
  return hiddenName(name) || name === 'node_modules'
}

/** What a visitor answers to end the whole walk at once */
export const STOP = 'stop'
type Next = void | typeof STOP

/** What one reader does with each entry; `rel` is the path inside the app folder, joined with `/` */
export type AppFolderVisit = {
  /** One regular file */
  file(rel: string): Next
  /** One folder, before what is inside it */
  dir?(rel: string): Next
  /** A name the walk's rule skips (`skip`, `outsideAppCode` by default) — nothing beneath it is walked */
  skipped?(rel: string, isDir: boolean): Next
  /** A link — never followed */
  link?(rel: string): Next
  /** Neither a file, a folder nor a link (a socket, a device) */
  other?(rel: string): Next
  /** A folder nested deeper than the cap — not walked */
  tooDeep?(rel: string): Next
  /** A folder that could not be read (`rel` is `''` for the app folder itself) */
  unreadable?(rel: string, err: unknown): Next
}

export function walkAppFolder(root: string, v: AppFolderVisit, maxDepth = APP_FOLDER_DEPTH, skip: (name: string) => boolean = outsideAppCode): void {
  let stopped = false
  const walk = (rel: string, depth: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })
    } catch (err) {
      if (v.unreadable?.(rel, err) === STOP) stopped = true
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (stopped) return
      const r = rel ? `${rel}/${e.name}` : e.name
      let next: Next
      if (skip(e.name)) next = v.skipped?.(r, e.isDirectory())
      else if (e.isSymbolicLink()) next = v.link?.(r)
      else if (e.isDirectory()) {
        if (depth + 1 > maxDepth) next = v.tooDeep?.(r)
        else {
          next = v.dir?.(r)
          if (next !== STOP) walk(r, depth + 1)
        }
      } else if (e.isFile()) next = v.file(r)
      else next = v.other?.(r)
      if (next === STOP) stopped = true
    }
  }
  walk('', 0)
}
