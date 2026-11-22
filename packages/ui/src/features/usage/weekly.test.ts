import { describe, expect, it } from 'vitest'
import type { UsageHistoryReadings, UsageWindow } from '@cc/protocol'
import { barWindow, usageTone, barSeries, weeklyWindow } from './weekly.js'

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

describe('barSeries', () => {
  const series = (window: string, label: string, percent: number[], over: Partial<UsageHistoryReadings> = {}): UsageHistoryReadings => ({
    tool: 'claude', account: 'a', window, label, scope: null,
    points: percent.map((p, i) => ({ at: new Date(Date.UTC(2026, 9, 12, i)).toISOString(), percent: p, resetsAt: null })), ...over,
  })

  it('draws the weekly window, not the 5-hour one', () => {
    expect(barSeries([series('session', '5 hours', [10, 90]), series('weekly_all', 'Weekly', [20, 30])])?.window).toBe('weekly_all')
  })

  it('takes the fullest weekly window, as the donut does', () => {
    const picked = barSeries([series('weekly_all', 'Weekly', [74]), series('weekly_scoped', 'Weekly', [95], { scope: 'Opus' })])
    expect(picked?.window).toBe('weekly_scoped')
  })

  it('follows the account read most recently, and is null without any reading', () => {
    const old = series('weekly_all', 'Weekly', [99], { account: 'old', points: [{ at: '2026-09-01T00:00:00.000Z', percent: 99, resetsAt: null }] })
    expect(barSeries([old, series('weekly_all', 'Weekly', [5])])?.account).toBe('a')
    expect(barSeries([])).toBeNull()
  })

  it("draws the tool's one window when it has no weekly one, as the donut does (#2459)", () => {
    expect(barSeries([series('included', 'Included', [5])])?.window).toBe('included')
  })
})

describe('barWindow: the window the top-bar donut draws (#2459)', () => {
  const MONTH_END = '2026-12-24T00:00:00.000Z'

  it('is the weekly window when there is one, whatever resets later', () => {
    const picked = barWindow([w({ id: 'cycle', label: 'Included', resetsAt: MONTH_END }), w({ id: 'secondary', label: '1w', resetsAt: '2026-11-29T00:00:00.000Z' })])
    expect(picked?.id).toBe('secondary')
  })

  it("is the tool's only window when it is not weekly, so a monthly plan is not drawn unknown", () => {
    expect(barWindow([w({ id: 'included', label: 'Included', resetsAt: MONTH_END })])?.id).toBe('included')
  })

  it('is the one that resets last among windows that are not weekly; the first listed among equals or with no reset said', () => {
    expect(barWindow([w({ id: 'session', label: '5h', resetsAt: '2026-11-22T15:00:00.000Z' }), w({ id: 'day', label: '1d', resetsAt: '2026-11-23T00:00:00.000Z' })])?.id).toBe('day')
    expect(barWindow([w({ id: 'included', label: 'Included', resetsAt: MONTH_END }), w({ id: 'auto', label: 'Auto', resetsAt: MONTH_END })])?.id).toBe('included')
    expect(barWindow([w({ id: 'a', label: 'A' }), w({ id: 'b', label: 'B' })])?.id).toBe('a')
    expect(barWindow([w({ id: 'a', label: 'A' }), w({ id: 'b', label: 'B', resetsAt: MONTH_END })])?.id).toBe('b')
    expect(barWindow([w({ id: 'a', label: 'A', resetsAt: MONTH_END }), w({ id: 'b', label: 'B' })])?.id).toBe('a')
  })

  it('is null with no window: the donut stays unknown', () => {
    expect(barWindow([])).toBeNull()
  })
})
