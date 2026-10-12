import { describe, expect, it } from 'vitest'
import type { CacheStats, CacheWindowStats } from '@cc/protocol'
import { cacheHitRate, cacheTooltipLine, cacheWindowName, percentOf, rebuildBreakdown } from './cache.js'

describe('rebuildBreakdown', () => {
  const MIN = 60_000

  it('lists the causes in one line, most first, ties in the order of evidence', () => {
    expect(rebuildBreakdown({ unknown: 1, compaction: 1, expired: 3, model_change: 1 })).toBe(
      '3 cache expired · 1 model change · 1 compaction · 1 unknown',
    )
  })

  it('says how long the cache sat idle before the rebuilds put down to expiry, once', () => {
    expect(rebuildBreakdown({ expired: 2, probably_expired: 1 }, { min: 6 * MIN, max: 64 * MIN })).toBe(
      '2 cache expired (idle 6–64 min) · 1 probably expired',
    )
    expect(rebuildBreakdown({ probably_expired: 1 }, { min: 9 * MIN, max: 9 * MIN })).toBe('1 probably expired (idle 9 min)')
    expect(rebuildBreakdown({ expired: 2 }, { min: 3 * 60 * MIN, max: 5 * 60 * MIN })).toBe('2 cache expired (idle 3–5 h)')
  })

  it("shows a cause this build does not know (a newer host's) by its name, before unknown", () => {
    expect(rebuildBreakdown({ unknown: 1, some_new_reason: 1 })).toBe('1 some new reason · 1 unknown')
  })

  it('is empty with nothing to break down', () => {
    expect(rebuildBreakdown(undefined)).toBe('')
    expect(rebuildBreakdown({ expired: 0 })).toBe('')
  })
})

const NOW = new Date(2026, 9, 12, 15, 0).getTime()
const FIVE_HOURS_AGO = new Date(NOW - 5 * 3600_000).toISOString()

function win(over: Partial<CacheWindowStats> = {}): CacheWindowStats {
  return {
    id: '5h',
    label: 'last 5 h',
    since: FIVE_HOURS_AGO,
    requests: 10,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    rebuilds: 0,
    sessions: [],
    ...over,
  }
}

function stats(w: CacheWindowStats, countingSince = new Date(NOW - 24 * 3600_000).toISOString()): CacheStats {
  return { writes: true, countingSince, windows: [w] }
}

describe('cacheHitRate', () => {
  it('is what was read from cache over all input: uncached, read and written', () => {
    expect(cacheHitRate({ inputTokens: 100, cacheReadTokens: 9_000, cacheCreationTokens: 900 })).toBeCloseTo(0.9)
  })

  it('counts a write as a miss: a window that only rebuilt reads 0%, not 100%', () => {
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 50_000 })).toBe(0)
  })

  it('for a tool that reports reads only, is cached input over all input', () => {
    // Codex: 4,000 cached of 5,000 input, no write figure
    expect(cacheHitRate({ inputTokens: 1_000, cacheReadTokens: 4_000, cacheCreationTokens: 0 })).toBeCloseTo(0.8)
  })

  it('is unknown with no input at all, not 0%', () => {
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeNull()
  })
})

describe('percentOf', () => {
  it('rounds to a whole percent', () => {
    expect(percentOf(0.9412)).toBe(94)
    expect(percentOf(0.945)).toBe(95)
    expect(percentOf(1)).toBe(100)
    expect(percentOf(0)).toBe(0)
  })
})

describe('cacheWindowName', () => {
  it('names the window by itself when the host counted all of it', () => {
    expect(cacheWindowName(win(), new Date(NOW - 6 * 3600_000).toISOString())).toBe('last 5 h')
    // Started exactly when the window begins: still all of it
    expect(cacheWindowName(win(), FIVE_HOURS_AGO)).toBe('last 5 h')
  })

  it('says since when the host started inside the window, so two hours never read as five', () => {
    const started = new Date(2026, 9, 12, 13, 2).toISOString()
    expect(cacheWindowName(win(), started)).toBe('since 13:02')
  })
})

describe('cacheTooltipLine', () => {
  it('is one short line: the hit rate and its window', () => {
    expect(cacheTooltipLine(stats(win({ inputTokens: 100, cacheReadTokens: 9_400, cacheCreationTokens: 500 })))).toBe(
      'Cache hit 94% · last 5 h',
    )
  })

  it('says there were no requests rather than 0%', () => {
    expect(cacheTooltipLine(stats(win({ requests: 0 })))).toBe('Cache: no requests · last 5 h')
  })

  it('names the start when the host counted only part of the window', () => {
    const started = new Date(2026, 9, 12, 14, 30).toISOString()
    expect(cacheTooltipLine(stats(win({ cacheReadTokens: 1 }), started))).toBe('Cache hit 100% · since 14:30')
  })

  it('is absent when the host did not count (one that predates the figures)', () => {
    expect(cacheTooltipLine(undefined)).toBeNull()
    expect(cacheTooltipLine({ writes: false, countingSince: FIVE_HOURS_AGO, windows: [] })).toBeNull()
  })
})
