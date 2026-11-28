import { createHmac } from 'node:crypto'
import { isSessionId } from '@cc/protocol'
import { sameSecret } from './http.js'

/**
 * The Codex bridge's credential (#382): good for one session's bridge calls and nothing else. The bridge
 * (`adapters/codex/centralu-bridge.mjs`) gets it in its environment, which every process of the same user can read (macOS 27.0.1:
 * `ps eww -p <pid>`, `sysctl kern.procargs2`; docs/security-boundaries/keeper.md "The front door"). The front door's token would
 * open every RPC (a preset to auto, trusting a project); this opens only what the bridge does, for its own session (`bridgeRefusal`).
 * Derived, not stored: an HMAC of the session id keyed by the host's token (the keeper's, the same for every host it runs), so a
 * bridge a host started is accepted by the next host after a swap (bridge-reconnect.test.ts) with nothing handed over, and holding it
 * gives nothing toward the token or another session's credential. Shape `ccb1:<sessionId>:<mac>`; a session id never contains `:`
 * (`isSessionId`). Its label keeps it apart from other values derived from the token (`deriveHttpSecret` uses its own)
 */
const PREFIX = 'ccb1'

function mac(hostToken: string, sessionId: string): string {
  return createHmac('sha256', hostToken).update(`centralu bridge token v1\0${sessionId}`).digest('base64url')
}

export function bridgeToken(hostToken: string, sessionId: string): string {
  return `${PREFIX}:${sessionId}:${mac(hostToken, sessionId)}`
}

export function bridgeSessionOf(hostToken: string, given: string): string | null {
  const parts = given.split(':')
  if (parts.length !== 3 || parts[0] !== PREFIX) return null
  const sessionId = parts[1]!
  if (!isSessionId(sessionId)) return null
  return sameSecret(parts[2]!, mac(hostToken, sessionId)) ? sessionId : null
}

/** Every RPC the bridge sends (centralu-bridge.mjs) and nothing more: each names its `sessionId`, and the host judges what that session may do */
const BRIDGE_METHODS: ReadonlySet<string> = new Set([
  'assistant.tools',
  'assistant.tool',
])

/**
 * Why a connection with the bridge credential of `boundSession` may not make this call, or null: the call must name that
 * session (`assistant.tools` without one lists the full assistant set)
 */
export function bridgeRefusal(boundSession: string, method: string, params: unknown): string | null {
  if (!BRIDGE_METHODS.has(method)) return `A Codex bridge's credential cannot call ${method}`
  const sessionId = (params as { sessionId?: unknown } | null | undefined)?.sessionId
  if (sessionId !== boundSession) return `This Codex bridge's credential is for another session`
  return null
}
