import type { ProtocolErrorCode } from '@cc/protocol'

/**
 * An error a call answers with (#850): the RPC door (transport/server.ts) sends `code`, `retryable` and `data` on as the
 * protocol's error; typed by the protocol's codes, so one the protocol lacks cannot be written
 */
export type RpcError = Error & { code: RpcErrorCode; retryable?: boolean; data?: unknown }

/**
 * Codes only the host's own callers read (approval and question answers and their tests); the door sends them as `internal`, so
 * they are named here, not added to the protocol
 */
type HostOnlyCode = 'approval_gone' | 'question_gone' | 'conversation_gone'

export type RpcErrorCode = ProtocolErrorCode | HostOnlyCode

export function rpcError(message: string, code: RpcErrorCode = 'internal', more?: { retryable?: boolean; data?: unknown }): RpcError {
  return Object.assign(new Error(message), { code, ...more })
}

const answeredByPeer = new WeakSet<object>()

/**
 * The error the other side of a link answered to one of this host's calls (transport/server.ts `answered`), marked to tell it
 * from a call that got no answer (connection gone, timeout)
 */
export function peerAnswer(err: RpcError): RpcError {
  answeredByPeer.add(err)
  return err
}

export function isPeerAnswer(err: unknown): boolean {
  return typeof err === 'object' && err !== null && answeredByPeer.has(err)
}

export function sessionNotFound(sessionId: string): RpcError {
  return rpcError(`Session not found: ${sessionId}`, 'session_not_found')
}
