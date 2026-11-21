import type { UsageHistoryRow } from '@cc/protocol/client'
import { cacheHitRate } from './cache.js'

/** docs/agent-host/usage.md "Usage over time" */
export type UsageTop = {
  key: string
  name: string
  /** Uncached input, cache reads, cache writes and output */
  tokens: number
  hitRate: number | null
  requests: number
  rebuilds: number
}

/** The host's folded row (`*`, "Others") is never named as a top */
export function topUsage(rows: readonly UsageHistoryRow[], count: number): UsageTop[] {
  const sums = new Map<string, UsageHistoryRow>()
  for (const r of rows) {
    const s = sums.get(r.key)
    if (!s) {
      sums.set(r.key, { ...r })
      continue
    }
    s.requests += r.requests
    s.inputTokens += r.inputTokens
    s.cacheReadTokens += r.cacheReadTokens
    s.cacheCreationTokens += r.cacheCreationTokens
    s.outputTokens += r.outputTokens
    s.rebuilds += r.rebuilds
  }
  return [...sums.values()]
    .filter((s) => s.key !== '*')
    .map((s) => ({
      key: s.key,
      name: s.name,
      tokens: s.inputTokens + s.cacheReadTokens + s.cacheCreationTokens + s.outputTokens,
      hitRate: cacheHitRate(s),
      requests: s.requests,
      rebuilds: s.rebuilds,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, count)
}
