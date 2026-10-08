/**
 * Back and forward between screens, like a web browser (#374).
 *
 * An entry is what a person would call "a screen": one session, one project's screen, one app's page, the grid, the
 * orchestrator, or Settings. Nothing finer: a keystroke, a scroll, a panel moved on the grid or a session picked
 * inside the grid does not make a new entry, because going back to it would look like nothing happened. The grid is
 * one entry whatever stands on it; going back to it shows the grid as it is now, as a browser shows a page.
 *
 * Pure, so the rules are tested without a store: the store derives the screen on every change (`screenOf` in
 * store.ts) and folds it in here.
 */

export type Screen =
  | { kind: 'session'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'app'; projectId: string | null; appId: string }
  | { kind: 'grid' }
  | { kind: 'orchestrator' }
  | { kind: 'settings' }

/** The entries, oldest first, and which one is on screen. `index` is -1 only while there are none */
export type NavHistory = { entries: Screen[]; index: number }

export const EMPTY_NAV: NavHistory = { entries: [], index: -1 }

/**
 * How many entries are kept. Past it the oldest goes, as a browser's does: nobody walks back fifty screens, and the
 * history lives for one run of the app only, so it has no reason to grow with the day.
 */
export const NAV_LIMIT = 50

export function sameScreen(a: Screen | undefined, b: Screen | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  switch (a.kind) {
    case 'session':
    case 'project':
      return a.id === (b as typeof a).id
    case 'app':
      return a.projectId === (b as typeof a).projectId && a.appId === (b as typeof a).appId
    default:
      return true
  }
}

/**
 * A new screen is on: it becomes the current entry, and whatever was ahead of the old one is dropped (a browser's
 * forward list goes the moment you follow a link). Opening the screen already on adds nothing.
 */
export function visit(h: NavHistory, screen: Screen): NavHistory {
  if (sameScreen(h.entries[h.index], screen)) return h
  const entries = [...h.entries.slice(0, h.index + 1), screen].slice(-NAV_LIMIT)
  return { entries, index: entries.length - 1 }
}

/**
 * A layer laid over a screen (Settings) was closed, and the screen under it is on again. When the layer is the
 * current entry and that screen is the one before it, this steps back to it rather than adding it a second time:
 * closing Settings is going back, and forward reopens it. Anything else is an ordinary visit.
 */
export function closeLayer(h: NavHistory, under: Screen): NavHistory {
  if (h.entries[h.index]?.kind === 'settings' && sameScreen(h.entries[h.index - 1], under)) {
    return { entries: h.entries, index: h.index - 1 }
  }
  return visit(h, under)
}

/**
 * One step back (-1) or forward (1). A screen that no longer exists (a deleted session, a removed app or project) is
 * skipped and dropped, as is an entry the same as the current one (which removing a screen between two visits of
 * the same place leaves behind), so every step shows something new. `screen` is null when there is nowhere to go;
 * `history` may still have lost entries that are gone.
 */
export function step(
  h: NavHistory,
  dir: -1 | 1,
  exists: (s: Screen) => boolean,
): { history: NavHistory; screen: Screen | null } {
  const entries = [...h.entries]
  let index = h.index
  let i = index + dir
  while (i >= 0 && i < entries.length) {
    const candidate = entries[i]!
    if (exists(candidate) && !sameScreen(candidate, entries[index])) {
      return { history: { entries, index: i }, screen: candidate }
    }
    entries.splice(i, 1)
    if (dir < 0) {
      index--
      i--
    }
  }
  return { history: entries.length === h.entries.length ? h : { entries, index }, screen: null }
}

/** Whether a step that way would land somewhere, for the top bar's buttons (the same rules as `step`) */
export function canStep(h: NavHistory, dir: -1 | 1, exists: (s: Screen) => boolean): boolean {
  return step(h, dir, exists).screen !== null
}
