import { describe, expect, it } from 'vitest'
import { inboxStateLabel } from './inboxLabel.js'

describe('inboxStateLabel (docs/ux-writing.md 1.12)', () => {
  const row = (over: Parameters<typeof inboxStateLabel>[0]) => inboxStateLabel(over)

  it('says an open question needs the person’s answer, as a proposal does, not that it needs approval', () => {
    expect(row({ state: 'waiting_approval', asking: true })).toBe('Needs your answer')
    expect(row({ state: 'waiting_approval', proposal: { kind: 'mcp', name: 'x' } })).toBe('Needs your answer')
  })

  it('keeps the other states’ words', () => {
    expect(row({ state: 'waiting_approval' })).toBe('Needs approval')
    expect(row({ state: 'error' })).toBe('Error')
    expect(row({ state: 'waiting_input' })).toBe('Waiting for input')
  })
})
