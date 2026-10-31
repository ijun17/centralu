import { createHash } from 'node:crypto'
import { readdirSync, statSync, type BigIntStats } from 'node:fs'
import { join } from 'node:path'
import { errnoCode } from '../../os/errors.js'
import type { AppManifest } from './manifest.js'
import { isObj } from '../../json-value.js'
import { PrivateJsonFile } from './private-json-file.js'
import { canonicalJson } from './runs.js'
import { USER_APPS_PARTS } from './discovery.js'

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
  /** The file id as a Number, the only one in a record written before `inoExact` (#562); no longer written */
  ino?: number
  /** Exact decimal file id; absent in records written before #562 */
  inoExact?: string
  /** The record of the person enabling it — the server and uses seen at that time, and their key. Null if never enabled */
  confirmed: { key: string; at: number; server: AppManifest['server']; uses: AppManifest['uses'] } | null
  /**
   * Set on a mark this host wrote because the marks were lost (#1172), not because the app was imported: the name of
   * the copy the unreadable file was moved to. Such an app may be the person's own or an import, so the gate holds it
   * as an import, but the list does not say it was imported (`AppHandover.imported`). Absent from older hosts, which
   * read it as an import not yet enabled and keep the field when they confirm it.
   */
  lost?: string
}

type Doc = Record<string, ImportMark>

