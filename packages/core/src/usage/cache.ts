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

/** What each rebuild cause is called on screen (`RebuildCause`, docs/agent-host.md §6.1) */
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

/** The order causes are listed in when their counts tie: the order of evidence, unknown last */
const CAUSE_ORDER = Object.keys(REBUILD_CAUSE_LABEL)
const rank = (cause: string) => {
  const i = CAUSE_ORDER.indexOf(cause)
  // A cause this build does not know goes just before unknown
  return i >= 0 ? i : CAUSE_ORDER.length - 1.5
}

/**
 * The rebuilds by cause, in one line: "3 cache expired · 1 model change · 1 unknown", most first. The idle time before
 * the rebuilds put down to expiry follows the first of them ("3 cache expired (idle 6–64 min)"). A cause this build
 * does not know (a newer host's) is shown by its name. Empty when there is nothing to break down.
 */
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

/** "6–64 min", "12 min", "3–5 h": the idle time in the unit that reads */
function idleRange({ min, max }: { min: number; max: number }): string {
  const unit = max >= 120 * 60_000 ? { ms: 3600_000, name: 'h' } : { ms: 60_000, name: 'min' }
  const lo = Math.round(min / unit.ms)
  const hi = Math.round(max / unit.ms)
  return lo === hi ? `${hi} ${unit.name}` : `${lo}–${hi} ${unit.name}`
}
