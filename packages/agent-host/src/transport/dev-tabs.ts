import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { DevTab } from '@cc/protocol'

/**
 * The dev browser tabs the person trusted to send as them (docs/security-boundaries/dev-browser-tabs.md): the one place
 * that says whether a socket holding the limited credential is such a tab. Only attribution: the socket keeps the limited
 * credential's rights. Kept in memory only, so a restart of the host ends every trust and the tab asks again; a stored
 * key would be a credential at rest that outlives the tab it was given to.
 */

/** Local Vite dev origins only: a proxy, the app's WebView or an origin-less program never enters this path */
const DEV_TAB_ORIGINS: ReadonlySet<string> = new Set(['http://127.0.0.1:5173', 'http://127.0.0.1:5174', 'http://localhost:5173', 'http://localhost:5174'])

export function isDevTabOrigin(origin: string | null | undefined): origin is string {
  return origin != null && DEV_TAB_ORIGINS.has(origin)
}

/** The owner's bound (#2469): a trust ends when its tab closes (the key lives in the tab's sessionStorage), at the latest after this */
export const DEV_TAB_TRUST_MS = 24 * 60 * 60_000

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

type Grant = DevTab & { hash: string; holder: number | null }

const hashOf = (key: string): string => createHash('sha256').update(key).digest('hex')

export class DevTabs {
  /** By the key's hash: the key itself is never kept */
  private readonly grants = new Map<string, Grant>()
  /** The pairing code each socket was given, until its card is raised */
  private readonly codes = new Map<number, string>()

  constructor(private readonly now: () => number = Date.now) {}

  /** A code the host chose, shown in the tab and on the card: a program cannot pick the code the person compares */
  issueCode(socket: number): string {
    const pick = () => Array.from({ length: 3 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
    const code = `${pick()}-${pick()}`
    this.codes.set(socket, code)
    return code
  }

  /** Whether `code` is the one this socket was given; used up either way, so one code raises one card */
  takeCode(socket: number, code: string): boolean {
    const given = this.codes.get(socket)
    this.codes.delete(socket)
    return given !== undefined && given === code
  }

  /** The person allowed it: a new key, held by this socket, in place of one the socket held, whose key restores nothing more */
  grant(origin: string, socket: number): { key: string; expiresAt: number } {
    this.sweep()
    const key = randomBytes(32).toString('base64url')
    const grantedAt = this.now()
    const expiresAt = grantedAt + DEV_TAB_TRUST_MS
    for (const [hash, g] of this.grants) if (g.holder === socket) this.grants.delete(hash)
    this.grants.set(hashOf(key), { id: randomBytes(4).toString('hex'), origin, grantedAt, expiresAt, hash: hashOf(key), holder: socket })
    return { key, expiresAt }
  }

  /**
   * A reconnecting tab's hello: the trust moves to this socket for a key issued to this origin, unexpired and not taken
   * back. One socket holds a key at a time, the latest hello: a copy of the key replayed elsewhere takes it from the tab
   * it was given to, whose sends then show as a script's
   */
  restore(key: string, origin: string | null, socket: number): boolean {
    this.sweep()
    const g = this.grants.get(hashOf(key))
    if (!g || g.origin !== origin) return false
    this.release(socket)
    g.holder = socket
    return true
  }

  /** Whether a call on this socket is the person's: it holds a grant that has not expired */
  trusts(socket: number): boolean {
    for (const g of this.grants.values()) if (g.holder === socket) return g.expiresAt > this.now()
    return false
  }

  /** The socket is gone: its grant waits for the tab's next hello, its unused code goes */
  release(socket: number): void {
    this.codes.delete(socket)
    for (const g of this.grants.values()) if (g.holder === socket) g.holder = null
  }

  list(): DevTab[] {
    this.sweep()
    return [...this.grants.values()].map(({ id, origin, grantedAt, expiresAt }) => ({ id, origin, grantedAt, expiresAt })).sort((a, b) => a.grantedAt - b.grantedAt)
  }

  /** Taken back from Settings: the holding socket's next call is a script's again */
  revoke(id: string): void {
    for (const [hash, g] of this.grants) if (g.id === id) this.grants.delete(hash)
  }

  private sweep(): void {
    const now = this.now()
    for (const [hash, g] of this.grants) if (g.expiresAt <= now) this.grants.delete(hash)
  }
}
