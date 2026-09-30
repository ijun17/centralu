import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { assertExistingPathSync, isMissingPathError } from '../../dev-services/path-guard.js'
import { MANIFEST_FILE, MAX_MANIFEST_BYTES, parseManifest, type AppManifest } from './manifest.js'

/**
 * Scans the places apps live (M4 A-2, plan decision 1).
 *
 *   project app   <registered project root>/.centralu/apps/<id>/centralu.app.json
 *   user app      <host data folder>/apps/<id>/centralu.app.json
 *
 * This file **only reads** — it does not create folders or start processes. What actually gets
 * started is decided by the runtime, based on trust. So an app in an untrusted project is
 * discovered here the same as any other, and shows up in the list with its reason.
 */

export const PROJECT_APPS_REL = '.centralu/apps'
export const USER_APPS_REL = 'apps'
/** The same location as path segments — the folder creator (`createApp`) passes the guard one segment at a time */
export const PROJECT_APPS_PARTS = ['.centralu', 'apps'] as const
export const USER_APPS_PARTS = ['apps'] as const

export type ScannedApp = {
  /** The folder name. Equals the manifest's id when the manifest is valid (rule below) */
  folder: string
  /** The absolute path that will become the app process's cwd — exactly the path that was checked */
  dir: string
  /** A hash of the raw manifest text, used to detect changes (null if missing or unreadable) */
  hash: string | null
  manifest: AppManifest | null
  error: string | null
  warnings: string[]
}

export type ScanResult = {
  apps: ScannedApp[]
  /**
   * The directories to watch (paths relative to the root). If an app folder does not exist yet,
   * this watches **the deepest ancestor that does exist** — because `.centralu/apps` appearing
   * later also has to be noticed.
   */
  watch: string[]
}

/**
 * @param root   the project root or the host data folder
 * @param rel    the parent of the app folders (PROJECT_APPS_REL | USER_APPS_REL)
 * @param ancestors  the ancestors to watch instead when `rel` does not exist (shallowest first).
 *                   Empty on the user side — watching the data folder itself would wake up on
 *                   every write to store.db.
 */
export function scanApps(root: string, rel: string, ancestors: readonly string[]): ScanResult {
  let entries: Dirent[]
  try {
    assertExistingPathSync(root, rel)
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch (e) {
    if (!isMissingPathError(e) && !isFsMissing(e)) {
      // A link pointing outside the root, or similar — treated the same as no apps, but also not watched
      return { apps: [], watch: [] }
    }
    const deepest = [...ancestors].reverse().find((a) => existsSync(join(root, a)))
    return { apps: [], watch: deepest === undefined ? [] : [deepest] }
  }

  const apps: ScannedApp[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const folderRel = `${rel}/${e.name}`
    const dir = join(root, rel, e.name)
    /*
     * Checked with the **same guard** as folder watching (DirWatchers). If a link pointing outside
     * the root were accepted here alone, the result would be a half-working app that gets
     * discovered but never re-read when it changes — because watching rejects that same link.
     * What gets discovered and what gets watched have to agree.
     */
    try {
      if (!assertExistingPathSync(root, folderRel).isDirectory()) continue
    } catch (err) {
      if (isMissingPathError(err)) continue // disappeared while being read
      apps.push(invalid(e.name, dir, 'the app folder is a link that points outside its root — Centralu does not follow it'))
      continue
    }
    apps.push(readApp(root, folderRel, e.name, dir))
  }
  apps.sort((a, b) => a.folder.localeCompare(b.folder))
  return { apps, watch: [rel, ...apps.flatMap((a) => [`${rel}/${a.folder}`, ...subfoldersOf(root, `${rel}/${a.folder}`)])] }
}

/** The cap on subfolders watched per app folder — watching shares a budget of 256 (`MAX_WATCHED_DIRS`) per project */
const SUBFOLDERS_WATCHED = 8

/**
 * The folders directly under an app folder (C-4) — where code lives, like `ui/`. Since watching is
 * not recursive (`DirWatchers`), without this an edit to `ui/index.html` in an editor would go
 * unnoticed. This looks only one level deep: a deeper change is caught by the fingerprint at the
 * end of the building session's turn (`fingerprint.ts`). Folders starting with a dot and
 * `node_modules` are not the app's code.
 */
function subfoldersOf(root: string, appRel: string): string[] {
  try {
    return readdirSync(join(root, appRel), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => `${appRel}/${d.name}`)
      .sort()
      .slice(0, SUBFOLDERS_WATCHED)
  } catch {
    return []
  }
}

function readApp(root: string, folderRel: string, folder: string, dir: string): ScannedApp {
  const manifestRel = `${folderRel}/${MANIFEST_FILE}`
  let text: string
  try {
    if (!assertExistingPathSync(root, manifestRel).isFile()) {
      return invalid(folder, dir, `${MANIFEST_FILE} is not a file`)
    }
    text = readCapped(join(root, manifestRel))
  } catch (err) {
    if (isMissingPathError(err) || isFsMissing(err)) {
      // This might be a folder that is still being created — state what is missing instead of hiding it
      return invalid(folder, dir, `there is no ${MANIFEST_FILE}`)
    }
    return invalid(folder, dir, `could not read ${MANIFEST_FILE}: ${(err as Error).message}`)
  }
  const hash = createHash('sha256').update(text).digest('hex')
  const parsed = parseManifest(text)
  if (!parsed.ok) return { folder, dir, hash, manifest: null, error: parsed.error, warnings: parsed.warnings }
  /*
   * The folder name is the id. This lets the filesystem prevent two apps with the same id from
   * existing in the same place (folder names cannot collide), and lets a person tell which app is
   * which just by looking at the folder.
   */
  if (parsed.manifest.id !== folder) {
    return {
      folder, dir, hash, manifest: null, warnings: parsed.warnings,
      error: `the folder name (${folder}) and the manifest's id (${parsed.manifest.id}) differ — the folder name is the app's id`,
    }
  }
  return { folder, dir, hash, manifest: parsed.manifest, error: null, warnings: parsed.warnings }
}

function invalid(folder: string, dir: string, error: string): ScannedApp {
  return { folder, dir, hash: null, manifest: null, error, warnings: [] }
}

/** A manifest over the size cap is never read to the end (see the MAX_MANIFEST_BYTES comment) */
function readCapped(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size > MAX_MANIFEST_BYTES) {
      throw new Error(`it is over ${MAX_MANIFEST_BYTES} bytes (${size} bytes)`)
    }
    const buf = Buffer.alloc(size)
    let off = 0
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off)
      if (n === 0) break
      off += n
    }
    return buf.subarray(0, off).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function isFsMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
