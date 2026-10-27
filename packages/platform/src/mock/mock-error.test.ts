import { describe, expect, it } from 'vitest'
import { mockError } from './mock-error.js'

/*
 * The mock answers as the host's answer reaches a window (#850 item 14). The host builds its coded errors one way
 * (agent-host/src/rpc-error.ts); the mock built about forty by hand, and five carried codes the protocol does not have,
 * which the host's door would have sent as `internal`.
 */
describe('mockError (#850)', () => {
  it('carries the message and a protocol code, internal unless given', () => {
    const e = mockError('Terminal not found')
    expect(e).toBeInstanceOf(Error)
    expect({ message: e.message, code: e.code }).toEqual({ message: 'Terminal not found', code: 'internal' })
    expect(mockError('Session not found', 'session_not_found').code).toBe('session_not_found')
  })

  // That none is assembled by hand is the lint rule `guard/no-hand-coded-error` (tooling/eslint-guards.js, #1606)
})
