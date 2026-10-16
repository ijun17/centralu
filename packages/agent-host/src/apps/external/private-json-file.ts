import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

/**
 * One small JSON document kept in the host's data folder that only this user may read (app secrets,
 * the imported-app marks). Both used to write it by hand, and the copies drifted (#850 item 6,
 * #841 item 2): the secrets file treated an unparseable file as empty and the next write replaced it,
 * losing every value in it, and both wrote through one fixed `<file>.tmp`.
 *
 * **Reading.** A missing file is the empty document. A file that cannot be read, cannot be parsed, or
 * does not have the expected shape is moved aside as `<file>.unreadable-<ms>` and reported, and the
 * empty document is returned: nothing in it is guessed at, and nothing in it is lost, since a person
 * can recover it from the moved-aside copy (the rename keeps its 0600 mode).
 *
 * **Writing is refused while an unreadable file is still in place**, which happens only when moving it
 * aside failed. Writing over it would replace the one copy of whatever it held with a document built
 * from nothing.
 *
 * **The temp file has a name of its own per write.** During a host swap the old and the new host both
 * run for a while and may write the same file at once: with one shared `<file>.tmp`, one host's rename
 * moved the other's half-written temp file into place, and the other's rename then failed. `wx` makes
 * a name that somehow exists already an error rather than a write through it.
 */
export class PrivateJsonFile<T> {
  /** True while an unreadable file sits at `path` and could not be moved aside */
  private stuck = false

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
  ) {}

  read(): T {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.stuck = false
        return this.opts.empty()
      }
      return this.unreadable()
    }
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      return this.unreadable()
    }
    if (!this.opts.valid(doc)) return this.unreadable()
    this.stuck = false
    return doc
  }

  /** Replaces the file with `doc`. Throws, writing nothing, while an unreadable file could not be moved aside */
  write(doc: T): void {
    // Tried again first: whatever stopped the move (a held file, a person editing it) may have passed
    if (this.stuck) this.read()
    if (this.stuck) {
      throw new Error(`${this.opts.label} could not be read and could not be moved aside, so it was not overwritten. Fix or remove ${this.path}`)
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
      renameSync(tmp, this.path)
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
    chmodSync(this.path, 0o600)
  }

  private unreadable(): T {
    const aside = `${this.path}.unreadable-${Date.now()}`
    try {
      renameSync(this.path, aside)
      this.stuck = false
      console.error(`[apps] ${this.opts.label} is unreadable; moved to ${basename(aside)}. ${this.opts.lost}`)
    } catch (e) {
      // Gone in the meantime: the other host of a swap moved it aside first, and nothing is left to overwrite
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.stuck = false
        return this.opts.empty()
      }
      // Said once, not on every read: the secrets file is read for every list broadcast
      if (!this.stuck) console.error(`[apps] ${this.opts.label} is unreadable and could not be moved aside (${(e as Error).message}); it is left as it is and not written. ${this.opts.lost}`)
      this.stuck = true
    }
    return this.opts.empty()
  }
}

/** A JSON object that is not an array: the shape both documents share at the top */
export function isJsonObject(doc: unknown): doc is Record<string, unknown> {
  return !!doc && typeof doc === 'object' && !Array.isArray(doc)
}
