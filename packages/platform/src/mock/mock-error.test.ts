import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  // mockError's code is typed by the protocol, so a code it does not have does not compile; built by hand, it did
  it('is the one way the mock builds a coded error: none is assembled by hand', () => {
    const dir = import.meta.dirname
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'mock-error.ts')
    // Across lines (a formatter splits a long one), the message bounded so one call cannot run into the next
    const byHand = /Object\.assign\(\s*new Error\((?:(?!Object\.assign)[\s\S]){0,400}?\)\s*,\s*\{\s*code:\s*'[a-z_]+'/
    expect(files.filter((f) => byHand.test(readFileSync(join(dir, f), 'utf8')))).toEqual([])
  })
})
