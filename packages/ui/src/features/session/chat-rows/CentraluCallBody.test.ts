import { describe, expect, it } from 'vitest'
import { rowAuthor } from './CentraluCallBody.jsx'

describe("a read_session line's author", () => {
  it('names the script or the app that wrote a user line, not the person (#1468)', () => {
    expect(rowAuthor({ role: 'user', text: 'CI failed', fromScript: 'nightly' })).toBe('script nightly')
    expect(rowAuthor({ role: 'user', text: 'fix this', fromApp: 'Board' })).toBe('app Board')
    expect(rowAuthor({ role: 'user', text: 'go on', from: 'Planner' })).toBe('Planner')
    expect(rowAuthor({ role: 'user', text: 'hi' })).toBe('person')
    expect(rowAuthor({ role: 'assistant', text: 'done' })).toBe('agent')
  })
})
