import type { UsageHistoryReadings, UsageWindow } from '@cc/protocol/client'
import { formatDuration } from '../../app/format.js'

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

/**
 * The window the top bar draws: the weekly one, else the tool's longest, since a tool whose plan has no weekly window
 * (Cursor's resets with its billing cycle) would otherwise always look unknown. A window carries no length, so the longest
 * is the one that resets last; among equals, or with no reset said, the first the tool lists
 */
export function barWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  const weekly = weeklyWindow(windows)
  if (weekly) return weekly
  const resets = (w: UsageWindow) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN)
  return windows.reduce<UsageWindow | null>((a, b) => (!a || resets(b) > resets(a) || (Number.isNaN(resets(a)) && !Number.isNaN(resets(b))) ? b : a), null)
}

export function isWeekly(w: UsageWindow): boolean {
  return w.id.startsWith('weekly') || /^\d+\s*w$/i.test(w.label.trim())
}

/** When a window resets, as time remaining: how much is left matters more than the moment */
export function resetText(resetsAt: string | null, now: number): string {
  if (!resetsAt) return 'reset time unknown'
  const ms = new Date(resetsAt).getTime() - now
  if (!Number.isFinite(ms)) return 'reset time unknown'
  if (ms <= 0) return 'resets soon'
  return `resets in ${formatDuration(ms, { coarse: true })}`
}

/** How full, as brightness (docs/themes.md "The urgency order") */
export function usageTone(percent: number): string {
  return percent >= 90 ? 'text-ink-signal' : percent >= 70 ? 'text-ink' : 'text-ink-muted'
}

/**
 * The stored series of the window the top bar draws, the weekly one or else the longest (`barWindow` on each latest
 * point), of the account read last, so a changed account shows
 */
export function barSeries(readings: readonly UsageHistoryReadings[]): UsageHistoryReadings | null {
  const live = readings.flatMap((s) => {
    const point = s.points[s.points.length - 1]
    return point ? [{ s, point }] : []
  })
  const newest = live.reduce<(typeof live)[number] | null>((a, x) => (!a || Date.parse(x.point.at) > Date.parse(a.point.at) ? x : a), null)
  if (!newest) return null
  const ofAccount = live.filter((x) => x.s.account === newest.s.account)
  const windows = ofAccount.map(({ s, point }) => ({ id: s.window, label: s.label, percent: point.percent, resetsAt: point.resetsAt, scope: s.scope }))
  const picked = barWindow(windows)
  return picked ? (ofAccount[windows.indexOf(picked)]?.s ?? null) : null
}
