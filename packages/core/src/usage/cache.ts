import type { CacheStats, CacheWindowStats } from '@cc/protocol/client'
import { formatClock } from '../clock/clock.js'

/** The three input parts that do not overlap (`TokenUsage`) */
type Input = Pick<CacheWindowStats, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>

/** Null with no input: nothing to judge, not 0%. Codex reports reads only, so its `cacheCreation` is 0 */
export function cacheHitRate(w: Input): number | null {
  const total = w.inputTokens + w.cacheReadTokens + w.cacheCreationTokens
  return total > 0 ? w.cacheReadTokens / total : null
}

/**
 * Weighted by price ratio to uncached input, not money (#1492): by tokens a write hides its cost (96% hit by tokens was
 * about 43% of the cost). For Codex, which reports no writes, the "writes" are the input it did not read.
 */
export function cacheWriteShare(w: Pick<CacheWindowStats, 'cacheReadCost' | 'cacheWriteCost'>): number | null {
  if (w.cacheReadCost === undefined || w.cacheWriteCost === undefined) return null
  const total = w.cacheReadCost + w.cacheWriteCost
  return total > 0 ? w.cacheWriteCost / total : null
}

/** Keep one decimal for every partial rate, without presenting a rounded rate as zero or perfect. */
export function percentOf(rate: number): string {
  if (rate === 0 || rate === 1) return String(rate * 100)
  const percent = rate * 100
  if (percent < 0.05) return '<0.1'
  if (percent >= 99.95) return '>99.9'
  return percent.toFixed(1)
}

/** "since 14:02" when the host started inside the window (its counts live in memory), so two hours never read as five */
export function cacheWindowName(w: Pick<CacheWindowStats, 'label' | 'since'>, countingSince: string): string {
  const from = Date.parse(countingSince)
  if (!Number.isFinite(from) || from <= Date.parse(w.since)) return w.label
  return `since ${formatClock(from)}`
}

/** "Cache hit 94.0% · last 5 h" over the first window */
export function cacheTooltipLine(cache: CacheStats | undefined): string | null {
  const w = cache?.windows[0]
  if (!cache || !w) return null
  const name = cacheWindowName(w, cache.countingSince)
  const rate = cacheHitRate(w)
  return rate === null ? `Cache: no requests · ${name}` : `Cache hit ${percentOf(rate)}% · ${name}`
}

/** `RebuildCause`, docs/agent-host/prompt-cache.md */
export const REBUILD_CAUSE_LABEL: Readonly<Record<string, string>> = {
  cold_start: 'first request',
  subagent: 'subagent start',
  new_process: 'new process',
  model_change: 'model change',
  compaction: 'compaction',
  thread_restart: 'thread restart',
  instructions: 'tools changed',
  launch_settings: 'launch settings changed',
  expired: 'cache expired',
  probably_expired: 'probably expired',
  unknown: 'unknown',
}

/** Ties go in the order of evidence, unknown last */
const CAUSE_ORDER = Object.keys(REBUILD_CAUSE_LABEL)
const rank = (cause: string) => {
  const i = CAUSE_ORDER.indexOf(cause)
  // A cause this build does not know goes just before unknown
  return i >= 0 ? i : CAUSE_ORDER.length - 1.5
}

/** "3 cache expired (idle 6–64 min) · 1 model change", most first; a cause this build does not know shows its name */
export function rebuildBreakdown(
  causes: Readonly<Record<string, number>> | undefined,
  expiredIdleMs?: { min: number; max: number },
): string {
  let idleSaid = false
  return Object.entries(causes ?? {})
    .filter(([, n]) => n > 0)
    .sort(([a, x], [b, y]) => y - x || rank(a) - rank(b))
    .map(([cause, n]) => {
      let text = `${n} ${REBUILD_CAUSE_LABEL[cause] ?? cause.replace(/_/g, ' ')}`
      if (!idleSaid && expiredIdleMs && (cause === 'expired' || cause === 'probably_expired')) {
        idleSaid = true
        text += ` (idle ${idleRange(expiredIdleMs)})`
      }
      return text
    })
    .join(' · ')
}

/** "6–64 min", "12 min", "3–5 h" */
function idleRange({ min, max }: { min: number; max: number }): string {
  const unit = max >= 120 * 60_000 ? { ms: 3600_000, name: 'h' } : { ms: 60_000, name: 'min' }
  const lo = Math.round(min / unit.ms)
  const hi = Math.round(max / unit.ms)
  return lo === hi ? `${hi} ${unit.name}` : `${lo}–${hi} ${unit.name}`
}
