import type { ProtocolErrorCode } from '@cc/protocol/client'

/**
 * An error as the host's answer reaches a window (#850): typed by the protocol's codes, since the host's RPC door sends
 * any other code as `internal`.
 */
export function mockError(message: string, code: ProtocolErrorCode = 'internal'): Error & { code: ProtocolErrorCode } {
  return Object.assign(new Error(message), { code })
}
