import type { PanelTab } from '../../store/panelLayout.js'

/**
 * What to show and what to collapse in a tab strip that has run out of room (user request,
 * 2026-09-07).
 *
 * One strip carries two things: the left side is which tab to go to, the right side is **the
 * current tab's control buttons**. The control buttons are never collapsed — they are actions on
 * what is being looked at, so they must always stay within reach. So when space runs short, tabs
 * are what gives way, and a pushed-out tab goes behind `…`.
 *
 * Only two rules are kept:
 *   - **The selected tab is never collapsed.** If the name of what is currently being looked at
 *     disappears, there is no way left on screen to tell where it is.
 *   - Order is preserved. If tabs changed position between being collapsed and expanded, the
 *     position the hand remembers would become invalid.
 */
export function fitTabs(
  order: readonly PanelTab[],
  widths: (tab: PanelTab) => number,
  avail: number,
  active: PanelTab,
  opts: { gap: number; more: number },
): { shown: PanelTab[]; hidden: PanelTab[] } {
  const all = [...order]
  if (all.length === 0) return { shown: [], hidden: [] }

  const span = (tabs: readonly PanelTab[]): number =>
    tabs.reduce((n, t) => n + widths(t), 0) + Math.max(0, tabs.length - 1) * opts.gap

  // Everything shows when not yet measured (width 0) or when it all fits — collapsing before measuring causes a flicker
  if (!(avail > 0) || span(all) <= avail) return { shown: all, hidden: [] }

  const budget = avail - opts.more - opts.gap
  const shown: PanelTab[] = []
  for (const t of all) {
    if (span([...shown, t]) > budget) break
    shown.push(t)
  }

  // If the selected tab got pushed out, the last slot is given up for it. The tab that loses its slot collapses, and order stays the same
  if (!shown.includes(active)) {
    shown.pop()
    shown.push(active)
    shown.sort((a, b) => all.indexOf(a) - all.indexOf(b))
  }
  // Even when it is too narrow to fit even one, the selected tab stays — an empty strip says nothing at all
  if (shown.length === 0) shown.push(active)

  return { shown, hidden: all.filter((t) => !shown.includes(t)) }
}
