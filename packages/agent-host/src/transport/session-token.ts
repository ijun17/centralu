import { createHmac } from 'node:crypto'
import { isSessionId } from '@cc/protocol'
import { sameSecret } from './http.js'

/**
 * A session's credential (#1405): what every agent the host starts finds in its environment (`CC_HOST_CREDENTIAL`, with
 * the host's address in `CC_HOST_URL`), so a script the agent writes can call the host the sanctioned way instead of
 * digging a token out of the keeper.
 *
 * It has the **limited credential's rights**, no more (`method-rights.ts`): the everyday methods run, and what cannot be
 * undone raises the person's card. What it adds is attribution: the card says which session's process asked.
 *
 * **Attribution, not proof.** An agent's environment is readable by every process of the same user for as long as it
 * runs (docs/security-boundaries.md, "The front door"), so a process can present another session's credential. Its
 * rights are the same either way: all it can fake is the name on the card, which says "says it runs under".
 *
 * Derived like the bridge's (`bridge-token.ts`): an HMAC of the session id keyed by the host's token (a serve host's
 * key), with a label of its own, so the next host after a swap accepts it and it gives nothing toward the token or any
 * other credential. The shape is `ccs1:<sessionId>:<mac>`; a session id never contains `:` (`isSessionId`).
 */
const PREFIX = 'ccs1'

function mac(hostToken: string, sessionId: string): string {
  return createHmac('sha256', hostToken).update(`centralu session token v1\0${sessionId}`).digest('base64url')
}

/** The credential for the processes of `sessionId` */
export function sessionToken(hostToken: string, sessionId: string): string {
  return `${PREFIX}:${sessionId}:${mac(hostToken, sessionId)}`
}

/** The session a session credential was made for, or null if it is not one this host made */
export function sessionOfToken(hostToken: string, given: string): string | null {
  const [prefix, sessionId, givenMac, ...rest] = given.split(':')
  if (prefix !== PREFIX || sessionId === undefined || givenMac === undefined || rest.length > 0) return null
  if (!isSessionId(sessionId)) return null
  return sameSecret(givenMac, mac(hostToken, sessionId)) ? sessionId : null
}
