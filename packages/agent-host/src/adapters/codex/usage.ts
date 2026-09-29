import type { UsageSnapshot, UsageWindow } from '@cc/protocol'

/**
 * Codex usage and limits (FR-9).
 *
 * Unlike Claude, **the API gives daily tokens directly** — there is no need for us to aggregate
 * them. Both methods are official RPCs with no instability marker.
 *   account/rateLimits/read -> the primary/secondary windows
 *   account/usage/read      -> dailyUsageBuckets
 *
 * **Only subscription limits are covered.** credits (additional billing) are out of scope and not read.
 */

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Builds a human-readable name from the window length (minutes) — the tool does not give a name */
function labelFor(mins: number | null): string {
  if (mins === null) return 'Limit'
  if (mins >= 10080) return `${Math.round(mins / 10080)}w`
  if (mins >= 1440) return `${Math.round(mins / 1440)}d`
  return `${Math.round(mins / 60)}h`
}

function toWindow(id: string, raw: unknown): UsageWindow | null {
  const w = (raw ?? {}) as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown }
  const percent = num(w.usedPercent)
  if (percent === null) return null
  const mins = num(w.windowDurationMins)
  const resets = num(w.resetsAt)
  return {
    id,
    label: labelFor(mins),
    percent: Math.max(0, Math.min(100, percent)),
    // codex gives Unix time in seconds
    resetsAt: resets === null ? null : new Date(resets * 1000).toISOString(),
    scope: null,
  }
}

export function toSnapshot(rateLimits: unknown, usage: unknown): UsageSnapshot {
  const rl = (rateLimits ?? {}) as { rateLimits?: Record<string, unknown> }
  const snap = (rl.rateLimits ?? {}) as Record<string, unknown>

  const windows = (['primary', 'secondary'] as const)
    .map((k) => toWindow(k, snap[k]))
    .filter((w): w is UsageWindow => w !== null)

  const u = (usage ?? {}) as { dailyUsageBuckets?: unknown }
  const buckets = Array.isArray(u.dailyUsageBuckets) ? u.dailyUsageBuckets : []
  const daily: { date: string; tokens: number }[] = []
  for (const b of buckets) {
    const row = (b ?? {}) as { startDate?: unknown; tokens?: unknown }
    const date = str(row.startDate)
    const tokens = num(row.tokens)
    if (date && tokens !== null) daily.push({ date, tokens })
  }

  return { plan: str(snap.planType), windows, daily }
}
