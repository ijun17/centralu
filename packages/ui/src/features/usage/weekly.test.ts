import { describe, expect, it } from 'vitest'
import type { UsageHistoryReadings, UsageWindow } from '@cc/protocol'
import { usageTone, weeklySeries, weeklyWindow } from './weekly.js'

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

describe('weeklySeries', () => {
  const series = (window: string, label: string, percent: number[], over: Partial<UsageHistoryReadings> = {}): UsageHistoryReadings => ({
    tool: 'claude', account: 'a', window, label, scope: null,
    points: percent.map((p, i) => ({ at: new Date(Date.UTC(2026, 9, 12, i)).toISOString(), percent: p, resetsAt: null })), ...over,
  })

  it('draws the weekly window, not the 5-hour one', () => {
    expect(weeklySeries([series('session', '5 hours', [10, 90]), series('weekly_all', 'Weekly', [20, 30])])?.window).toBe('weekly_all')
  })

  it('takes the fullest weekly window, as the donut does', () => {
    const picked = weeklySeries([series('weekly_all', 'Weekly', [74]), series('weekly_scoped', 'Weekly', [95], { scope: 'Opus' })])
    expect(picked?.window).toBe('weekly_scoped')
  })

  it('follows the account read most recently, and is null without a weekly window or any reading', () => {
    const old = series('weekly_all', 'Weekly', [99], { account: 'old', points: [{ at: '2026-09-01T00:00:00.000Z', percent: 99, resetsAt: null }] })
    expect(weeklySeries([old, series('weekly_all', 'Weekly', [5])])?.account).toBe('a')
    expect(weeklySeries([series('session', '5 hours', [5])])).toBeNull()
    expect(weeklySeries([])).toBeNull()
  })
})
