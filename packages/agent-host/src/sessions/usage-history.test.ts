import { describe, expect, it } from 'vitest'
import { Store } from '../dev-services/store.js'
import type { UsageBucket } from '../dev-services/store/usage-history.js'
import { historyRows, MAX_KEYS, NO_PROJECT_KEY, OTHERS_KEY, usageHistory, usageHistoryText } from './usage-history.js'

const HOUR = 3_600_000
// 09:00 local on a day, so the hours below stay inside one local day
const DAY = new Date(2026, 9, 12, 0, 0).getTime()
const names = { session: (id: string) => ({ a: 'Session A', b: 'Session B' })[id], project: (id: string) => ({ p1: 'Project One' })[id] }

const bucket = (over: Partial<UsageBucket>): UsageBucket => ({
  hour: DAY + 9 * HOUR, sessionId: 'a', projectId: 'p1', tool: 'claude', model: 'opus', machine: '',
  requests: 1, input: 10, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, rebuilds: 0, rebuildTokens: 0, causes: {}, ...over,
})

describe('historyRows (docs/agent-host.md §6.2)', () => {
  const buckets = [
    bucket({ requests: 2, input: 10, cacheRead: 900, output: 5 }),
    bucket({ hour: DAY + 10 * HOUR, requests: 1, input: 1, cacheRead: 99, rebuilds: 1, causes: { expired: 1 } }),
    bucket({ sessionId: 'b', projectId: '', model: 'sonnet', tool: 'codex', hour: DAY + 30 * HOUR, input: 7 }),
  ]

  it('sums into days (the local midnight) or hours, by session', () => {
    const days = historyRows(buckets, { groupBy: 'day', by: 'session' }, names)
    expect(days.map((r) => [r.period, r.key, r.name, r.requests, r.inputTokens, r.cacheReadTokens, r.rebuilds])).toEqual([
      [new Date(DAY).toISOString(), 'a', 'Session A', 3, 11, 999, 1],
      [new Date(DAY + 24 * HOUR).toISOString(), 'b', 'Session B', 1, 7, 0, 0],
    ])
    expect(days[0]!.rebuildCauses).toEqual({ expired: 1 })
    const hours = historyRows(buckets, { groupBy: 'hour', by: 'session' }, names)
    expect(hours.map((r) => r.period)).toEqual([DAY + 9 * HOUR, DAY + 10 * HOUR, DAY + 30 * HOUR].map((t) => new Date(t).toISOString()))
  })

  it('groups by project, model or tool, naming the orchestrator and the default model', () => {
    const rows = (by: 'project' | 'model' | 'tool') => historyRows(buckets, { groupBy: 'day', by }, names).map((r) => [r.key, r.name])
    expect(rows('project')).toEqual([['p1', 'Project One'], [NO_PROJECT_KEY, 'Orchestrator']])
    expect(rows('model')).toEqual([['opus', 'opus'], ['sonnet', 'sonnet']])
    expect(rows('tool')).toEqual([['claude', 'claude'], ['codex', 'codex']])
    expect(historyRows([bucket({ model: '' })], { groupBy: 'day', by: 'model' }, names)[0]!.name).toBe('Default model')
  })

  it('folds the keys past the most tokens into one "others" row so a long range stays small', () => {
    const many = Array.from({ length: MAX_KEYS + 5 }, (_, i) => bucket({ sessionId: `s${i}`, input: 1000 - i, requests: 1 }))
    const rows = historyRows(many, { groupBy: 'day', by: 'session' }, names)
    expect(rows).toHaveLength(MAX_KEYS + 1)
    const others = rows.find((r) => r.key === OTHERS_KEY)!
    expect(others).toMatchObject({ name: 'Others', requests: 5, inputTokens: 5 * 1000 - (50 + 51 + 52 + 53 + 54) })
    // The biggest stay named
    expect(rows.some((r) => r.key === 's0')).toBe(true)
    expect(rows.some((r) => r.key === `s${MAX_KEYS + 4}`)).toBe(false)
  })
})

