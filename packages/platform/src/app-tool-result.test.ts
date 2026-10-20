import { describe, expect, it } from 'vitest'
import { isAppToolResult } from './app-tool-result.js'

describe('isAppToolResult', () => {
  it('takes an MCP tools/call response, with the optional parts it names', () => {
    expect(isAppToolResult({ content: [] })).toBe(true)
    expect(isAppToolResult({ content: [{ type: 'text', text: 'ok' }], structuredContent: { n: 1 }, isError: false, _meta: { a: 1 }, extra: 'kept' })).toBe(true)
  })

  it('refuses what the type would be lying about: no content list, content that is not objects, parts of the wrong kind', () => {
    for (const bad of [null, undefined, 'ok', [], {}, { content: 'x' }, { content: ['x'] }, { content: [null] }, { content: [], isError: 'yes' }, { content: [], structuredContent: 3 }, { content: [], _meta: [] }]) {
      expect(isAppToolResult(bad)).toBe(false)
    }
  })
})
