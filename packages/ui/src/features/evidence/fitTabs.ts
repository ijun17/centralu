import type { PanelTab } from '../../store/panelLayout.js'

/**
 * A strip out of room gives up tabs behind `…`, never the current tab's buttons on its right. The selected tab always
 * stays (it says where you are), and order is kept so the hand's memory of positions holds.
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

  // Unmeasured (0) shows all: collapsing before measuring flickers
  if (!(avail > 0) || span(all) <= avail) return { shown: all, hidden: [] }

  const budget = avail - opts.more - opts.gap
  const shown: PanelTab[] = []
  for (const t of all) {
    if (span([...shown, t]) > budget) break
    shown.push(t)
  }

  // A pushed-out selected tab takes the last slot
  if (!shown.includes(active)) {
    shown.pop()
    shown.push(active)
    shown.sort((a, b) => all.indexOf(a) - all.indexOf(b))
  }
  // Too narrow for one: the selected tab still stays
  if (shown.length === 0) shown.push(active)

  return { shown, hidden: all.filter((t) => !shown.includes(t)) }
}