describe('usageHistory', () => {
  it('answers a range from the store: readings in it, buckets of the hours that begin in it, and since when it is recorded', () => {
    const store = new Store()
    store.usage.addBuckets([bucket({ hour: DAY + 9 * HOUR, input: 4 }), bucket({ hour: DAY - 5 * HOUR, input: 100 })])
    store.usage.addReadings(DAY + 10 * HOUR, 'claude', 'x', [{ id: 'weekly_all', scope: null, label: 'Weekly', percent: 30, resetsAt: null }])
    store.usage.addReadings(DAY - 3 * HOUR, 'claude', 'x', [{ id: 'weekly_all', scope: null, label: 'Weekly', percent: 10, resetsAt: null }])
    store.usage.addReadings(DAY - HOUR, 'claude', 'x', [{ id: 'weekly_all', scope: null, label: 'Weekly', percent: 20, resetsAt: null }])
    // A range that begins in the middle of an hour takes that hour whole
    const h = usageHistory(store.usage, { from: DAY + 9 * HOUR + 600_000, to: DAY + 12 * HOUR, groupBy: 'hour', by: 'session' }, names)
    expect(h.by).toBe('session')
    expect(h.rows.map((r) => r.inputTokens)).toEqual([4])
    expect(h.readings).toMatchObject([{ tool: 'claude', account: 'x', window: 'weekly_all', points: [{ percent: 20 }, { percent: 30, resetsAt: null }] }])
    // The 20% was in force when the range began, though stored before it; the 10% before that is not
    expect(h.readings[0]!.points).toHaveLength(2)
    expect(h.recordedSince).toBe(new Date(DAY - 5 * HOUR).toISOString())
  })
})

describe('usageHistory for one tool', () => {
  it('leaves out the other tools requests and readings', () => {
    const store = new Store()
    store.usage.addBuckets([bucket({ input: 4 }), bucket({ tool: 'codex', sessionId: 'b', input: 9 })])
    const w = { id: 'w', scope: null, label: 'W', percent: 1, resetsAt: null }
    store.usage.addReadings(DAY + 9 * HOUR, 'claude', 'x', [w])
    store.usage.addReadings(DAY + 9 * HOUR, 'codex', 'y', [w])
    const range = { from: DAY, to: DAY + 24 * HOUR, groupBy: 'day' as const, by: 'session' as const }
    const codex = usageHistory(store.usage, { ...range, tool: 'codex' }, names)
    expect(codex.rows.map((r) => r.key)).toEqual(['b'])
    expect(codex.readings.map((r) => r.tool)).toEqual(['codex'])
    expect(usageHistory(store.usage, range, names).rows).toHaveLength(2)
    // Since when it is recorded is said per tool: codex was recorded earlier than claude here
    store.usage.addBuckets([bucket({ tool: 'codex', hour: DAY - 48 * HOUR })])
    expect(usageHistory(store.usage, { ...range, tool: 'claude' }, names).recordedSince).toBe(new Date(DAY + 9 * HOUR).toISOString())
    expect(usageHistory(store.usage, { ...range, tool: 'codex' }, names).recordedSince).toBe(new Date(DAY - 48 * HOUR).toISOString())
  })
})

describe('usageHistoryText', () => {
  it('lists the top keys with their cache hit rate and how each window moved', () => {
    const store = new Store()
    store.usage.addBuckets([bucket({ input: 100, cacheRead: 900, output: 50, rebuilds: 2, requests: 4 }), bucket({ sessionId: 'b', input: 5 })])
    store.usage.addReadings(DAY, 'claude', 'x', [{ id: 'w', scope: null, label: 'Weekly', percent: 30, resetsAt: Date.parse('2026-10-15T00:00:00Z') }])
    store.usage.addReadings(DAY + HOUR, 'claude', 'x', [{ id: 'w', scope: null, label: 'Weekly', percent: 41, resetsAt: Date.parse('2026-10-15T00:00:00Z') }])
    const text = usageHistoryText(usageHistory(store.usage, { from: DAY, to: DAY + 24 * HOUR, groupBy: 'day', by: 'session' }, names), 7)
    expect(text).toContain('- Session A: 1.1k tokens (in 100, cache read 900, cache write 0, out 50), cache hit 90%, 4 requests, 2 rebuilds')
    expect(text.indexOf('Session A')).toBeLessThan(text.indexOf('Session B'))
    expect(text).toContain('Limit claude Weekly: 30% → 41% over 2 readings, resets 2026-10-15 00:00 UTC')
  })

  it('prints n/a for output when the tool reported none (Claude), not 0', () => {
    const store = new Store()
    store.usage.addBuckets([bucket({ input: 100, output: 0 })])
    const text = usageHistoryText(usageHistory(store.usage, { from: DAY, to: DAY + 24 * HOUR, groupBy: 'day', by: 'session' }, names), 7)
    expect(text).toContain('out n/a')
    expect(text).not.toContain('out 0')
  })

  it('says so when nothing was recorded', () => {
    expect(usageHistoryText({ by: 'tool', readings: [], rows: [] }, 1)).toBe('Usage over the last 1 day on this computer, by tool:\nNo requests recorded in this range.')
  })
})
