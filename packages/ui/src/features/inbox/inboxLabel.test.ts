import { describe, expect, it } from 'vitest'
import { turnStop } from '@cc/core'
import { inboxStateLabel } from './inboxLabel.js'
import { stateLabel, turnStopLabel } from '../../components/primitives.jsx'

const NOW = new Date(2026, 10, 20, 12, 0).getTime()

describe('inboxStateLabel (docs/ux-writing.md 1.12)', () => {
  const row = (over: Parameters<typeof inboxStateLabel>[0]) => inboxStateLabel(over, turnStop(over), NOW)

  it('says an open question needs the person’s answer, as a proposal does, not that it needs approval', () => {
    expect(row({ state: 'waiting_approval', asking: true })).toBe('Needs your answer')
    expect(row({ state: 'waiting_approval', proposal: { kind: 'mcp', name: 'x' } })).toBe('Needs your answer')
  })

  it('keeps the other states’ words, and says a failed turn as the note above the composer does', () => {
    expect(row({ state: 'waiting_approval' })).toBe('Needs approval')
    expect(row({ state: 'error' })).toBe('Stopped: error')
    // Said as the state's dot says it: the same word as `idle`
    expect(row({ state: 'waiting_input' })).toBe('Idle')
    expect(row({ state: 'waiting_input' })).toBe(stateLabel('waiting_input'))
  })

  it('says a stop in the words of the note above the composer (#1415), and a tool still reconnecting as such', () => {
    const limit = { reason: 'limit' as const, at: 1, autoContinue: { at: new Date(2030, 0, 1, 1, 20).getTime(), tries: 0 } }
    expect(row({ state: 'idle', interruption: limit })).toBe('Usage limit · continues at Jan 1, 2030, 01:20')
    expect(row({ state: 'idle', interruption: limit })).toBe(turnStopLabel(turnStop({ state: 'idle', interruption: limit })!, NOW))
    expect(row({ state: 'idle', interruption: { reason: 'network', at: 1, autoContinue: { tries: 1 } } })).toBe('Network lost · continues when the network is back')
    expect(row({ state: 'error', interruption: { reason: 'network', at: 1 } })).toBe('Stopped: network')
    expect(row({ state: 'working', interruption: { reason: 'reconnecting', at: 1 } })).toBe('Reconnecting for 5+ min')
  })

  it('never says a limit continues "later": a limit wait without its time is no wait it shows', () => {
    expect(row({ state: 'idle', interruption: { reason: 'limit', at: 1, autoContinue: { tries: 0 } } })).toBe('Stopped: usage limit')
  })
})

describe('turnStopLabel: one wording for the note, the inbox and the tooltip (#1415)', () => {
  const label = (s: Parameters<typeof turnStop>[0], now = NOW) => turnStopLabel(turnStop(s)!, now)

  it('says a time today alone, on another day with its day', () => {
    const today = new Date(2026, 10, 20, 17, 2).getTime()
    expect(label({ state: 'error', interruption: { reason: 'limit', at: 1, resetAt: today } })).toBe('Stopped: usage limit · resets at 17:02')
    const later = new Date(2026, 10, 23, 17, 2).getTime()
    expect(label({ state: 'error', interruption: { reason: 'limit', at: 1, resetAt: later } })).toBe('Stopped: usage limit · resets at Nov 23, 17:02')
  })

  it('says "soon" once the reset or the continue has passed, never a time behind it', () => {
    const past = new Date(2026, 10, 20, 11, 59).getTime()
    expect(label({ state: 'error', interruption: { reason: 'limit', at: 1, resetAt: past } })).toBe('Stopped: usage limit · resets soon')
    expect(label({ state: 'idle', interruption: { reason: 'limit', at: 1, autoContinue: { at: past, tries: 0 } } })).toBe('Usage limit · continues soon')
    // The moment itself has passed too
    expect(label({ state: 'error', interruption: { reason: 'limit', at: 1, resetAt: NOW } })).toBe('Stopped: usage limit · resets soon')
  })

  it('says a stop with no reset known, and a failed turn, without a time', () => {
    expect(label({ state: 'error', interruption: { reason: 'limit', at: 1 } })).toBe('Stopped: usage limit')
    expect(label({ state: 'idle', interruption: { reason: 'quit', at: 1 } })).toBe('Stopped: Centralu quit or restarted')
    expect(label({ state: 'error' })).toBe('Stopped: error')
  })
})
