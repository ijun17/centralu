import { errnoCode } from '../os/errors.js'
import type { Os } from '../os/port.js'
import { encodeUsedRecord, parseUsedRecords, type UsedCredentials, type UsedRecord } from './serve-credentials.js'

/**
 * The file of full credentials a socket said hello with on a `centralu serve` host (#1712), next to `serve.json`.
 *
 * Why it exists: the host keeps this record in memory (`UsedCredentials`) and a hub reads it every 30 seconds, so a
 * program of the machine's user that paired, used full rights, withdrew and stopped the host in between left no trace.
 * A record is added here BEFORE the socket gets its rights, and a host that starts again reads it back, so the next
 * `host.credentials` reports it as it would have had the host stayed up.
 *
 * Lines only ever added at the end, one JSON object each (`encodeUsedRecord`), each ending in a newline (a write cut
 * short leaves a line without one, and the next record then starts on a line of its own). A reader skips any line it
 * cannot read, and reads each line once: from where it stopped last time (`refresh`), whole lines only, at most
 * `READ_AT_MOST` bytes of new ones at a time. An older build does not know the file and leaves it alone, and this one
 * reads whatever lines it finds, so nothing here breaks the build that may still be serving during a host swap. The
 * file holds what `serve.json` already holds beside it (the verifier, never the credential; for a hub's key entry the public key, #1711), with the same rights.
 *
 * Never throws: a record that cannot be written down (a full disk, a folder gone) is said on stderr and the hello goes
 * on. Refusing a hello for it would stop the person's own window and every agent's work for a disk error, which the
 * owner ruled out (#1712); the in-memory record and the event to the hubs still happen.
 */
export const USED_CREDENTIALS_FILE = 'serve-used.jsonl'

/** The file of used credentials that sits beside the `serve.json` at `serveState` */
export function usedCredentialsPath(serveState: string, os: Os): string {
  const { path } = os.paths
  return path.join(path.dirname(serveState), USED_CREDENTIALS_FILE)
}

/** More lines than `max` times this make the file be rewritten from the kept records (it only ever grows by one line per new credential) */
const REWRITE_AT = 4

/**
 * The most one read takes of what was added to the file (#1712). A program of the machine's user can append as much as it
 * likes, and a report must not hold the host's event loop for it: past this much new, the older part is skipped (and
 * said) and the newest is read. A record is under 300 bytes, so this holds thousands
 */
export const READ_AT_MOST = 1 << 20

const NEWLINE = 0x0a

const codeOf = (e: unknown): string => errnoCode(e) ?? 'error'

export class UsedCredentialsFile {
  /** Lines of the file this host has counted: those read, from the start of the file it reads now */
  private lines = 0
  /** Where the next read starts: all before it was read. And which file that is: one replaced, or shorter than this, is read from its start */
  private offset = 0
  private identity: string | null = null
  /** Whether the last read reached the end of the file: a rewrite is made only from a state that holds all of it */
  private atEnd = false
  /** Lines written since the last read that were not counted (the file was not as long as what was read, or another file): the next read counts them */
  private pending = 0

  constructor(
    private readonly path: string,
    private readonly used: UsedCredentials,
    private readonly os: Os,
    private readonly max = 256,
    private readonly log: (line: string) => void = (l) => console.error(l),
    private readonly readAtMost = READ_AT_MOST,
  ) {}

  /** Reads what a host before this one wrote into `used`, and shortens the file when it holds far more lines than are kept (a rewrite can drop a line that another host, in a swap, writes at that moment: so it is rare) */
  load(): void {
    this.refresh()
    this.shorten()
  }

  /**
   * Takes in what was added to the file since the last read, before a report is made (in a swap, the host being replaced
   * goes on serving until the new one holds the folder's lock; a program may append too). Only the new part is read,
   * whole lines of it, merged in the order of the file (`UsedCredentials.load`): the memory stays the file's newest
   * `max` records however often this is called, and what is known is not counted twice. Shortens nothing
   */
  refresh(): void {
    const taken = this.readNew()
    if (taken.length > 0) this.used.load(taken)
  }

  /**
   * Notes the records `listed` (what `serve.json` names now) does not hold as withdrawn now, writes that down, forgets the
   * note of those it names again (written too), and drops those withdrawn a week ago (`UsedCredentials.settle`): from
   * memory now, and from the file, which is rewritten then
   */
  settle(listed: readonly { id: string; verifier?: string; publicKey?: string }[], now: number = Date.now()): void {
    const { noted, restored, dropped } = this.used.settle(listed, now)
    if (noted.length + restored.length > 0) this.append([...noted, ...restored])
    if (dropped > 0) this.rewrite()
  }

