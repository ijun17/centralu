import { describe, expect, it } from 'vitest'
import type { UsageHistoryRow } from '@cc/protocol'
import { topUsage } from './history.js'

const row = (key: string, day: number, over: Partial<UsageHistoryRow> = {}): UsageHistoryRow => ({
  period: `2026-10-${10 + day}T00:00:00.000Z`, key, name: key.toUpperCase(), requests: 1, inputTokens: 0, cacheReadTokens: 0,
  cacheCreationTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, outputTokens: 0, rebuilds: 0, rebuildCauses: {}, ...over,
})

describe('topUsage', () => {
  it('sums a key over its days, ranks by all tokens, and gives the cache hit rate of the sum', () => {
    const top = topUsage(
      [
        row('a', 0, { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5 }),
        row('a', 1, { inputTokens: 10, cacheReadTokens: 10, cacheCreationTokens: 80, rebuilds: 1, requests: 3 }),
        row('b', 0, { inputTokens: 1000 }),
        row('c', 0, { inputTokens: 1 }),
      ],
      2,
    )
    expect(top).toEqual([
      { key: 'b', name: 'B', tokens: 1000, hitRate: 0, requests: 1, rebuilds: 0 },
      { key: 'a', name: 'A', tokens: 205, hitRate: 0.5, requests: 4, rebuilds: 1 },
    ])
  })

  it('never names the folded "others" row, and has no rate where there was no input', () => {
    const top = topUsage([row('*', 0, { inputTokens: 9_999 }), row('a', 0, { outputTokens: 3 })], 5)
    expect(top).toEqual([{ key: 'a', name: 'A', tokens: 3, hitRate: null, requests: 1, rebuilds: 0 }])
  })
})
