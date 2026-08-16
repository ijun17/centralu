import type { UsageSnapshot, UsageWindow } from '@cc/protocol'

/**
 * Codex 사용량·한도 (FR-9).
 *
 * Claude와 달리 **일별 토큰을 API가 그대로 준다** — 우리가 집계할 필요가 없다.
 * 두 메서드 다 불안정 표시가 없는 정식 RPC다.
 *   account/rateLimits/read → primary/secondary 창
 *   account/usage/read      → dailyUsageBuckets
 *
 * **구독 한도만 다룬다.** credits(추가 결제)는 범위 밖이라 읽지 않는다.
 */

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 창 길이(분)로 사람이 아는 이름을 만든다 — 도구가 이름을 주지 않는다 */
function labelFor(mins: number | null): string {
  if (mins === null) return '한도'
  if (mins >= 10080) return `${Math.round(mins / 10080)}주`
  if (mins >= 1440) return `${Math.round(mins / 1440)}일`
  return `${Math.round(mins / 60)}시간`
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
    // codex는 초 단위 유닉스 시각을 준다
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
