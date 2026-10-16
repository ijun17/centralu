import type { TokenUsage } from '@cc/protocol'

/**
 * A token count a tool reported, or 0 (#843). `Number(x ?? 0)` turned anything that is not a number (a string, an
 * object) into NaN, and one NaN in a running reading stays NaN for the life of the session.
 */
export const tokenCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export const NO_TOKENS: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }

/** Two readings added up, field by field; the cost is the first's (a per-request reading carries none) */
export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    ...(a.costUsd !== undefined ? { costUsd: a.costUsd } : {}),
  }
}
