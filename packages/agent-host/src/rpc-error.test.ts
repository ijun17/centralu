import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rpcError, sessionNotFound } from './rpc-error.js'

const SRC = import.meta.dirname

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(path)
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.test-helpers.ts') ? [path] : []
  })
}

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

  it('is the one way the host builds a coded error: none is assembled by hand', () => {
    const byHand = sources(SRC).filter((f) => !f.endsWith('rpc-error.ts') && /Object\.assign\(new Error\([^\n]*?\),\s*\{\s*code:\s*'[a-z_]+'/.test(readFileSync(f, 'utf8')))
    expect(byHand.map((f) => relative(SRC, f))).toEqual([])
  })
})
