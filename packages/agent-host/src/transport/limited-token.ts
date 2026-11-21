import { createHmac } from 'node:crypto'
import { sameSecret } from './http.js'

/**
 * The limited credential (#1405): what every process of this user other than the window should hold; it calls the everyday methods
 * and nothing that cannot be undone or widens what runs unasked (`method-rights.ts`). Derived, not stored: an HMAC keyed by
 * the host's token with a label of its own, so the next host after a swap accepts it and holding it gives nothing toward the
 * token. The keeper derives the same value for its socket's `status`; `limited-token.test.ts` pins the vector. Shape `ccl1:<mac>`, base64url
 */
const PREFIX = 'ccl1'
const LABEL = 'centralu limited token v1'

export function limitedToken(hostToken: string): string {
  return `${PREFIX}:${createHmac('sha256', hostToken).update(LABEL).digest('base64url')}`
}

export function isLimitedToken(hostToken: string, given: string): boolean {
  if (!given.startsWith(`${PREFIX}:`)) return false
  return sameSecret(given, limitedToken(hostToken))
}
