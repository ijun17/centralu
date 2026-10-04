import { describe, expect, it } from 'vitest'
import type { UsageWindow } from '@cc/protocol'
import { usageTone, weeklyWindow } from './weekly.js'

const w = (over: Partial<UsageWindow>): UsageWindow => ({
  id: 'x', label: 'x', percent: 0, resetsAt: null, scope: null, ...over,
})

/**
 * Picking the window the top-bar donut should draw. Names differ by tool (measured):
 * claude uses `weekly_all`, codex uses a name derived from the window length (`1w`).
 */
describe('weeklyWindow', () => {
  it('claude: picks weekly_all (even if the 5-hour window comes first)', () => {
    const picked = weeklyWindow([w({ id: 'session', label: '5 hours' }), w({ id: 'weekly_all', label: 'Weekly' })])
    expect(picked?.id).toBe('weekly_all')
  })

  it('codex: the name is the window length — picks 1w', () => {
    const picked = weeklyWindow([w({ id: 'primary', label: '5h' }), w({ id: 'secondary', label: '1w' })])
    expect(picked?.id).toBe('secondary')
  })

  it('with several weekly windows, whichever wall comes first — puts forward the fullest one', () => {
    const picked = weeklyWindow([
      w({ id: 'weekly_all', label: 'Weekly', percent: 74 }),
      w({ id: 'weekly_scoped', label: 'Weekly (per model)', scope: 'Opus', percent: 95 }),
    ])
    expect(picked?.id).toBe('weekly_scoped')
  })

  it('if the account weekly is fuller, picks that — the rule is the number, not the model', () => {
    const picked = weeklyWindow([
      w({ id: 'weekly_all', label: 'Weekly', percent: 88 }),
      w({ id: 'weekly_scoped', label: 'Weekly (per model)', scope: 'Opus', percent: 12 }),
    ])
    expect(picked?.id).toBe('weekly_all')
  })

  it('null when nothing counts as weekly — drawing any window would make the donut lie', () => {
    expect(weeklyWindow([w({ id: 'session', label: '5 hours' })])).toBeNull()
    expect(weeklyWindow([])).toBeNull()
  })
})

describe('usageTone', () => {
  it('the fuller it is, the brighter — pure white from 90% on', () => {
    expect(usageTone(10)).toBe('text-ink-muted')
    expect(usageTone(70)).toBe('text-ink')
    expect(usageTone(93)).toBe('text-ink-signal')
  })
})
