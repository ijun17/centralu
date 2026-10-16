import type { ProtocolErrorCode } from '@cc/protocol'

/**
 * An error a call answers with (#850): the RPC door (transport/server.ts) reads `code`, `retryable` and `data` off it
 * and sends them on as the protocol's error. One way to build it, typed by the protocol's codes, so a code the protocol
 * does not have cannot be written (the door would send it as `internal` anyway, silently).
 */
export type RpcError = Error & { code: ProtocolErrorCode; retryable?: boolean; data?: unknown }

export function rpcError(message: string, code: ProtocolErrorCode = 'internal', more?: { retryable?: boolean; data?: unknown }): RpcError {
  return Object.assign(new Error(message), { code, ...more })
}

/** The answer for a session id this host does not know */
export function sessionNotFound(sessionId: string): RpcError {
  return rpcError(`Session not found: ${sessionId}`, 'session_not_found')
}
