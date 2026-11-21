import { describe, expect, it } from 'vitest'
import type { Interruption, SessionState } from '@cc/protocol/client'
import { turnStop } from './turn-stop.js'

const stop = (state: SessionState, interruption?: Interruption | null) => turnStop({ state, interruption })

describe('turnStop: why the last turn stopped, from what the host said (#698, #1415, #1549)', () => {
  it('is none while a turn runs, a reconnecting tool included, and after a turn that ended as asked', () => {
    expect(stop('working', { reason: 'network', at: 1 })).toBeNull()
    expect(stop('waiting_approval', { reason: 'limit', at: 1 })).toBeNull()
    expect(stop('working', { reason: 'reconnecting', at: 1 })).toBeNull()
    expect(stop('idle', { reason: 'reconnecting', at: 1 })).toBeNull()
    expect(stop('waiting_input')).toBeNull()
    expect(stop('idle', null)).toBeNull()
  })

  it('is a wait while Centralu continues it by itself, whatever the state it rests in', () => {
    const limit: Interruption = { reason: 'limit', at: 1, resetAt: 5, autoContinue: { at: 60_005, tries: 0 } }
    expect(stop('error', limit)).toEqual({ kind: 'wait', interruption: limit })
    const network: Interruption = { reason: 'network', at: 1, autoContinue: { tries: 2 } }
    expect(stop('waiting_input', network)).toEqual({ kind: 'wait', interruption: network })
  })

  it("is a plain stop once nothing continues it, with a limit's reset when the host knows it", () => {
    expect(stop('error', { reason: 'limit', at: 1, resetAt: 5 })).toEqual({ kind: 'stopped', reason: 'limit', resetAt: 5, error: true })
    expect(stop('error', { reason: 'limit', at: 1 })).toEqual({ kind: 'stopped', reason: 'limit', error: true })
    // A limit wait with no time is no wait (`waitStands`)
    expect(stop('limited', { reason: 'limit', at: 1, autoContinue: { tries: 0 } })).toEqual({ kind: 'stopped', reason: 'limit', error: false })
    expect(stop('idle', { reason: 'quit', at: 1 })).toEqual({ kind: 'stopped', reason: 'quit', error: false })
    // A reset belongs to a limit only
    expect(stop('error', { reason: 'network', at: 1, resetAt: 5 })).toEqual({ kind: 'stopped', reason: 'network', error: true })
  })

  it('is an error when the state is error and no interruption says the turn was cut short', () => {
    expect(stop('error')).toEqual({ kind: 'error' })
    expect(stop('error', { reason: 'reconnecting', at: 1 })).toEqual({ kind: 'error' })
  })
})
