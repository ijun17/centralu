import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { folderFingerprint, walkCode } from './fingerprint.js'

/**
 * Versioning for apps outside git (M4 E-1) — user-folder apps (including imported ones) are not in
 * a repository, so there is no way to roll them back. So **every time the code changes and the app
 * starts**, this captures one copy of the app folder and keeps only the most recent few. A project
 * app's version is git (not handled here).
 *
 * What gets captured: the same walk (`walkCode`) that the folder fingerprint (`fingerprint.ts`)
 * measures — names starting with a dot and `node_modules` are not the app's code, so they are
 * neither captured nor restored. That means a snapshot's fingerprint matches its code's fingerprint
 * (the same source as the list's `codeStamp`), so "this is the current version" can be checked by
 * fingerprint. Restoring large files' timestamps follows the same reasoning (large files are
 * measured by size and timestamp).
 *
 * When it captures: **right before the app starts** (that code is now the code that runs), and
 * when an imported app comes in, and right before a restore. If a version with the same fingerprint
 * already exists, it does not capture again — an app that starts again with the same code (woke up
 * from idle, died and came back) does not grow the version list.
 *
 * Where it lives: `<data folder>/app-versions/_user/<app id>/<timestamp>-<first 16 chars of the
 * fingerprint>/`, with `files/` and `meta.json` beneath it. It lives outside the app folder, so the
 * app's own code cannot alter its versions, and it survives the app being deleted (into the trash).
 */

export const VERSIONS_KEPT = 5
export const VERSIONS_REL = 'app-versions'
/** The size cap for one version — over this, it does not capture and records that instead (for an app that keeps large data in its own folder) */
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024

export type Snapshot = {
  id: string
  at: number
  /** The full folder fingerprint of this version */
  stamp: string
  files: number
  bytes: number
  /** Why it was captured — started · imported · before restore */
  reason: string
}

export class AppVersions {
  constructor(private root: string) {}

  /** An app's versions, most recent first */
  list(appId: string): Snapshot[] {
    const dir = join(this.root, appId)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const out: Snapshot[] = []
    for (const name of names) {
      if (name.startsWith('.')) continue
      try {
        const meta = JSON.parse(readFileSync(join(dir, name, 'meta.json'), 'utf8')) as Partial<Snapshot> | null
        // A record without the id and time the list sorts by is not a version this build can show or restore (#384)
        if (meta && typeof meta === 'object' && typeof meta.id === 'string' && typeof meta.at === 'number') out.push(meta as Snapshot)
      } catch {
        // A half-deleted version — do not list it
      }
    }
    return out.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
  }

  /**
   * Captures one copy of the current folder — if a version with the same fingerprint already
   * exists, does not capture and returns null. `stamp` is the fingerprint the caller just measured
   * (so it is not measured again). The fingerprint of the captured copy is measured again and
   * recorded as that version's fingerprint: even if a file changed mid-capture, the version's
   * fingerprint still matches the version's actual contents.
   */
  capture(appId: string, dir: string, reason: string, stamp = folderFingerprint(dir)): Snapshot | null {
    const kept = this.list(appId)
    if (kept.some((s) => s.stamp === stamp)) return null
    const appRoot = join(this.root, appId)
    mkdirSync(appRoot, { recursive: true })
    const tmp = join(appRoot, `.tmp-${randomUUID()}`)
    const files = join(tmp, 'files')
    mkdirSync(files, { recursive: true })
    let count = 0
    let bytes = 0
    try {
      walkCode(dir, {
        unreadable: () => {},
        more: () => {},
        dir: (r) => mkdirSync(join(files, r), { recursive: true }),
        file: (r) => {
          const from = join(dir, r)
          const st = statSync(from)
          bytes += st.size
          if (bytes > SNAPSHOT_MAX_BYTES) throw new Error(`the app folder is larger than ${SNAPSHOT_MAX_BYTES} bytes`)
          copyFileSync(from, join(files, r))
          utimesSync(join(files, r), st.atime, st.mtime)
          count++
        },
      })
      const actual = folderFingerprint(files)
      if (kept.some((s) => s.stamp === actual)) {
        rmSync(tmp, { recursive: true, force: true })
        return null
      }
      const at = Date.now()
      const id = `${at}-${actual.slice(0, 16)}`
      const snap: Snapshot = { id, at, stamp: actual, files: count, bytes, reason }
      writeFileSync(join(tmp, 'meta.json'), JSON.stringify(snap, null, 2))
      renameSync(tmp, join(appRoot, id))
      this.prune(appId)
      return snap
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true })
      throw e
    }
  }

  /**
   * Writes one version back into the app folder. It changes only what the version covers (what the
   * fingerprint measures): code files not in the version are deleted, and the version's files are
   * written back including their timestamps. Names starting with a dot and `node_modules` are left
   * untouched — the version never had them, so this does not treat that as deleting them.
   */
  restore(appId: string, id: string, dir: string): Snapshot {
    const snap = this.list(appId).find((s) => s.id === id)
    if (!snap) throw new Error('That version is no longer kept')
    const files = join(this.root, appId, id, 'files')
    const want = new Set<string>()
    const wantDirs = new Set<string>()
    walkCode(files, { unreadable: () => {}, more: () => {}, dir: (r) => void wantDirs.add(r), file: (r) => void want.add(r) })
    // Delete code files not in the version — the fingerprint of the restored folder must match the version's fingerprint
    const extraDirs: string[] = []
    walkCode(dir, {
      unreadable: () => {},
      more: () => {},
      dir: (r) => void (wantDirs.has(r) || extraDirs.push(r)),
      file: (r) => void (want.has(r) || unlinkSync(join(dir, r))),
    })
    for (const r of extraDirs.sort((a, b) => b.length - a.length)) {
      try {
        rmdirSync(join(dir, r))
      } catch {
        // Not empty — it holds something the version does not cover (a dot-name, node_modules). Leave it.
      }
    }
    for (const r of wantDirs) mkdirSync(join(dir, r), { recursive: true })
    for (const r of want) {
      const from = join(files, r)
      const to = join(dir, r)
      mkdirSync(dirname(to), { recursive: true })
      if (existsSync(to) && statSync(to).isDirectory()) rmSync(to, { recursive: true, force: true })
      copyFileSync(from, to)
      const st = statSync(from)
      utimesSync(to, st.atime, st.mtime)
    }
    return snap
  }

  /** Keeps only the most recent versions */
  private prune(appId: string): void {
    for (const old of this.list(appId).slice(VERSIONS_KEPT)) rmSync(join(this.root, appId, old.id), { recursive: true, force: true })
  }
}
