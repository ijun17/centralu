import type { UsageHistoryRow } from '@cc/protocol'
import { cacheHitRate } from './cache.js'

/** One key's share of a usage history range: its rows summed over the periods (docs/agent-host.md §6.2) */
export type UsageTop = {
  key: string
  name: string
  /** Everything the model was sent and wrote back: uncached input, cache reads, cache writes and output */
  tokens: number
  /** `cacheHitRate` of the summed input; null with none */
  hitRate: number | null
  requests: number
  rebuilds: number
}

/**
 * The keys that used the most tokens over a range, most first. The row for the keys the host folded together
 * (`*`, "Others") is not one of them; it is never named as a top.
 */
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
