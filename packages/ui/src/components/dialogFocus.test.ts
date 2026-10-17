import { describe, expect, it } from 'vitest'
import { trapTarget } from './dialogFocus.js'

describe('trapTarget (#842 item 7): Tab stays inside a dialog', () => {
  const panel = 'panel'
  const controls = ['first', 'middle', 'last']

  it('walks the controls in order, both ways', () => {
    expect(trapTarget(controls, 'first', panel, false)).toBe('middle')
    expect(trapTarget(controls, 'middle', panel, true)).toBe('first')
  })

  it('wraps at both ends: Tab on the last goes to the first, Shift+Tab on the first to the last', () => {
    expect(trapTarget(controls, 'last', panel, false)).toBe('first')
    expect(trapTarget(controls, 'first', panel, true)).toBe('last')
  })

  it('from the panel itself goes to the first control, or the last with Shift', () => {
    expect(trapTarget(controls, panel, panel, false)).toBe('first')
    expect(trapTarget(controls, panel, panel, true)).toBe('last')
  })

  it('with one control, keeps focus on it', () => {
    expect(trapTarget(['only'], 'only', panel, false)).toBe('only')
    expect(trapTarget(['only'], 'only', panel, true)).toBe('only')
  })

  it('leaves a control the panel does not hold (a portal) and an empty dialog to the browser', () => {
    expect(trapTarget(controls, 'elsewhere', panel, false)).toBeNull()
    expect(trapTarget([], panel, panel, false)).toBeNull()
  })
})
