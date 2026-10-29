import type { Os } from '../os/port.js'
import { asObj } from '../json-value.js'
import { encodeUsedRecord, parseUsedRecords, type UsedCredentials, type UsedRecord } from './serve-credentials.js'

/**
 * The file of full credentials a socket said hello with on a `centralu serve` host (#1712), next to `serve.json`.
 *
 * Why it exists: the host keeps this record in memory (`UsedCredentials`) and a hub reads it every 30 seconds, so a
 * program of the machine's user that paired, used full rights, withdrew and stopped the host in between left no trace.
 * A record is added here BEFORE the socket gets its rights, and a host that starts again reads it back, so the next
 * `host.credentials` reports it as it would have had the host stayed up.
 *
 * Lines only ever added at the end, one JSON object each (`encodeUsedRecord`); a reader skips any line it cannot read.
 * An older build does not know the file and leaves it alone, and this one reads whatever lines it finds, so nothing
 * here breaks the build that may still be serving during a host swap. The file holds what `serve.json` already holds
 * beside it (the verifier, never the credential), with the same rights.
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

const codeOf = (e: unknown): string => {
  const c = asObj(e).code
  return typeof c === 'string' ? c : 'error'
}

export class UsedCredentialsFile {
  private lines = 0

  constructor(
    private readonly path: string,
    private readonly used: UsedCredentials,
    private readonly os: Os,
    private readonly max = 256,
    private readonly log: (line: string) => void = (l) => console.error(l),
  ) {}

  /** Reads what a host before this one wrote into `used`, and shortens the file when it holds far more lines than are kept (a rewrite can drop a line that another host, in a swap, writes at that moment: so it is rare) */
  load(): void {
    const records = this.read()
    if (!records) return
    this.used.load(records)
    this.lines = records.length
    if (this.lines > this.max * REWRITE_AT) this.rewrite()
  }

  /**
   * Takes in what another host of this folder wrote since (in a swap, the host being replaced goes on serving until the
   * new one holds the folder's lock), before a report is made; what is known is not counted twice. Shortens nothing
   */
  refresh(): void {
    const records = this.read()
    if (records) this.used.load(records)
  }

  private read(): UsedRecord[] | null {
    try {
      return parseUsedRecords(this.os.files.readFileSync(this.path, 'utf8'))
    } catch (e) {
      if (codeOf(e) !== 'ENOENT') this.log(`[agent-host] the file of used credentials cannot be read (${codeOf(e)}); it starts empty`)
      return null
    }
  }

  /** Writes `record` down, at the end of the file. Synchronous, so it is on disk before the caller goes on; never throws */
  add(record: UsedRecord): void {
    try {
      this.os.files.appendFileSync(this.path, encodeUsedRecord(record), { mode: 0o600 })
      this.lines++
    } catch (e) {
      this.log(`[agent-host] a used full credential could not be written down (${codeOf(e)}); the hubs are still told`)
      return
    }
    if (this.lines > this.max * REWRITE_AT) this.rewrite()
  }

  /** The file again from the records kept, the oldest dropped: a new file moved over the old, so a stop in the middle loses nothing */
  private rewrite(): void {
    const records = this.used.records()
    try {
      const tmp = `${this.path}.${process.pid}.tmp`
      this.os.files.writeFileSync(tmp, records.map(encodeUsedRecord).join(''), { mode: 0o600 })
      try {
        this.os.files.renameSync(tmp, this.path)
      } catch (e) {
        this.os.files.rmSync(tmp, { force: true })
        throw e
      }
      this.lines = records.length
    } catch (e) {
      this.log(`[agent-host] the file of used credentials could not be shortened (${codeOf(e)})`)
    }
  }
}
