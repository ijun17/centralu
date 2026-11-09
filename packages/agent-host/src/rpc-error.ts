import type { ProtocolErrorCode } from '@cc/protocol'

/**
 * An error a call answers with (#850): the RPC door (transport/server.ts) reads `code`, `retryable` and `data` off it
 * and sends them on as the protocol's error. One way to build it, typed by the protocol's codes, so a code the protocol
 * does not have cannot be written (the door would send it as `internal` anyway, silently).
 */
export type RpcError = Error & { code: RpcErrorCode; retryable?: boolean; data?: unknown }

/**
 * Codes only the host's own callers read (the manager's approval and question answers, and their tests): a card the
 * agent no longer has, and a conversation the tool no longer keeps (`session.ts` of an ACP tool; the manager says what it means). The door sends them as `internal`, so they are named here rather than added to the protocol.
 */
type HostOnlyCode = 'approval_gone' | 'question_gone' | 'conversation_gone'

export type RpcErrorCode = ProtocolErrorCode | HostOnlyCode

export function rpcError(message: string, code: RpcErrorCode = 'internal', more?: { retryable?: boolean; data?: unknown }): RpcError {
  return Object.assign(new Error(message), { code, ...more })
}

const answeredByPeer = new WeakSet<object>()

/**
 * The error the other side of a link answered to one of this host's calls (transport/server.ts `answered`), marked so a
 * caller tells it from a call that never got an answer (a connection gone, a timeout), which carry the same code
 */
export function peerAnswer(err: RpcError): RpcError {
  answeredByPeer.add(err)
  return err
}

/** Whether the other side answered this error itself (`peerAnswer`): it was there and refused, rather than lost */
export function isPeerAnswer(err: unknown): boolean {
  return typeof err === 'object' && err !== null && answeredByPeer.has(err)
}

/** The answer for a session id this host does not know */
export function sessionNotFound(sessionId: string): RpcError {
  return rpcError(`Session not found: ${sessionId}`, 'session_not_found')
}
