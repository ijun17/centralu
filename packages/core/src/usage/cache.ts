import type { CacheStats, CacheWindowStats } from '@cc/protocol'

/** The input side of a window or a session: the three parts that do not overlap (`TokenUsage`) */
type Input = Pick<CacheWindowStats, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>

/**
 * The share of input the model read from the prompt cache: `cacheRead / (input + cacheRead + cacheCreation)`, 0 to 1.
 * Null with no input at all, which is "nothing to judge", not 0%.
 *
 * For a tool that reports reads only (Codex) `cacheCreation` is 0, so this is cached input over all input, which is
 * what that tool can say.
 */
export function cacheHitRate(w: Input): number | null {
  const total = w.inputTokens + w.cacheReadTokens + w.cacheCreationTokens
  return total > 0 ? w.cacheReadTokens / total : null
}

/** A rate as a whole percent, for reading at a glance */
export function percentOf(rate: number): number {
  return Math.round(rate * 100)
}

/**
 * What a window is called on screen. Its own name ("last 5 h") when the host counted all of it; "since 14:02" when the
 * host started inside it, so a figure that covers two hours never reads as five (the counts live in the host's memory).
 */
export function cacheWindowName(w: Pick<CacheWindowStats, 'label' | 'since'>, countingSince: string): string {
  const from = Date.parse(countingSince)
  if (!Number.isFinite(from) || from <= Date.parse(w.since)) return w.label
  const d = new Date(from)
  return `since ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The one line the usage gauge's tooltip carries: the hit rate over its first window ("Cache hit 94% · last 5 h").
 * Null when the host did not say (one that predates the figures), so the tooltip stays as it was.
 */
export function cacheTooltipLine(cache: CacheStats | undefined): string | null {
  const w = cache?.windows[0]
  if (!cache || !w) return null
  const name = cacheWindowName(w, cache.countingSince)
  const rate = cacheHitRate(w)
  return rate === null ? `Cache: no requests · ${name}` : `Cache hit ${percentOf(rate)}% · ${name}`
}