/** How long a failed attempt to record a loss waits before trying again with nothing changed */
const RETRY_MS = 1_000

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
  /*
   * A corrupt file is moved aside, not overwritten, and reported: a person can recover it from the
   * moved-aside original. But this file is also the only record of which apps were imported at all, so
   * without it an imported app reads as the person's own and runs unasked (#1172). So when the file is
   * gone and a copy moved aside is in the data folder, every user-folder app there at that moment gets a
   * mark of its own (`lost`) in a new file, and asks once before it runs again. The new file is the
   * record from then on: an app made later is not held, and removing the copy changes nothing. While no
   * such file can be written (the file cannot be read at all, the data folder cannot be listed), every
   * app without a mark is held instead (`doubt`). The file is 0600 because a source address might be a
   * link containing a token.
   */
  private file: PrivateJsonFile<Doc>
  private doc: Doc = {}
  /** Why an app without a mark cannot be taken for the person's own, found by the last read */
  private doubtReason: string | null = null
  /**
   * What the file looked like at the last read or write (or, while there is none, the data folder, where a copy would
   * appear): it is read again when that changes, so a file a person restored, or the other host of a swap wrote, is
   * what counts, and a write never puts the marks read before over it. A stat per lookup, no read or listing.
   */
  private seen = ''
  /**
   * When recording a loss failed (`afterLoss`), the time to try again even if nothing changed: an EMFILE passes. Not at
   * every lookup: a list asks once per app, and each try lists two folders and stats every app
   */
  private retryAt: number | null = null
  /**
   * Why each copy this host moved aside could not be read (#944), for the reason its held apps give. Known only to the
   * host that moved it: after a restart the reason names the copy without saying why
   */
  private whyMoved = new Map<string, string>()

  constructor(private readonly dataRoot: string) {
    this.file = new PrivateJsonFile(join(dataRoot, IMPORTS_FILE), {
      label: IMPORTS_FILE,
      empty: () => ({}),
      valid: (doc): doc is Doc => isObj(doc),
      lost: 'It is the record of which apps were imported, so apps without a mark do not start unasked meanwhile',
      indent: 2,
    })
    this.load()
  }

  /**
   * Why an app with no mark cannot be taken for the person's own right now, or null (#1172): the file is still in place
   * and cannot be read (its marks come back once it reads), or it is gone and whether a copy was moved aside cannot be
   * told, or the marks holding the apps could not be written.
   */
  doubt(): string | null {
    this.current()
    return this.doubtReason
  }

  /** The reason an app holds for a mark written because the marks were lost (`ImportMark.lost`) */
  lostReason(copy: string): string {
    const why = this.whyMoved.get(copy)
    return `Centralu could not read ${this.file.path}${why ? ` (${why})` : ''} and moved it to ${join(this.dataRoot, copy)}, so it cannot tell whether this app was imported. Review what it runs, then enable it`
  }

  /**
   * The mark on this folder. A folder that is not the one marked (recreated under the same id outside Centralu, or one
   * that cannot be read) keeps the import mark and loses its confirmation (#838): no mark at all would make the gate
   * trust it as the person's own app, so replacing an enabled import's folder ran whatever the new one holds. Removing
   * an app through Centralu drops its mark (`drop`), so an app the person makes under that id afterwards is unmarked.
   */
  get(appId: string, dir: string): ImportMark | null {
    const m = this.current()[appId]
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
    this.current()
    this.doc[appId] = { source, importedAt: at, inoExact: ino.toString(), confirmed: null }
    this.write()
  }

  /**
   * Records that the person enabled it — the declaration seen at that time, together with its key. An app with no mark
   * is held only while the marks are in doubt (`doubt`), when nothing can be written: that refusal is what enabling it says
   */
  confirm(appId: string, dir: string, manifest: Pick<AppManifest, 'server' | 'uses'>, at = Date.now()): void {
    const m = this.current()[appId]
    if (!m) {
      if (this.doubtReason) this.write() // throws, saying why
      return
    }
    const ino = statSync(dir, { bigint: true }).ino
    /*
     * Confirmation is an explicit write path: it binds the mark to this folder only after a fresh review of what the
     * folder holds now (`enable` checks the key against the current manifest), a legacy record or a folder recreated
     * under the import's id alike (#838). Nothing changes stored state during get().
     */
    const { ino: _number, ...rest } = m
    this.doc[appId] = {
      ...rest,
      inoExact: ino.toString(),
      confirmed: { key: reviewKey(manifest), at, server: manifest.server, uses: manifest.uses },
    }
    this.write()
  }

  drop(appId: string): void {
    if (!(appId in this.current())) return
    delete this.doc[appId]
    this.write()
  }

  private matchingMark(m: ImportMark, ino: string): ImportMark | null {
    if (m.inoExact !== undefined) return ino === m.inoExact ? m : null
    if (m.ino !== undefined && Number.isSafeInteger(m.ino)) return ino === m.ino.toString() ? m : null
    // A rounded legacy id cannot prove this is the confirmed folder. Returning null
    // would make AppHandover.gate trust it as a user-folder app. Preserve the import
    // mark and require review; the stored record stays untouched until an explicit write.
    return { ...m, confirmed: null }
  }

  /**
   * The marks, read again while the last read could not use the file (a read error, or a damaged file that could not
   * be moved aside), or when the file changed since (`seen`): once it can be read, its marks are back, and a write never
   * puts a document built from the empty stand-in, or from an older read, over them.
   */
  private current(): Doc {
    if (this.file.unreadable || this.stamp() !== this.seen || (this.retryAt !== null && Date.now() >= this.retryAt)) this.load()
    return this.doc
  }

  private load(): void {
    // Taken before the read: a write that lands between the two is then read by the next lookup, not missed
    const before = this.stamp()
    this.doc = this.file.read()
    this.doubtReason = null
    this.seen = before
    this.retryAt = null
    const met = this.file.trouble
    if (met?.movedTo && met.reason) this.whyMoved.set(met.movedTo, met.reason)
    if (this.file.unreadable) {
      this.doubtReason = met?.reason
        ? `${this.file.path} could not be read: ${met.reason}. Whether this app was imported is not known, so it stays off until that file can be read again`
        : `${this.file.path} could not be read, so whether this app was imported is not known. It stays off until that file can be read again`
    } else if (stat(this.file.path) === null) {
      this.afterLoss()
    }
  }

  /**
   * No file: a first run, or a file moved aside, by this read, by the other host of a swap, or by an older build long
   * ago. A copy in the data folder tells them apart. When there is one, every app in the user folder now is held with a
   * `lost` mark, written at once, so a restart, a rollback and a removed copy all find the apps held.
   */
  private afterLoss(): void {
    let copy: string | null
    try {
      copy = newestCopy(this.dataRoot)
    } catch (e) {
      this.doubtReason = `The data folder ${this.dataRoot} could not be listed (${errnoCode(e) ?? 'unknown error'}), so whether this app was imported is not known. It stays off until that folder can be listed`
      this.retryLater()
      return
    }
    if (copy === null) return
    try {
      const held = heldMarks(join(this.dataRoot, ...USER_APPS_PARTS), copy)
      /*
       * Only if there is still no file, decided by the link that puts it in place (`create`): a file the other host of a
       * swap wrote, or the person put back, since the read is the record, and the next lookup reads it (`seen` differs)
       */
      if (!this.file.create(held)) return
      this.doc = held
      this.seen = this.stamp()
      const ids = Object.keys(held)
      console.error(`[apps] ${IMPORTS_FILE} was moved to ${copy}; ${ids.length} user-folder app(s) are held until each is reviewed and enabled${ids.length ? `: ${ids.join(', ')}` : ''}`)
    } catch (e) {
      this.doubtReason = `${this.file.path} was moved to ${join(this.dataRoot, copy)}, and the apps it may have held could not be recorded (${errnoCode(e) ?? 'unknown error'}), so whether this app was imported is not known. Review what it runs, then enable it`
      this.retryLater()
    }
  }

  /** Tried again when the file or the data folder changes, or a second from now, whichever is first */
  private retryLater(): void {
    this.seen = this.stamp()
    this.retryAt = Date.now() + RETRY_MS
  }

  private stamp(): string {
    const f = stat(this.file.path)
    if (f) return `file ${f.ino} ${f.mtimeNs} ${f.size}`
    const d = stat(this.dataRoot)
    return d ? `folder ${d.ino} ${d.mtimeNs}` : 'none'
  }

  private write(): void {
    /*
     * While the marks are in doubt the document is built from nothing known: written, it would become the record, and
     * the apps a lost file held would run unasked. A file still in place refuses the write itself, with its own words
     */
    if (this.doubtReason && !this.file.unreadable) throw new Error(this.doubtReason)
    this.file.write(this.doc)
    this.seen = this.stamp()
  }
}

