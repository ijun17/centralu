import { describe, expect, it } from 'vitest'
import { mockError } from './mock-error.js'

/*
 * The mock answers as the host's answer reaches a window (#850 item 14): built one way, as agent-host/src/rpc-error.ts
 * builds them, so none carries a code the protocol lacks (the host would send that as `internal`).
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
