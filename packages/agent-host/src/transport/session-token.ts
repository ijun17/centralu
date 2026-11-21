import { createHmac } from 'node:crypto'
import { isSessionId } from '@cc/protocol'
import { sameSecret } from './http.js'

/**
 * A session's credential (#1405): what every agent the host starts finds in its environment (`CC_HOST_CREDENTIAL`, the host's
 * address in `CC_HOST_URL`), so a script the agent writes calls the host the sanctioned way. Its rights are the limited credential's,
 * no more (`method-rights.ts`); it adds attribution: the card says which session's process asked. Attribution, not proof: any process
 * of the user can read an agent's environment (docs/security-boundaries/keeper.md "The front door") and present another session's credential,
 * and all it fakes is the name on the card. Derived like the bridge's (`bridge-token.ts`), with a label of its own; shape
 * `ccs1:<sessionId>:<mac>`, a session id never contains `:` (`isSessionId`)
 */
const PREFIX = 'ccs1'

function mac(hostToken: string, sessionId: string): string {
  return createHmac('sha256', hostToken).update(`centralu session token v1\0${sessionId}`).digest('base64url')
}

export function sessionToken(hostToken: string, sessionId: string): string {
  return `${PREFIX}:${sessionId}:${mac(hostToken, sessionId)}`
}

export function sessionOfToken(hostToken: string, given: string): string | null {
  const [prefix, sessionId, givenMac, ...rest] = given.split(':')
  if (prefix !== PREFIX || sessionId === undefined || givenMac === undefined || rest.length > 0) return null
  if (!isSessionId(sessionId)) return null
  return sameSecret(givenMac, mac(hostToken, sessionId)) ? sessionId : null
}
