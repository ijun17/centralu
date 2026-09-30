import type { UsageWindow } from '@cc/protocol'

/**
 * Pick the single **weekly window** the top-bar donut should draw (user request, 2026-09-09).
 *
 * Window names differ by tool (measured):
 *   claude — `session` (5 hours) · `weekly_all` (Weekly) · `weekly_scoped` (Weekly per model)
 *   codex  — `primary` · `secondary`, with names derived from the window length (`5h` · `1w`)
 *
 * So it looks by **both** id and name. If none is found, it returns **null** — drawing whichever
 * window happens to be there would make the donut say something untrue. In that case the donut
 * shows "unknown", and the window list's expandable detail shows everything.
 */
export function weeklyWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  const weekly = windows.filter(isWeekly)
  if (weekly.length === 0) return null
  /*
   * If there is more than one, put forward **whichever is fullest** (user's observation,
   * 2026-09-09: "Weekly (per model) seems to be missing").
   *
   * claude gives both an account-wide weekly (weekly_all) and a per-model weekly
   * (weekly_scoped). Drawing only the account one would make the dashboard say there is room to
   * spare when the model limit is already the one that is full — the wall the person hits first
   * would be invisible. The rule does not vary by person: draw **whichever limit is reached
   * first**. Which window that is is said by name in the tooltip and the detail view.
   */
  return weekly.reduce((a, b) => (b.percent > a.percent ? b : a))
}

/** Is this a window worth calling weekly — tool names differ, so both id and name are checked */
function isWeekly(w: UsageWindow): boolean {
  return w.id.startsWith('weekly') || /^\d+\s*w$/i.test(w.label.trim())
}

/** How full it is, expressed as brightness (the rule for a screen with no color). The more dangerous, the brighter */
export function usageTone(percent: number): string {
  return percent >= 90 ? 'text-beacon' : percent >= 70 ? 'text-chalk' : 'text-ash'
}
