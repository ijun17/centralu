import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UsageHistory, UsageHistoryRow } from '@cc/protocol'
import { HistoryView } from './HistorySection.jsx'

const TO = Date.UTC(2026, 9, 19)
const FROM = TO - 7 * 24 * 3_600_000

const row = (key: string, over: Partial<UsageHistoryRow> = {}): UsageHistoryRow => ({
  period: new Date(FROM).toISOString(), key, name: key === 'gone' ? 'Old work' : `Session ${key}`, requests: 10, inputTokens: 1_000,
  cacheReadTokens: 9_000, cacheCreationTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, outputTokens: 500, rebuilds: 0, rebuildCauses: {}, ...over,
})
const reading = (window: string, label: string, percents: number[]) => ({
  tool: 'claude' as const, account: 'a', window, label, scope: null,
  points: percents.map((percent, i) => ({ at: new Date(FROM + (i + 1) * 3_600_000).toISOString(), percent, resetsAt: null })),
})

const render = (history: Partial<UsageHistory>, by: 'session' | 'project' = 'session') => {
  const html = renderToStaticMarkup(
    <HistoryView
      history={{ by, readings: [], rows: [], ...history }}
      from={FROM}
      to={TO}
      by={by}
      onBy={() => {}}
      canOpen={(id) => id === 'here'}
      onOpen={() => {}}
    />,
  )
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') }
}

describe('HistoryView (docs/agent-host.md §6.2)', () => {
  it('draws the weekly window as a line with its latest percent, and names the sessions that used most with their hit rate', () => {
    const { html, text } = render({
      readings: [reading('session', '5 hours', [90]), reading('weekly_all', 'Weekly', [20, 35, 41])],
      rows: [row('here', { inputTokens: 5_000, cacheReadTokens: 45_000 }), row('gone', { inputTokens: 100, cacheReadTokens: 100 })],
    })
    expect(text).toContain('Last 7 days')
    expect(text).toContain('Weekly 41% now')
    expect(html).toContain('data-testid="usage-history-weekly"')
    expect(html).toMatch(/<path d="M[\d.]+,[\d.]+ H[\d.]+ V[\d.]+ H[\d.]+ V[\d.]+ H200"/)
    // Most tokens first; 9 of 10 input tokens came from the cache; only a session on this screen opens
    expect(text.indexOf('Session here')).toBeLessThan(text.indexOf('Old work'))
    expect(text).toContain('Session here 50.5k · 90.0% hit')
    expect(html).toMatch(/<button[^>]*data-testid="usage-history-row-here"/)
    expect(html).toMatch(/<span[^>]*data-testid="usage-history-row-gone"/)
  })

  it('draws no line for less than a day of readings: the latest figure says it', () => {
    const first = reading('weekly_all', 'Weekly', [3])
    first.points[0]!.at = new Date(TO - 3_600_000).toISOString()
    const { html, text } = render({ readings: [first] })
    expect(text).toContain('Weekly 3% now')
    expect(html).not.toContain('<svg')
  })

  it('says so when nothing was recorded, draws no line without a weekly reading, and says since when it knows', () => {
    const { text, html } = render({ readings: [reading('session', '5 hours', [5])], recordedSince: new Date(FROM + 3 * 24 * 3_600_000).toISOString() })
    expect(text).toContain('No model requests recorded in the last 7 days')
    expect(html).not.toContain('usage-history-weekly')
    expect(text).toContain('earlier days are not known')
  })

  it('does not open a project row as a session', () => {
    const { html } = render({ rows: [row('here')] }, 'project')
    expect(html).not.toMatch(/<button[^>]*usage-history-row-here/)
  })
})
