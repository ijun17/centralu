import type { UsageHistoryReadings, UsageWindow } from '@cc/protocol/client'

/**
 * The weekly window the top-bar donut draws, by id or name, as tools name them differently (measured): claude
 * `weekly_all` / `weekly_scoped`, codex `secondary` labelled `1w`. None found: null, and the donut says unknown.
 */
export function weeklyWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  const weekly = windows.filter(isWeekly)
  if (weekly.length === 0) return null
  // The fullest: a full per-model weekly must not hide behind a roomy account-wide one. Its name is in the tooltip
  return weekly.reduce((a, b) => (b.percent > a.percent ? b : a))
}

function isWeekly(w: UsageWindow): boolean {
  return w.id.startsWith('weekly') || /^\d+\s*w$/i.test(w.label.trim())
}

/** How full, as brightness (docs/themes.md "The urgency order") */
export function usageTone(percent: number): string {
  return percent >= 90 ? 'text-ink-signal' : percent >= 70 ? 'text-ink' : 'text-ink-muted'
}

/** The stored weekly series (`weeklyWindow` on each latest point) of the account read last, so a changed account shows */
export function weeklySeries(readings: readonly UsageHistoryReadings[]): UsageHistoryReadings | null {
  const live = readings.flatMap((s) => {
    const point = s.points[s.points.length - 1]
    return point ? [{ s, point }] : []
  })
  const newest = live.reduce<(typeof live)[number] | null>((a, x) => (!a || Date.parse(x.point.at) > Date.parse(a.point.at) ? x : a), null)
  if (!newest) return null
  const ofAccount = live.filter((x) => x.s.account === newest.s.account)
  const windows = ofAccount.map(({ s, point }) => ({ id: s.window, label: s.label, percent: point.percent, resetsAt: point.resetsAt, scope: s.scope }))
  const picked = weeklyWindow(windows)
  return picked ? (ofAccount[windows.indexOf(picked)]?.s ?? null) : null
}
