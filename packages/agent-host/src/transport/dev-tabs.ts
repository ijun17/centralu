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

/** `holders`: the sockets that presented its key, every tab the key was copied into (a duplicated tab copies sessionStorage) */
type Grant = DevTab & { hash: string; holders: Set<number> }

const hashOf = (key: string): string => createHash('sha256').update(key).digest('hex')

export class DevTabs {
  /** By the key's hash: the key itself is never kept */
  private readonly grants = new Map<string, Grant>()
  /** The pairing code each socket was given, until its card is raised */
  private readonly codes = new Map<number, string>()

  constructor(
    private readonly now: () => number = Date.now,
    /** host.log: each grant and revoke by its id and origin, never its key */
    private readonly log: (line: string) => void = (line) => console.error(line),
  ) {}

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

  /**
   * The person allowed it: a new key, held by this socket, in place of one the socket held. That one's key restores nothing
   * more unless another tab still holds it, which keeps its trust
   */
  grant(origin: string, socket: number): { key: string; expiresAt: number } {
    this.sweep()
    this.release(socket, true)
    const key = randomBytes(32).toString('base64url')
    const grantedAt = this.now()
    const expiresAt = grantedAt + DEV_TAB_TRUST_MS
    const id = randomBytes(4).toString('hex')
    this.grants.set(hashOf(key), { id, origin, grantedAt, expiresAt, hash: hashOf(key), holders: new Set([socket]) })
    this.log(`[dev-tabs] trusted the dev browser tab at ${origin} (grant ${id}) until ${new Date(expiresAt).toISOString()}`)
    return { key, expiresAt }
  }

  /**
   * A tab's hello with its key: this socket holds the grant issued to this origin, unexpired and not taken back. Every
   * socket that presents the key holds it, so a duplicated tab (or `window.open`, which copies sessionStorage) sends as
   * the person too, as its hello said (#2569); taking the grant back or its expiry ends it for all of them
   */
  restore(key: string, origin: string | null, socket: number): boolean {
    this.sweep()
    const g = this.grants.get(hashOf(key))
    if (!g || g.origin !== origin) return false
    this.release(socket)
    g.holders.add(socket)
    return true
  }

  /** Whether a call on this socket is the person's: it holds a grant that has not expired */
  trusts(socket: number): boolean {
    for (const g of this.grants.values()) if (g.holders.has(socket)) return g.expiresAt > this.now()
    return false
  }

  /**
   * The socket is gone: its grant waits for a tab's next hello, its unused code goes. `dropHeld`: a grant only this
   * socket held goes too (a new Allow replaces it)
   */
  release(socket: number, dropHeld = false): void {
    this.codes.delete(socket)
    for (const [hash, g] of this.grants) {
      if (!g.holders.delete(socket)) continue
      if (dropHeld && g.holders.size === 0) this.grants.delete(hash)
    }
  }

  list(): DevTab[] {
    this.sweep()
    return [...this.grants.values()].map(({ id, origin, grantedAt, expiresAt }) => ({ id, origin, grantedAt, expiresAt })).sort((a, b) => a.grantedAt - b.grantedAt)
  }

  /** Taken back from Settings: the next call of every socket holding it is a script's again */
  revoke(id: string): void {
    for (const [hash, g] of this.grants) {
      if (g.id !== id) continue
      this.grants.delete(hash)
      this.log(`[dev-tabs] took back the trust of the dev browser tab at ${g.origin} (grant ${id}), held by ${g.holders.size} socket(s)`)
    }
  }

  private sweep(): void {
    const now = this.now()
    for (const [hash, g] of this.grants) if (g.expiresAt <= now) this.grants.delete(hash)
  }
}
