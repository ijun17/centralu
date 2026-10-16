import type { ProtocolErrorCode } from '@cc/protocol'

/**
 * An error a call answers with (#850): the RPC door (transport/server.ts) reads `code`, `retryable` and `data` off it
 * and sends them on as the protocol's error. One way to build it, typed by the protocol's codes, so a code the protocol
 * does not have cannot be written (the door would send it as `internal` anyway, silently).
 */
export type RpcError = Error & { code: RpcErrorCode; retryable?: boolean; data?: unknown }

/**
 * Codes only the host's own callers read (the manager's approval and question answers, and their tests): a card the
 * agent no longer has. The door sends them as `internal`, so they are named here rather than added to the protocol.
 */
type HostOnlyCode = 'approval_gone' | 'question_gone'

export type RpcErrorCode = ProtocolErrorCode | HostOnlyCode

export function rpcError(message: string, code: RpcErrorCode = 'internal', more?: { retryable?: boolean; data?: unknown }): RpcError {
  return Object.assign(new Error(message), { code, ...more })
}

/** The answer for a session id this host does not know */
export function sessionNotFound(sessionId: string): RpcError {
  return rpcError(`Session not found: ${sessionId}`, 'session_not_found')
}
