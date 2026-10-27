import { describe, expect, it } from 'vitest'
import { rpcError, sessionNotFound } from './rpc-error.js'

describe('rpcError (#850)', () => {
  it('carries what the RPC door reads: the code, and retryable and data when given', () => {
    const e = rpcError('Terminals are unavailable')
    expect(e).toBeInstanceOf(Error)
    expect({ message: e.message, code: e.code }).toEqual({ message: 'Terminals are unavailable', code: 'internal' })
    expect(e).not.toHaveProperty('retryable')
    const away = rpcError('The machine is away', 'internal', { retryable: true, data: { machine: 'm1' } })
    expect({ code: away.code, retryable: away.retryable, data: away.data }).toEqual({ code: 'internal', retryable: true, data: { machine: 'm1' } })
    expect({ message: sessionNotFound('s-1').message, code: sessionNotFound('s-1').code }).toEqual({ message: 'Session not found: s-1', code: 'session_not_found' })
  })

  // That none is assembled by hand is the lint rule `guard/no-hand-coded-error` (tooling/eslint-guards.js, #1606)
})
