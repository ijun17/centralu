import { describe, expect, it } from 'vitest'
import { mcpNameParts } from '@cc/protocol'
import { appToolOf, isCentraluToolName } from './permissions.js'

/** Which tool names are Centralu's own: the trust decision reads a name the way the screen does (`mcpNameParts`), and is stricter only about `__` (#93, #2173) */

describe('the tool names that are Centralu’s own', () => {
  it('takes the in-process server’s tool and an app’s tool', () => {
    expect(isCentraluToolName('mcp__centralu__list_sessions')).toBe(true)
    expect(appToolOf('mcp__app-notes__add')).toEqual({ server: 'app-notes', tool: 'add' })
  })

  it('refuses a server that only starts with the name: `__` ends a server name', () => {
    expect(isCentraluToolName('mcp__centralu__pw__navigate')).toBe(false)
    expect(isCentraluToolName('mcp__other__list_sessions')).toBe(false)
    expect(isCentraluToolName('mcp__centralu-x__list_sessions')).toBe(false)
    expect(isCentraluToolName('list_sessions')).toBe(false)
    expect(appToolOf('mcp__other__add')).toBeNull()
  })

  it('refuses a tool part holding `__` where the screen still reads a server and a tool', () => {
    expect(mcpNameParts('mcp__app-x__a__b')).toEqual({ server: 'app-x', tool: 'a__b' })
    expect(appToolOf('mcp__app-x__a__b')).toBeNull()
  })
})
