import { randomBytes } from 'node:crypto'
import { chmodSync, linkSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { errnoCode } from '../../os/errors.js'

/**
 * One small JSON document kept in the host's data folder that only this user may read (app secrets,
 * the imported-app marks). Both used to write it by hand, and the copies drifted (#850 item 6,
 * #841 item 2): the secrets file treated an unparseable file as empty and the next write replaced it,
 * losing every value in it, and both wrote through one fixed `<file>.tmp`.
 *
 * **Reading.** A missing file is the empty document. A file that parses to something other than the
 * expected shape, or does not parse at all, is moved aside as `<file>.unreadable-<ms>` and reported,
 * and the empty document is returned: nothing in it is guessed at, and nothing in it is lost, since a
 * person can recover it from the moved-aside copy (the rename keeps its 0600 mode).
 *
 * **A file that could not be read at all is left where it is.** A read error (EACCES, EMFILE, a file
 * an antivirus scan holds on Windows) says nothing about the contents, which are most likely fine:
 * moving it aside would make every secret read as unset, and the next save would write a file
 * holding that one value. The read returns the empty document as a stand-in and says so once, and
 * the next read tries again.
 *
 * **A write is refused while the last read was such a stand-in** (a read error, or a damaged file
 * that could not be moved aside): a document built from it would replace whatever the file on disk
 * holds with what was built from nothing. A caller writes what it built from a read that succeeded.
 *
 * **The temp file has a name of its own per write.** During a host swap the old and the new host both
 * run for a while and may write the same file at once: with one shared `<file>.tmp`, one host's rename
 * moved the other's half-written temp file into place, and the other's rename then failed. `wx` makes
 * a name that somehow exists already an error rather than a write through it.
 */
export class PrivateJsonFile<T> {
  /** True while the last read returned the empty document in place of a file it could not use */
  private standIn = false
  /** The last time this file could not be used, for the screen (#944): where it went, or null when it is still in place, and why */
  private lastTrouble: FileTrouble | null = null

  constructor(
    readonly path: string,
    private readonly opts: {
      /** Which file this is, for the log (never its contents: a secrets file is one of these) */
      label: string
      /** The document a missing or unreadable file reads as. A function, so no caller shares one object */
      empty: () => T
      /** Whether a parsed value has the document's shape */
      valid: (doc: unknown) => doc is T
      /** What a reader loses when the file is unreadable, appended to the log line */
      lost: string
      /** Indentation for `JSON.stringify`; none by default */
      indent?: number
    },
  ) {
    sweepStaleTemps(path)
  }

  /** True while the last read stood in for a file that is still there and could not be used. A write is refused then */
  get unreadable(): boolean {
    return this.standIn
  }

  /**
   * The last time this file could not be used, while it matters (#944): moved aside (`movedTo`, a file name in the same
   * folder) until a write succeeds, or still in place and refusing writes (`movedTo` null) until it reads again
   */
  get trouble(): FileTrouble | null {
    return this.lastTrouble
  }

  read(): T {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if (errnoCode(e) === 'ENOENT') return this.settled(this.opts.empty())
      return this.stuck('could not be read', readFailure(e))
    }
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      // Never the parse error's message: it quotes the text it stopped at, and this may be the secrets file
      return this.damaged(NOT_JSON)
    }
    if (!this.opts.valid(doc)) return this.damaged(WRONG_SHAPE)
    return this.settled(doc)
  }

  /** Replaces the file with `doc`. Throws, writing nothing, while the last read was a stand-in */
  write(doc: T): void {
    this.put(doc, 'replace')
  }

  /**
   * Writes `doc` as the file **only while there is none**, and says whether it did. A check for the file and then
   * `write` leaves a window in which a file the other host of a swap wrote, or a person put back, is replaced by the
   * rename (#1172 review). A hard link to the finished temp file never replaces anything: EEXIST means another file
   * won, and it is left as it is. Throws, writing nothing, while the last read was a stand-in, as `write` does
   */
  create(doc: T): boolean {
    return this.put(doc, 'create')
  }

  /** Writes `doc` to a temp file of its own and moves it onto the file, or links it there while there is none (false: there is one). The temp file never stays */
  private put(doc: T, how: 'replace' | 'create'): boolean {
    if (this.standIn) {
      throw new Error(`${this.opts.label} could not be read, so it was not overwritten. Fix or remove ${this.path}`)
    }
    /*
     * The temp file is created **at 0600 from the start** and then moved into place. Writing first
     * and chmod-ing afterward would leave a window where it is readable at the default permissions
     * (usually 0644). Tightening it once more after the move covers the case where someone had
     * already loosened the permissions on an existing file.
     */
    const tmp = `${this.path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(doc, null, this.opts.indent), { mode: 0o600, flag: 'wx' })
      if (how === 'replace') renameSync(tmp, this.path)
      else linkSync(tmp, this.path)
    } catch (e) {
      if (how === 'create' && errnoCode(e) === 'EEXIST') return false
      throw e
    } finally {
      rmSync(tmp, { force: true })
    }
    // What the person re-entered is the file now: the line about the one moved aside has done its job
    this.lastTrouble = null
    chmodSync(this.path, 0o600)
    return true
  }

  private settled(doc: T): T {
    this.standIn = false
    // A file that was stuck reads again; one moved aside stays said until a write (`write`)
    if (this.lastTrouble?.movedTo === null) this.lastTrouble = null
    return doc
  }

  /** Read, but not a document (`reason`): moved aside so its bytes survive, unless it cannot be moved */
  private damaged(reason: string): T {
    const aside = `${this.path}.unreadable-${Date.now()}`
    try {
      renameSync(this.path, aside)
    } catch (e) {
      // Gone in the meantime: the other host of a swap moved it aside first, and nothing is left to overwrite
      if (errnoCode(e) === 'ENOENT') return this.settled(this.opts.empty())
      return this.stuck('is unreadable and could not be moved aside', `${reason}, and it could not be moved aside (${errnoCode(e) ?? 'unknown error'})`)
    }
    console.error(`[apps] ${this.opts.label} is unreadable (${reason}); moved to ${basename(aside)}. ${this.opts.lost}`)
    this.standIn = false
    this.lastTrouble = { movedTo: basename(aside), at: Date.now(), reason }
    return this.opts.empty()
  }

  private stuck(what: string, reason: string): T {
    // Said once, not on every read: the secrets file is read for every list broadcast
    if (!this.standIn) console.error(`[apps] ${this.opts.label} ${what} (${reason}); it is left as it is and not written until it can be read. ${this.opts.lost}`)
    if (!this.standIn) this.lastTrouble = { movedTo: null, at: Date.now(), reason }
    // Still stuck, for another reason now (held open, then damaged and held): the screen says the current one
    else if (this.lastTrouble) this.lastTrouble = { ...this.lastTrouble, reason }
    this.standIn = true
    return this.opts.empty()
  }
}

/**
 * When a private file could not be used (#944): `movedTo` is the copy it was moved aside to (a file name in the same
 * folder), or null while it is still in place; `reason` says why in a few words and never quotes the file. A copy found
 * in the folder after a restart has no reason to give
 */
export type FileTrouble = { movedTo: string | null; at: number; reason?: string }

const NOT_JSON = 'it is not valid JSON'
const WRONG_SHAPE = 'it is not the JSON object Centralu writes'

/** Why a file could not be read, in words a person can act on, with the OS's code */
function readFailure(e: unknown): string {
  const code = errnoCode(e) ?? 'unknown error'
  const words: Record<string, string> = {
    EACCES: 'Centralu may not read it',
    // On Windows also what a file another program holds (an antivirus scan) answers
    EPERM: 'access to it was refused',
    EBUSY: 'another program holds it open',
    EISDIR: 'it is a folder',
    EMFILE: 'too many files are open',
    ENFILE: 'too many files are open',
    EIO: 'the disk could not read it',
  }
  return Object.hasOwn(words, code) ? `${words[code]} (${code})` : `reading it failed (${code})`
}

/** How old a temp file of a live host has to be before it counts as left behind. A write takes milliseconds */
const STALE_TEMP_MS = 60_000

/**
 * Removes temp files a crashed write left beside `path` (they can hold secret values). A host swap
 * runs two hosts at once, and the other one may be writing right now, so a temp file goes only when
 * it is clearly not being written: its writer's pid is gone, or it is over a minute old. The pid alone
 * is not enough (a dead host's pid can be reused by another process, which would keep its temp file
 * for good), and age alone would wait a minute for nothing after a crash; either one is safe, since a
 * write that is still going on has a live writer and is milliseconds old. The fixed `<file>.tmp` older
 * builds wrote carries no pid, so it goes by age only.
 */
function sweepStaleTemps(path: string): void {
  const dir = dirname(path)
  const prefix = `${basename(path)}.`
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // no data folder yet: nothing was ever written
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
    const middle = name.slice(prefix.length, -'.tmp'.length)
    const pid = /^(\d+)-[0-9a-f]+$/.exec(middle)?.[1]
    if (pid === undefined && middle !== '') continue // not a temp name this file or an older build writes
    const file = join(dir, name)
    try {
      const old = now - statSync(file).mtimeMs > STALE_TEMP_MS
      if (old || (pid !== undefined && !alive(Number(pid)))) rmSync(file, { force: true })
    } catch {
      // Gone already, or not ours to remove: the next start looks again
    }
  }
}

function alive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it exists, it just belongs to someone else
    return errnoCode(e) === 'EPERM'
  }
}