  /** The whole lines added to the file since the last read, as records; none when it is not there or cannot be read */
  private readNew(): UsedRecord[] {
    let fd: number | null = null
    try {
      fd = this.os.files.openSync(this.path, 'r')
      const st = this.os.files.fstatSync(fd)
      // A folder where the file should be: opening one succeeds on Windows, and reading it does not
      if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' })
      const identity = `${st.dev}:${st.ino}`
      // Another file than the one read (a rewrite by another host, one removed and made again), or a shorter one: from its start
      if (identity !== this.identity || st.size < this.offset) {
        this.offset = 0
        this.lines = 0
        this.pending = 0
        this.identity = identity
      }
      let from = this.offset
      let cut = false
      if (st.size - from > this.readAtMost) {
        this.log(`[agent-host] ${Math.ceil((st.size - from) / 1024)} KiB were added to the file of used credentials since it was last read; the newest ${Math.floor(this.readAtMost / 1024)} KiB are taken in, the rest is skipped`)
        from = st.size - this.readAtMost
        cut = true
      }
      const buf = Buffer.alloc(st.size - from)
      let got = 0
      while (got < buf.length) {
        const n = this.os.files.readSync(fd, buf, got, buf.length - got, from + got)
        if (n === 0) break
        got += n
      }
      // What follows the last newline is a line still being written, or cut short: left for the next read
      const end = buf.subarray(0, got).lastIndexOf(NEWLINE) + 1
      this.pending = 0
      this.offset = from + end
      this.atEnd = this.offset === st.size
      // A part taken from inside the file may start inside a line: it begins at the next line
      const start = cut ? buf.indexOf(NEWLINE) + 1 : 0
      if (end <= start) return []
      const records = parseUsedRecords(buf.subarray(start, end).toString('utf8'))
      this.lines += records.length
      return records
    } catch (e) {
      this.atEnd = false
      if (codeOf(e) === 'ENOENT') {
        this.offset = 0
        this.lines = 0
        this.pending = 0
        this.identity = null
        this.atEnd = true
      } else {
        this.log(`[agent-host] the file of used credentials cannot be read (${codeOf(e)}); it starts empty`)
      }
      return []
    } finally {
      if (fd !== null) {
        try {
          this.os.files.closeSync(fd)
        } catch {
          // A handle that cannot be closed leaves nothing to undo
        }
      }
    }
  }

  /** Whether the file is not empty and its last byte is not a newline: a write that was cut short */
  private endsInTornLine(): boolean {
    let fd: number | null = null
    try {
      fd = this.os.files.openSync(this.path, 'r')
      const size = this.os.files.fstatSync(fd).size
      if (size === 0) return false
      const last = Buffer.alloc(1)
      return this.os.files.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== NEWLINE
    } catch {
      return false
    } finally {
      if (fd !== null) {
        try {
          this.os.files.closeSync(fd)
        } catch {
          // As above
        }
      }
    }
  }

  /** Writes `record` down, at the end of the file. Synchronous, so it is on disk before the caller goes on; never throws */
  add(record: UsedRecord): void {
    this.append([record])
  }

  /**
   * Adds `records` at the end of the file, on the hello's path (`add`), so it reads nothing back (#1715 recheck: on Windows
   * the first open of a file just written costs milliseconds). The memory holds these records already, so when the file is
   * exactly as long as what was read, is the file that was read, and nothing else was added while writing, the lines are
   * counted where they stand (`offset` moves past them). In any other case the offset stays and the next report's
   * `refresh` reads them with whatever else is there: a known record only moves its rank
   */
  private append(records: readonly UsedRecord[]): void {
    let fd: number | null = null
    try {
      fd = this.os.files.openSync(this.path, 'a', 0o600)
      const before = this.os.files.fstatSync(fd)
      const identity = `${before.dev}:${before.ino}`
      // A read stops after a newline: a file of exactly the length read, and the one read, ends in one and holds nothing unread. A new file (nothing read from one yet) is empty
      const caught = before.isFile() && before.size === this.offset && (identity === this.identity || (this.identity === null && before.size === 0))
      // A line cut short by a stop or a full disk has no newline: this record is not written onto its end, where neither would be read
      const lead = caught || !this.endsInTornLine() ? '' : '\n'
      const bytes = Buffer.from(lead + records.map(encodeUsedRecord).join(''), 'utf8')
      let wrote = 0
      while (wrote < bytes.length) {
        const n = this.os.files.writeSync(fd, bytes.subarray(wrote))
        if (n <= 0) throw Object.assign(new Error('nothing written'), { code: 'EIO' })
        wrote += n
      }
      // Another host's line added between the size and the write would be inside what is skipped: only the exact length counts
      if (caught && this.os.files.fstatSync(fd).size === before.size + bytes.length) {
        this.offset = before.size + bytes.length
        this.lines += records.length
        this.identity = identity
        this.atEnd = true
      } else {
        this.pending += records.length
      }
    } catch (e) {
      this.log(`[agent-host] a used full credential could not be written down (${codeOf(e)}); the hubs are still told`)
      return
    } finally {
      if (fd !== null) {
        try {
          this.os.files.closeSync(fd)
        } catch {
          // As above
        }
      }
    }
    // After the handle is closed: a rewrite moves a new file over this one
    this.shorten()
  }

  private shorten(): void {
    if (this.lines + this.pending > this.max * REWRITE_AT) this.rewrite()
  }

  /**
   * The file again from the records kept, the oldest dropped: a new file moved over the old, so a stop in the middle
   * loses nothing. Only from a state that holds the whole file as it is now (what was added since is read first): the
   * memory is the file's newest `max` records, so what is written is those
   */
  private rewrite(): void {
    this.refresh()
    if (!this.atEnd) return
    const records = this.used.records()
    const text = records.map(encodeUsedRecord).join('')
    try {
      const tmp = `${this.path}.${process.pid}.tmp`
      this.os.files.writeFileSync(tmp, text, { mode: 0o600 })
      try {
        this.os.files.renameSync(tmp, this.path)
      } catch (e) {
        this.os.files.rmSync(tmp, { force: true })
        throw e
      }
    } catch (e) {
      this.log(`[agent-host] the file of used credentials could not be shortened (${codeOf(e)})`)
      return
    }
    // The new file is this host's to read from its start: nothing of it is new, and it is not the one read before
    this.offset = 0
    this.lines = 0
    this.pending = 0
    this.identity = null
    this.readNew()
  }
}
