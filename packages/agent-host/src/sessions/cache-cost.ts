import type { CacheBilling } from '../adapters/contract.js'

/**
 * What the prompt cache costs, as ratios to the price of an uncached input token (#1492, docs/agent-host.md §6.1). The hit rate is by
 * tokens, which hides that a write costs far more than a read: weighted by these ratios the same traffic reads 96% by tokens and has
 * writes at about 43% of what the cache cost. Ratios only, never money: the prices move, the ratios between a provider's own kinds of
 * input have not.
 *
 *  - **Anthropic** (Claude): a read is 0.1, a five-minute write 1.25, a one-hour write 2. The split is the API's own (`cache_creation`).
 *  - **OpenAI** (Codex), by model: from GPT-5.6 on a read is 0.1 (0.05 on Sol) and a write, for a cache that lives 30 minutes, 1.25;
 *    before it caching was automatic and a write cost the same as uncached input (1). A model whose name says no generation (a
 *    session on the tool's default before the adapter stamped the model it runs, an hour stored without one) is priced as the
 *    current generation, not the old. Codex does not report writes, so the input it
 *    did not read from the cache stands in for them: it is what the provider caches for the next request, as for a rebuild.
 */

export type CachePrices = { read: number; write5m: number; write1h: number }

/** A model name as the tool says it (`gpt-5.6-sol`, `gpt-5.7`): the generation is read from `gpt-<major>.<minor>` */
function gptGeneration(model: string | null | undefined): number | null {
  const m = /gpt-(\d+)(?:\.(\d+))?/i.exec(model ?? '')
  return m ? Number(m[1]) + Number(m[2] ?? 0) / 100 : null
}

export function cachePrices(billing: CacheBilling, model?: string | null): CachePrices {
  if (billing === 'anthropic') return { read: 0.1, write5m: 1.25, write1h: 2 }
  const generation = gptGeneration(model)
  // A name we cannot read is billed as the current generation: only a model named as an older one has the old ratios
  if (generation === null || generation >= 5.06) return { read: /(^|[^a-z])sol([^a-z]|$)/i.test(model ?? '') ? 0.05 : 0.1, write5m: 1.25, write1h: 1.25 }
  return { read: 0.1, write5m: 1, write1h: 1 }
}

/** The tokens of one request, or the sums of many that share a tool and model */
export type CacheTokens = {
  input: number
  read: number
  write: number
  /** Of `write`, what stays cached an hour / five minutes; what is in neither is priced as five minutes */
  write1h?: number
}

/**
 * The cache cost in units of an uncached input token: what was read, and what was written (for a tool that reports no writes, the
 * input it did not read).
 */
export function cacheCost(billing: CacheBilling, model: string | null | undefined, t: CacheTokens, reportsWrites: boolean): { read: number; write: number } {
  const price = cachePrices(billing, model)
  const read = t.read * price.read
  if (!reportsWrites) return { read, write: t.input * price.write5m }
  const hour = Math.min(t.write, Math.max(0, t.write1h ?? 0))
  return { read, write: hour * price.write1h + (t.write - hour) * price.write5m }
}
