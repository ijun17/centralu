import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppManifest } from './manifest.js'
import { canonicalJson } from './runs.js'

/**
 * The mark on an imported app and the person's confirmation of it (M4 E-3, decision 3) — lives on
 * the **host side**.
 *
 * A user-folder app is trusted because a person put it there (decision 3). Only an app imported from
 * outside gets asked about separately: an imported app arrives disabled, and is enabled only after
 * the person sees what it runs (`server`) and what it claims to use (`uses`). The record of being
 * enabled carries a key (`reviewKey`) for what was seen at that moment — if the manifest's `server`
 * or `uses` changes later, the key no longer matches and it is asked again.
 *
 * Why the mark lives outside the app folder (as a file in the data folder): a mark inside the app
 * folder could be deleted or edited by the app's own code, and an imported bundle could arrive
 * already carrying "already confirmed". The mark is tied to that folder's inode instead — so a
 * different folder that comes to exist under the same id (an app deleted and recreated) never
 * inherits the old mark. Renaming or moving the folder (on the same filesystem) preserves the inode.
 */

export const IMPORTS_FILE = 'app-imports.json'

export type ImportMark = {
  /** Where it came from — exactly as shown to the person (a path or an https address) */
  source: string
  importedAt: number
  /** Kept as a Number for older hosts during swaps and rollbacks (add first, remove later). */
  ino: number
  /** Exact decimal file id; absent in records written by older hosts. */
  inoExact?: string
  /** The record of the person enabling it — the server and uses seen at that time, and their key. Null if never enabled */
  confirmed: { key: string; at: number; server: AppManifest['server']; uses: AppManifest['uses'] } | null
}

type Doc = Record<string, ImportMark>

/**
 * The key for what a person has seen — the manifest's `server` (command and args) and `uses`. A
 * hash of the JSON with key order fixed: if the same declaration read as "changed" just because its
 * key order differed, the person would see a re-confirmation prompt for no reason.
 */
export function reviewKey(m: Pick<AppManifest, 'server' | 'uses'>): string {
  return createHash('sha256')
    .update(canonicalJson({ server: { command: m.server.command, args: m.server.args }, uses: m.uses }))
    .digest('hex')
}

export class ImportBook {
  private path: string
  private doc: Doc

  constructor(dataRoot: string) {
    this.path = join(dataRoot, IMPORTS_FILE)
    this.doc = this.read()
  }

  /**
   * The mark on this folder. A folder that is not the one marked (recreated under the same id outside Centralu, or one
   * that cannot be read) keeps the import mark and loses its confirmation (#838): no mark at all would make the gate
   * trust it as the person's own app, so replacing an enabled import's folder ran whatever the new one holds. Removing
   * an app through Centralu drops its mark (`drop`), so an app the person makes under that id afterwards is unmarked.
   */
  get(appId: string, dir: string): ImportMark | null {
    const m = this.doc[appId]
    if (!m) return null
    try {
      return this.matchingMark(m, statSync(dir, { bigint: true }).ino.toString()) ?? { ...m, confirmed: null }
    } catch {
      return { ...m, confirmed: null }
    }
  }

  /** Records that this was imported — recorded as disabled */
  mark(appId: string, dir: string, source: string, at = Date.now()): void {
    const ino = statSync(dir, { bigint: true }).ino
    // Keep the legacy number: the previous host compares statSync(dir).ino === m.ino.
    // Replacing it with a string would drop the import mark and bypass that host's gate.
    this.doc[appId] = { source, importedAt: at, ino: Number(ino), inoExact: ino.toString(), confirmed: null }
    this.write()
  }

  /** Records that the person enabled it — the declaration seen at that time, together with its key */
  confirm(appId: string, dir: string, manifest: Pick<AppManifest, 'server' | 'uses'>, at = Date.now()): void {
    const m = this.doc[appId]
    if (!m) return
    const ino = statSync(dir, { bigint: true }).ino
    /*
     * Confirmation is an explicit write path: it binds the mark to this folder only after a fresh review of what the
     * folder holds now (`enable` checks the key against the current manifest), a legacy record or a folder recreated
     * under the import's id alike (#838). Nothing changes stored state during get().
     */
    this.doc[appId] = {
      ...m,
      ino: Number(ino),
      inoExact: ino.toString(),
      confirmed: { key: reviewKey(manifest), at, server: manifest.server, uses: manifest.uses },
    }
    this.write()
  }

  drop(appId: string): void {
    if (!(appId in this.doc)) return
    delete this.doc[appId]
    this.write()
  }

  private matchingMark(m: ImportMark, ino: string): ImportMark | null {
    if (m.inoExact !== undefined) return ino === m.inoExact ? m : null
    if (Number.isSafeInteger(m.ino)) return ino === m.ino.toString() ? m : null
    // A rounded legacy id cannot prove this is the confirmed folder. Returning null
    // would make AppHandover.gate trust it as a user-folder app. Preserve the import
    // mark and require review; the stored record stays untouched until an explicit write.
    return { ...m, confirmed: null }
  }

  private read(): Doc {
    if (!existsSync(this.path)) return {}
    try {
      const doc = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Doc) : {}
    } catch {
      /*
       * A corrupt file — losing the marks tips things toward an imported app running without
       * confirmation. So an unreadable file is moved aside instead, and reported. A person can
       * recover it from the moved-aside original. (There is no way to forcibly withdraw every
       * confirmation: which apps were imported at all lives in that same file.)
       */
      const aside = `${this.path}.unreadable-${Date.now()}`
      try {
        renameSync(this.path, aside)
      } catch {
        // Even if it cannot be moved, it is still unreadable either way
      }
      console.error(`[apps] ${IMPORTS_FILE} is unreadable; moved to ${aside}. Imported apps lost their marks`)
      return {}
    }
  }

  /** Creates the temp file at 0600 and moves it into place — a source address might be a link containing a token */
  private write(): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.doc, null, 2), { mode: 0o600 })
    renameSync(tmp, this.path)
    chmodSync(this.path, 0o600)
  }
}
