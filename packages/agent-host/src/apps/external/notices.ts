import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Where an app may post a notice (#1161 item 1): the address of a session that called it.
 *
 * An app whose manifest declares `uses.notices` receives, with each call a session's chain started, an address for
 * that session (`_meta["centralu/notice"]`). Later, with no call in progress (a timer, a queue it drives), it posts a
 * notice there (`centralu.notify(address, text)`), and the session hears it as a report arrives. The address is the
 * session id with a MAC over (app, session) under a key kept in the data folder: the app can name only sessions that
 * called it, never one it read from a list or made up, the host checks it without keeping a table, and an address
 * still works after the host restarts (a queue that runs overnight survives a swap). Another app's address does not
 * open for this one.
 */
export const NOTICE_META = 'centralu/notice'

/** What one notice may say: a message, not data (an app's notices fill the session's context on every turn) */
export const NOTICE_MAX_CHARS = 4_000
/** Notices one app may post in a minute: a merge queue says a few an hour; a loop is stopped here */
export const NOTICES_PER_MINUTE = 10

export class NoticeAddresses {
  private key: Buffer | null = null

  /** `keyFile` is created on first use, readable by the person only */
  constructor(private readonly keyFile: string) {}

  /** An address for `sessionId`, given to app `appKey`; null when the key cannot be kept (said on the host's console) */
  mint(appKey: string, sessionId: string): string | null {
    const key = this.loadKey()
    return key ? `${sessionId}.${this.mac(key, appKey, sessionId)}` : null
  }

  /** The session an address names, if this app was given it; null otherwise */
  open(appKey: string, address: string): string | null {
    const dot = address.lastIndexOf('.')
    if (dot <= 0) return null
    const sessionId = address.slice(0, dot)
    const key = this.loadKey()
    if (!key) return null
    const want = Buffer.from(this.mac(key, appKey, sessionId))
    const got = Buffer.from(address.slice(dot + 1))
    return want.length === got.length && timingSafeEqual(want, got) ? sessionId : null
  }

  private mac(key: Buffer, appKey: string, sessionId: string): string {
    return createHmac('sha256', key).update(`${appKey}\n${sessionId}`).digest('base64url').slice(0, 32)
  }

  private loadKey(): Buffer | null {
    if (this.key) return this.key
    try {
      this.key = Buffer.from(readFileSync(this.keyFile, 'utf8').trim(), 'base64url')
      if (this.key.length >= 32) return this.key
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[apps] the notice key ${this.keyFile} does not read: ${(e as Error).message}`)
        this.key = null
        return null
      }
    }
    try {
      const fresh = randomBytes(32)
      mkdirSync(dirname(this.keyFile), { recursive: true })
      // `wx`: two hosts starting at once (a swap) keep the first one's key, and the second reads it
      writeFileSync(this.keyFile, `${fresh.toString('base64url')}\n`, { mode: 0o600, flag: 'wx' })
      this.key = fresh
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        this.key = null
        return this.loadKeyOnce()
      }
      console.error(`[apps] the notice key ${this.keyFile} could not be written: ${(e as Error).message}`)
      this.key = null
    }
    return this.key
  }

  private loadKeyOnce(): Buffer | null {
    try {
      const k = Buffer.from(readFileSync(this.keyFile, 'utf8').trim(), 'base64url')
      this.key = k.length >= 32 ? k : null
    } catch {
      this.key = null
    }
    return this.key
  }
}