/** A `lost` mark for every app folder in the user folder; one whose folder cannot be read is held, never skipped */
function heldMarks(appsDir: string, copy: string): Doc {
  let names: string[]
  try {
    names = readdirSync(appsDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
  const at = Date.now()
  const doc: Doc = {}
  for (const name of names) {
    if (name.startsWith('.')) continue // never an app folder (discovery skips it)
    const dir = join(appsDir, name)
    let ino: bigint | null = null
    try {
      const s = statSync(dir, { bigint: true })
      if (!s.isDirectory()) continue
      ino = s.ino
    } catch {
      // Held all the same, under an id no folder has: one that cannot be looked at now may be readable later
    }
    doc[name] = { source: dir, importedAt: at, inoExact: ino === null ? '' : ino.toString(), confirmed: null, lost: copy }
  }
  return doc
}

/** The newest `app-imports.json.unreadable-<ms>` `PrivateJsonFile` moved aside in the data folder, or null. Throws when the folder cannot be listed */
function newestCopy(dataRoot: string): string | null {
  let names: string[]
  try {
    names = readdirSync(dataRoot)
  } catch (e) {
    // No data folder: nothing was ever written, so nothing was moved aside. Any other failure says nothing either way
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  let newest: { name: string; at: number } | null = null
  for (const name of names) {
    const at = Number(/^app-imports\.json\.unreadable-(\d+)$/.exec(name)?.[1])
    if (Number.isSafeInteger(at) && (!newest || at > newest.at)) newest = { name, at }
  }
  return newest?.name ?? null
}

let unseen = 0

/**
 * Null only for a path that is not there. One that cannot be looked at (EACCES) is not taken for absent: that would
 * read as a first run. It reads as a stat that never matches, so each lookup reads the file again (and finds it stuck)
 */
function stat(path: string): Pick<BigIntStats, 'ino' | 'mtimeNs' | 'size'> | null {
  try {
    return statSync(path, { bigint: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { ino: -1n, mtimeNs: BigInt(++unseen), size: -1n }
  }
}
