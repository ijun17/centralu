import { describe, expect, it } from 'vitest'
import { createVisibleTicker } from './useWhileVisible.js'

function setup(onReturn: 'late' | 'always') {
  const env = { hidden: false, at: 0 }
  let runs = 0
  const t = createVisibleTicker({ hidden: () => env.hidden, now: () => env.at }, 1000, onReturn, () => runs++)
  return { env, t, runs: () => runs }
}

describe('createVisibleTicker (#1143)', () => {
  it('asks on a tick while in view, and not while hidden', () => {
    const h = setup('late')
    h.env.at = 1000
    h.t.tick()
    expect(h.runs()).toBe(1)
    h.env.hidden = true
    h.env.at = 2000
    h.t.tick()
    expect(h.runs()).toBe(1)
  })

  it('late: coming back asks at once only when a tick was skipped', () => {
    const h = setup('late')
    h.env.hidden = true
    h.env.at = 1500
    h.t.tick()
    h.env.hidden = false
    h.env.at = 1600
    h.t.back()
    expect(h.runs()).toBe(1)
    // Back again straight away: the last ask is fresh
    h.env.at = 1700
    h.t.back()
    expect(h.runs()).toBe(1)
  })

  it('late: never asks on a return while still hidden', () => {
    const h = setup('late')
    h.env.hidden = true
    h.env.at = 5000
    h.t.back()
    expect(h.runs()).toBe(0)
  })

  it('always: every return in view asks, however fresh the last ask', () => {
    const h = setup('always')
    h.env.at = 10
    h.t.back()
    h.env.at = 20
    h.t.back()
    expect(h.runs()).toBe(2)
  })
})
