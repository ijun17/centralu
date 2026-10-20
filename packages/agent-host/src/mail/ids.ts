import { randomBytes } from 'node:crypto'

/**
 * The ids of threads and messages (docs/plans/mailbox.md §11.4): `<hostId>.t_<ulid>` and `<hostId>.m_<ulid>`, minted by
 * the host that created the thread or sent the message, so an id is unique everywhere and a forwarded copy is the same
 * row (`INSERT OR IGNORE` by id, §11.6). A ULID sorts by time, then by a counter within one millisecond.
 *
 * The host id is the one a hub already keeps (`hubSelfId`, `hub-` and 8 hex digits). No dependency for the ULID: it is
 * 26 characters of Crockford's base32, 10 of time and 16 of randomness.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ID_RE = /^([a-z0-9][a-z0-9-]*)\.(t|m)_([0-9A-HJKMNP-TV-Z]{26})$/

export type MailIdKind = 'thread' | 'message'

export type ParsedMailId = { host: string; kind: MailIdKind; ulid: string }

/**
 * Makes ULIDs in strictly increasing order, also within one millisecond and when the clock steps back: the next one
 * is the last plus one. `random` is injectable for tests
 */
export class UlidMaker {
  private time = -1
  /** The 16 random digits (5 bits each) of the last ULID, most significant first */
  private digits: number[] = []

  constructor(private readonly random: (bytes: number) => Uint8Array = randomBytes) {}

  next(now: number): string {
    if (now > this.time) {
      this.time = now
      this.digits = this.freshDigits()
    } else {
      this.increment()
    }
    return encodeTime(this.time) + this.digits.map((d) => CROCKFORD[d] ?? '0').join('')
  }

  private freshDigits(): number[] {
    const bytes = this.random(10)
    // 80 bits, five at a time. A fresh value starts below the top so a counter in the same millisecond has room to count
    let bits = ''
    for (const b of bytes) bits += b.toString(2).padStart(8, '0')
    const out: number[] = []
    for (let i = 0; i < 16; i++) out.push(parseInt(bits.slice(i * 5, i * 5 + 5), 2))
    out[0] = (out[0] ?? 0) & 0x0f
    return out
  }

  private increment(): void {
    for (let i = this.digits.length - 1; i >= 0; i--) {
      const digit = this.digits[i] ?? 0
      if (digit < 31) {
        this.digits[i] = digit + 1
        return
      }
      this.digits[i] = 0
    }
    // 2^80 ids in one millisecond: carry into the time rather than repeat
    this.time += 1
    this.digits = this.freshDigits()
  }
}

function encodeTime(time: number): string {
  let out = ''
  let t = Math.max(0, Math.floor(time))
  for (let i = 0; i < 10; i++) {
    out = (CROCKFORD[t % 32] ?? '0') + out
    t = Math.floor(t / 32)
  }
  return out
}

export const threadIdOf = (host: string, ulid: string): string => `${host}.t_${ulid}`
export const messageIdOf = (host: string, ulid: string): string => `${host}.m_${ulid}`

/** What an id is made of, or null for text that is not a mail id: a thread id or a message id of any host */
export function parseMailId(id: string): ParsedMailId | null {
  const m = ID_RE.exec(id)
  const [, host, kind, ulid] = m ?? []
  return host !== undefined && ulid !== undefined ? { host, kind: kind === 't' ? 'thread' : 'message', ulid } : null
}
