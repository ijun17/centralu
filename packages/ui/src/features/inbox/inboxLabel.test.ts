import { describe, expect, it } from 'vitest'
import { inboxStateLabel } from './inboxLabel.js'
import { autoContinueLabel, stateLabel } from '../../components/primitives.jsx'
import { formatClock } from '../../app/format.js'

describe('inboxStateLabel (docs/ux-writing.md 1.12)', () => {
  const row = (over: Parameters<typeof inboxStateLabel>[0]) => inboxStateLabel(over)

  it('says an open question needs the person’s answer, as a proposal does, not that it needs approval', () => {
    expect(row({ state: 'waiting_approval', asking: true })).toBe('Needs your answer')
    expect(row({ state: 'waiting_approval', proposal: { kind: 'mcp', name: 'x' } })).toBe('Needs your answer')
  })

  it('keeps the other states’ words', () => {
    expect(row({ state: 'waiting_approval' })).toBe('Needs approval')
    expect(row({ state: 'error' })).toBe('Error')
    // Said as the state's dot says it (owner, 2026-10-26): the same word as `idle`
    expect(row({ state: 'waiting_input' })).toBe('Idle')
    expect(row({ state: 'waiting_input' })).toBe(stateLabel('waiting_input'))
  })

  it('says a stop Centralu continues by itself in the header’s words, and the stop when nothing continues it (#1415)', () => {
    const at = new Date(2030, 0, 1, 1, 20).getTime()
    const limit = { reason: 'limit' as const, at: 1, autoContinue: { at, tries: 0 } }
    expect(row({ state: 'idle', interruption: limit })).toBe(`Usage limit · continues at ${formatClock(new Date(at))}`)
    expect(row({ state: 'idle', interruption: limit })).toBe(autoContinueLabel(limit, formatClock))
    expect(row({ state: 'idle', interruption: { reason: 'network', at: 1, autoContinue: { tries: 1 } } })).toBe('Network lost · continues when the network is back')
    expect(row({ state: 'idle', interruption: { reason: 'network', at: 1 } })).toBe('Stopped: network')
  })

  it('never says a limit continues "later": a limit wait without its time is no wait it shows', () => {
    const later = { reason: 'limit' as const, at: 1, autoContinue: { tries: 0 } }
    expect(autoContinueLabel(later, formatClock)).toBeNull()
    expect(row({ state: 'idle', interruption: later })).toBe('Stopped: usage limit')
  })
})
