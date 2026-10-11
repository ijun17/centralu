import { createHmac } from 'node:crypto'
import { isSessionId } from '@cc/protocol'
import { sameSecret } from './http.js'

/**
 * The Codex bridge's credential: good for one session's bridge calls, and nothing else (#382, owner
 * question 4).
 *
 * The bridge (`adapters/codex/orchestrator-bridge.mjs`) is a process Codex starts, and it gets its
 * credential in its environment. The environment a process started with stays readable by every
 * other process of the same user: on macOS 27.0.1 `ps eww -p <pid>` and `sysctl kern.procargs2`
 * printed a marker variable of another process, also after that process had deleted it from
 * `process.env` (docs/security-boundaries.md, "The front door"). So a command any session runs could
 * read the bridge's credential. When that credential was the front door's token, it opened every RPC:
 * setting a session's preset to auto, trusting a project. This one opens only what the bridge itself
 * does, for the one session it was made for (`bridgeRefusal`).
 *
 * **Derived, not stored.** It is an HMAC of the session id keyed by the host's token. Under the keeper
 * that token is the front door's, the same for every host the keeper runs, so a bridge started by one
 * host is still accepted by the next one after a swap, which is when a running Codex keeps the bridge
 * it started (bridge-reconnect.test.ts). Nothing has to be handed over or written down for that, and
 * the host can check a credential with nothing but its token. HMAC is one-way: holding a bridge
 * credential gives nothing toward the token or toward another session's credential.
 *
 * The shape is `ccb1:<sessionId>:<mac>`. A session id never contains `:` (`isSessionId`), so the
 * split is unambiguous. The label keeps this value apart from anything else derived from the token
 * (`deriveHttpSecret` uses its own).
 */
const PREFIX = 'ccb1'

function mac(hostToken: string, sessionId: string): string {
  return createHmac('sha256', hostToken).update(`centralu bridge token v1\0${sessionId}`).digest('base64url')
}

/** The credential the bridge of `sessionId` is started with */
export function bridgeToken(hostToken: string, sessionId: string): string {
  return `${PREFIX}:${sessionId}:${mac(hostToken, sessionId)}`
}

/** The session a bridge credential was made for, or null if it is not one this host made */
export function bridgeSessionOf(hostToken: string, given: string): string | null {
  const parts = given.split(':')
  if (parts.length !== 3 || parts[0] !== PREFIX) return null
  const sessionId = parts[1]!
  if (!isSessionId(sessionId)) return null
  return sameSecret(parts[2]!, mac(hostToken, sessionId)) ? sessionId : null
}

/**
 * Every RPC the bridge sends (orchestrator-bridge.mjs), and nothing more. Each one names its session
 * in `sessionId`, and the host already judges what that session may do from it: these four only carry
 * a session's own tool calls.
 */
export const BRIDGE_METHODS: ReadonlySet<string> = new Set([
  'orchestrator.tools',
  'orchestrator.tool',
  'apps.sessionTools',
  'apps.sessionCall',
])

/**
 * Why a connection holding the bridge credential of `boundSession` may not make this call, or null
 * if it may. The session has to be named and has to be the bound one: `orchestrator.tools` without
 * a session lists the full orchestrator set, which is not this session's to read.
 */
export function bridgeRefusal(boundSession: string, method: string, params: unknown): string | null {
  if (!BRIDGE_METHODS.has(method)) return `A Codex bridge's credential cannot call ${method}`
  const sessionId = (params as { sessionId?: unknown } | null | undefined)?.sessionId
  if (sessionId !== boundSession) return `This Codex bridge's credential is for another session`
  return null
}
