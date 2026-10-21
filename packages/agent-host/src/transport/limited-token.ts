import { createHmac } from 'node:crypto'
import { sameSecret } from './http.js'

/**
 * The limited credential (#1405): what every process of this user other than the window is meant to
 * hold. With it a connection calls the everyday methods and nothing that cannot be undone or that
 * widens what runs without asking (`method-rights.ts`).
 *
 * **Derived, not stored**, like the Codex bridge's (`bridge-token.ts`): an HMAC keyed by the host's
 * token, with a label no other derived value uses. The next host after a swap accepts it with nothing
 * handed over, and holding it gives nothing toward the token. The keeper derives the same value to
 * hand out on its socket's `status` (#1405 slice 4); the vector in `limited-token.test.ts` is the one
 * both sides are checked against.
 *
 * The shape is `ccl1:<mac>`, base64url without padding.
 */
const PREFIX = 'ccl1'
const LABEL = 'centralu limited token v1'

/** The limited credential that goes with `hostToken` */
export function limitedToken(hostToken: string): string {
  return `${PREFIX}:${createHmac('sha256', hostToken).update(LABEL).digest('base64url')}`
}

/** Whether `given` is the limited credential of `hostToken`, compared in constant time */
export function isLimitedToken(hostToken: string, given: string): boolean {
  if (!given.startsWith(`${PREFIX}:`)) return false
  return sameSecret(given, limitedToken(hostToken))
}
