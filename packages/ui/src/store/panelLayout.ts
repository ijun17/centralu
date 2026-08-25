/**
 * The right panel's tab arrangement (issue #20) — the pure part.
 *
 * Same reasoning as sidebar/reorder.ts, which this reuses: "where does the tab land"
 * is the calculation that goes wrong, so it lives outside the DOM events where it can
 * be verified without a browser.
 *
 * The shape is the one the issue decision asked for: **groups, each with an ordered tab
 * list and an active tab**, stacked vertically in the panel. One group is the everyday
 * case; a second appears when a tab is dragged into the bottom half of the panel body
 * and dissolves when its last tab is dragged back to a strip. Never more than two —
 * the drop zone is "the bottom half", and a third half does not exist (nor would a
 * ~340px column honestly show three things at once).
 *
 * The arrangement is **global and persisted** (#20 decision): the panel is a way of
 * looking, not project state, so there is one arrangement for the whole app and it
 * survives a relaunch. Per-project memory would make the panel rearrange itself when
 * you switch projects — which reads as the app forgetting, not remembering.
 */
import { moveTo } from '../features/sidebar/reorder.js'

/** Dragged tabs must not land in the sidebar's lists, nor sessions in the tab strip */
export const PANEL_TAB_MIME = 'application/x-cc-panel-tab'

/**
 * Every tab, in identity order. This order is what ⌘⇧1–4 map onto (1 git · 2 history ·
 * 3 files · 4 terminal) and what a fresh install shows in the strip.
 */
export const PANEL_TABS = ['git', 'history', 'files', 'terminal'] as const

/**
 * What the evidence panel can show.
 *
 * `history` is the only place the log lives now. It started (#21) alongside a log strip
 * inside the git tab; that strip was a fixed-height block, and once the panel could
 * split into stacked groups (#20) it overflowed a short group straight over the next
 * group's tab strip — so it left, and its lane graph moved here. Wanting the log next
 * to the git tab is exactly what the split is for: drag `history` below `git`.
 */
export type PanelTab = (typeof PANEL_TABS)[number]

/** One vertical slot of the panel: which tabs live here, and which one is showing */
export type PanelGroup = { tabs: PanelTab[]; active: PanelTab }

/** A fresh install: one group, every tab, git in front (what the old `panelTab` defaulted to) */
export function defaultLayout(): PanelGroup[] {
  return [{ tabs: [...PANEL_TABS], active: 'git' }]
}

/** Show `tab` in whichever group holds it. A tab nobody holds changes nothing. */
export function activateTab(groups: PanelGroup[], tab: PanelTab): PanelGroup[] {
  return groups.map((g) => (g.tabs.includes(tab) && g.active !== tab ? { ...g, active: tab } : g))
}

/**
 * Remove `tab` everywhere, keeping each remaining group honest: a group whose active
 * tab left shows its first remaining one, and a group left empty stops existing —
 * an empty strip above an empty body is not an arrangement anyone asked for.
 */
function without(groups: PanelGroup[], tab: PanelTab): PanelGroup[] {
  return groups
    .map((g) => {
      const tabs = g.tabs.filter((t) => t !== tab)
      return { tabs, active: g.active === tab ? (tabs[0] ?? g.active) : g.active }
    })
    .filter((g) => g.tabs.length > 0)
}

/**
 * Move `dragged` so it sits before/after `target`, which may live in another group.
 * Within one group this defers to the sidebar's `moveTo` — same maths, same edge cases
 * (self-drop and unknown ids are no-ops there, and stay no-ops here).
 *
 * The dragged tab becomes its destination group's active one: you dropped it to look
 * at it, and landing a tab somewhere only to be shown a different one reads as the
 * drop having failed.
 */
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
  // Across groups: pull it out first (which may dissolve the source group — that is
  // the unsplit path), then find the target again in what is left.
  return without(groups, dragged).map((g) => {
    if (!g.tabs.includes(target)) return g
    const at = g.tabs.indexOf(target)
    const tabs = [...g.tabs]
    tabs.splice(before ? at : at + 1, 0, dragged)
    return { tabs, active: dragged }
  })
}

/**
 * Drop on a strip's empty space (or a group's body): the tab joins that group's end.
 * This is also how the split closes — dragging the bottom group's last tab to the top
 * strip empties the bottom group, and an empty group stops existing.
 */
export function moveTabToGroupEnd(groups: PanelGroup[], dragged: PanelTab, groupIndex: number): PanelGroup[] {
  const dest = groups[groupIndex]
  if (!dest || !groups.some((g) => g.tabs.includes(dragged))) return groups
  const next = groups.map((g) => {
    const tabs = g.tabs.filter((t) => t !== dragged)
    return { tabs, active: g.active === dragged && tabs.length > 0 ? tabs[0]! : g.active }
  })
  next[groupIndex] = { tabs: [...next[groupIndex]!.tabs, dragged], active: dragged }
  // Filtering after the insert keeps `groupIndex` meaningful — the source group may
  // just have emptied, and dropping it earlier would shift the destination's index.
  return next.filter((g) => g.tabs.length > 0)
}

/**
 * Drag a tab into the bottom half of the panel body: it moves to the bottom group,
 * creating it on the first split. With the split already open the drop lands in the
 * existing bottom group instead — the two-group cap, expressed as a fallthrough.
 * The only tab of the only group cannot split: nothing would be left on top.
 */
export function splitTab(groups: PanelGroup[], dragged: PanelTab): PanelGroup[] {
  if (!groups.some((g) => g.tabs.includes(dragged))) return groups
  if (groups.length >= 2) return moveTabToGroupEnd(groups, dragged, 1)
  if (groups[0]!.tabs.length <= 1) return groups
  return [...without(groups, dragged), { tabs: [dragged], active: dragged }]
}

/**
 * A snapshot is a file on disk — treat it as untrusted. Whatever comes back, the
 * result always has every tab exactly once, at most two groups, and a valid active
 * per group. Anything unrecognizable falls back to the default rather than guessing:
 * a half-restored arrangement reads as the app misremembering, which is worse than
 * forgetting. Tabs a snapshot does not mention (it may predate a tab's existence —
 * `history` arrived in #21) rejoin the end of the first group.
 */
export function sanitizeLayout(raw: unknown): PanelGroup[] {
  if (!Array.isArray(raw)) return defaultLayout()
  const seen = new Set<PanelTab>()
  const groups: PanelGroup[] = []
  for (const g of raw.slice(0, 2)) {
    const tabsRaw = (g as { tabs?: unknown } | null)?.tabs
    if (!Array.isArray(tabsRaw)) return defaultLayout()
    // Adding to `seen` as we filter is what catches a duplicate *within* one group,
    // not just across groups — a snapshot can hold either kind of corruption
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
