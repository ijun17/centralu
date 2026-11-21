// The right panel's tab arrangement (#20), pure so it is testable without a browser. At most
// two stacked groups (the split's drop zone is "the bottom half"), each with ordered tabs and an
// active one. Global and persisted (#20): per project, the panel would rearrange on every switch.
import { moveTo } from '../features/sidebar/reorder.js'

/** Dragged tabs must not land in the sidebar's lists, nor sessions in the tab strip */
export const PANEL_TAB_MIME = 'application/x-cc-panel-tab'

/** The order ⌘⇧1–4 map onto and a fresh install shows */
export const PANEL_TABS = ['git', 'history', 'files', 'terminal'] as const

/** `history` is its own tab (#21): a log strip inside `git` would overflow a short split group */
export type PanelTab = (typeof PANEL_TABS)[number]

export type PanelGroup = { tabs: PanelTab[]; active: PanelTab }

export function defaultLayout(): PanelGroup[] {
  return [{ tabs: [...PANEL_TABS], active: 'git' }]
}

export function activateTab(groups: PanelGroup[], tab: PanelTab): PanelGroup[] {
  return groups.map((g) => (g.tabs.includes(tab) && g.active !== tab ? { ...g, active: tab } : g))
}

function without(groups: PanelGroup[], tab: PanelTab): PanelGroup[] {
  return groups
    .map((g) => {
      const tabs = g.tabs.filter((t) => t !== tab)
      return { tabs, active: g.active === tab ? (tabs[0] ?? g.active) : g.active }
    })
    .filter((g) => g.tabs.length > 0)
}

/** The dropped tab becomes its group's active one: showing another reads as a failed drop. */
export function moveTab(groups: PanelGroup[], dragged: PanelTab, target: PanelTab, before: boolean): PanelGroup[] {
  if (dragged === target) return groups
  const from = groups.findIndex((g) => g.tabs.includes(dragged))
  const to = groups.findIndex((g) => g.tabs.includes(target))
  if (from === -1 || to === -1) return groups
  if (from === to) {
    return groups.map((g, i) =>
      i === from ? { tabs: moveTo(g.tabs, dragged, target, before) as PanelTab[], active: dragged } : g,
    )
  }
  // Pulling it out may dissolve the source group (the unsplit path), so find the target again.
  return without(groups, dragged).map((g) => {
    if (!g.tabs.includes(target)) return g
    const at = g.tabs.indexOf(target)
    const tabs = [...g.tabs]
    tabs.splice(before ? at : at + 1, 0, dragged)
    return { tabs, active: dragged }
  })
}

/** A drop on a strip's empty space or a group's body; emptying the bottom group closes the split. */
export function moveTabToGroupEnd(groups: PanelGroup[], dragged: PanelTab, groupIndex: number): PanelGroup[] {
  const dest = groups[groupIndex]
  if (!dest || !groups.some((g) => g.tabs.includes(dragged))) return groups
  const next = groups.map((g) => {
    const tabs = g.tabs.filter((t) => t !== dragged)
    return { tabs, active: g.active === dragged && tabs.length > 0 ? tabs[0]! : g.active }
  })
  next[groupIndex] = { tabs: [...next[groupIndex]!.tabs, dragged], active: dragged }
  // Filter after the insert: dropping an emptied source group first would shift `groupIndex`.
  return next.filter((g) => g.tabs.length > 0)
}

/** A drop in the bottom half of the panel body; with two groups it joins the bottom one (the cap). */
export function splitTab(groups: PanelGroup[], dragged: PanelTab): PanelGroup[] {
  if (!groups.some((g) => g.tabs.includes(dragged))) return groups
  if (groups.length >= 2) return moveTabToGroupEnd(groups, dragged, 1)
  if (groups[0]!.tabs.length <= 1) return groups
  return [...without(groups, dragged), { tabs: [dragged], active: dragged }]
}

/**
 * The snapshot is untrusted; the result holds every tab once, at most two groups, a valid active.
 * Unrecognizable falls back to the default (half-restored reads as misremembering); a tab the
 * snapshot predates joins the first group.
 */
export function sanitizeLayout(raw: unknown): PanelGroup[] {
  if (!Array.isArray(raw)) return defaultLayout()
  const seen = new Set<PanelTab>()
  const groups: PanelGroup[] = []
  for (const g of raw.slice(0, 2)) {
    const tabsRaw = (g as { tabs?: unknown } | null)?.tabs
    if (!Array.isArray(tabsRaw)) return defaultLayout()
    // Adding to `seen` while filtering also catches a duplicate within one group
    const tabs: PanelTab[] = []
    for (const t of tabsRaw) {
      if ((PANEL_TABS as readonly unknown[]).includes(t) && !seen.has(t as PanelTab)) {
        seen.add(t as PanelTab)
        tabs.push(t as PanelTab)
      }
    }
    if (tabs.length === 0) continue
    const active = (g as { active?: unknown }).active
    groups.push({ tabs, active: tabs.includes(active as PanelTab) ? (active as PanelTab) : tabs[0]! })
  }
  if (groups.length === 0) return defaultLayout()
  const missing = PANEL_TABS.filter((t) => !seen.has(t))
  if (missing.length > 0) groups[0] = { ...groups[0]!, tabs: [...groups[0]!.tabs, ...missing] }
  return groups
}
