import type { ProtocolErrorCode } from '@cc/protocol/client'

/**
 * An error a mock method answers with, as the host's answer reaches a window (#850 item 14): its message and one of the
 * protocol's codes. The host builds its errors through `rpcError` (agent-host/src/rpc-error.ts), and its RPC door sends a
 * code the protocol does not have as `internal`; the mock built its own by hand, and some carried codes no window ever
 * receives from the host (`task_gone`, `invalid_params`). Typed by the protocol, such a code cannot be written here.
 */
export function mockError(message: string, code: ProtocolErrorCode = 'internal'): Error & { code: ProtocolErrorCode } {
  return Object.assign(new Error(message), { code })
}
