import { describe, expect, it } from 'vitest'
import type { SessionState } from '@cc/protocol'
import { lookOf } from './look.js'

describe('lookOf: every state maps to one of the four looks (#736)', () => {
  const states: [SessionState, ReturnType<typeof lookOf>][] = [
    ['idle', 'idle'],
    ['waiting_input', 'idle'],
    ['working', 'answering'],
    ['error', 'stopped'],
    ['limited', 'stopped'],
    ['waiting_approval', 'waiting'],
  ]
  it.each(states)('%s looks %s', (state, look) => {
    expect(lookOf({ state })).toBe(look)
  })

  it('an interruption stops a session whose state rests as idle or waiting_input', () => {
    const interruption = { reason: 'quit', at: 1 } as const
    expect(lookOf({ state: 'idle', interruption })).toBe('stopped')
    expect(lookOf({ state: 'waiting_input', interruption })).toBe('stopped')
  })

  it('answering outranks a leftover interruption', () => {
    expect(lookOf({ state: 'working', interruption: { reason: 'quit', at: 1 } as const })).toBe('answering')
  })

  it('an open question waits on the person whatever the state says', () => {
    expect(lookOf({ state: 'idle', openQuestions: 1 })).toBe('waiting')
    expect(lookOf({ state: 'working', openQuestions: 1 })).toBe('waiting')
    expect(lookOf({ state: 'error', openQuestions: 2 })).toBe('waiting')
  })
})
