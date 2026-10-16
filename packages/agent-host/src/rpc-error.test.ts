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

  it('finds a coded error built by hand over several lines, and not an error coded otherwise', () => {
    const coded = (text: string) => /Object\.assign\(\s*new Error\((?:(?!Object\.assign)[\s\S]){0,400}?\)\s*,\s*\{\s*code:\s*'[a-z_]+'/.test(text)
    expect(coded("throw Object.assign(\n  new Error(\n    `Gone (${a}) now`,\n  ),\n  { code: 'internal' },\n)")).toBe(true)
    expect(coded("Object.assign(new Error(`Git exited with ${code}`), { code, stderr })\nObject.assign(new Error('gh was stopped'), { code: 'ABORT_ERR' })")).toBe(false)
  })

  it('is the one way the host builds a coded error: none is assembled by hand', () => {
    // Across lines (a formatter splits a long one), the message bounded so one call cannot run into the next
    const coded = /Object\.assign\(\s*new Error\((?:(?!Object\.assign)[\s\S]){0,400}?\)\s*,\s*\{\s*code:\s*'[a-z_]+'/
    const byHand = sources(SRC).filter((f) => !f.endsWith('rpc-error.ts') && coded.test(readFileSync(f, 'utf8')))
    expect(byHand.map((f) => relative(SRC, f))).toEqual([])
  })
})
