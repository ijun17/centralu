import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { APP_FOLDER_DEPTH, STOP, walkAppFolder } from './folder-walk.js'

/**
 * The fingerprint of an app folder (M4 C-4) — answers "has the folder changed since the app
 * started" with this one value.
 *
 * Why this does not rely on folder watching (fs events): watching only sees the folders that are
 * expanded (`DirWatchers` — it is not recursive), and events can be coalesced or dropped. At the
 * moment a change actually has to be reflected (the building session's turn ended), measuring the
 * folder right now gives the correct answer no matter how many events were missed. Watching only
 * tells us **when** to re-measure (while there is no building session).
 *
 * Small files are measured by **content**: a `touch`, or checking out the same content again, has
 * not changed the app, so there is no reason to restart it. Large files are measured by size and
 * timestamp — so measuring one folder never takes more than a few milliseconds.
 *
 * Skipped: what is never part of an app's code — names starting with a dot, `__MACOSX` and
 * `node_modules` (`outsideAppCode`, `folder-walk.ts`). There are caps on file count and depth (the
 * depth is the one every reader of an app folder shares, `APP_FOLDER_DEPTH`).
 */

const CONTENT_MAX_BYTES = 1024 * 1024
const MAX_FILES = 2_000

/**
 * Walks what the fingerprint measures — the fingerprint and the snapshot mechanism (E-1,
 * `versions.ts`) use **the same walk**. If the files a snapshot captures differed from the files the
 * fingerprint measures, the fingerprint after a restore would not match that snapshot's fingerprint,
 * and it could no longer be pointed to as "the current version".
 *
 * The skip list and caps are exactly as described above. A link is neither a file nor a folder, so
 * it is never walked (`walkAppFolder`).
 */
export type CodeVisit = {
  /** An unreadable folder — the fingerprint measures this too, so a missing folder does not end up looking the same as an existing one */
  unreadable(rel: string): void
  dir(rel: string): void
  /** One file (path relative to the app folder) */
  file(rel: string): void
  /** The file count cap was exceeded — the rest of the folder is skipped */
  more(): void
}

/** `maxDepth` is for a version captured at another depth (`Snapshot.depth`); everything else walks at the shared one */
export function walkCode(dir: string, v: CodeVisit, maxDepth = APP_FOLDER_DEPTH): void {
  let files = 0
  walkAppFolder(
    dir,
    {
      unreadable: (rel) => v.unreadable(rel),
      dir: (rel) => {
        v.dir(rel)
      },
      file: (rel) => {
        if (++files > MAX_FILES) {
          v.more()
          return STOP
        }
        v.file(rel)
      },
    },
    maxDepth,
  )
}

export function folderFingerprint(dir: string): string {
  const h = createHash('sha256')
  walkCode(dir, {
    unreadable: (rel) => void h.update(`!${rel}\n`), // being unreadable is a shape too — so a missing folder does not end up with the same fingerprint as an existing one
    dir: (r) => void h.update(`d ${r}\n`),
    more: () => void h.update('…more files\n'),
    file: (r) => {
      try {
        const path = join(dir, r)
        const st = statSync(path)
        if (st.size <= CONTENT_MAX_BYTES) h.update(`f ${r} `).update(readFileSync(path)).update('\n')
        else h.update(`F ${r} ${st.size} ${st.mtimeMs}\n`)
      } catch {
        h.update(`? ${r}\n`) // disappeared while being measured
      }
    },
  })
  return h.digest('hex')
}
