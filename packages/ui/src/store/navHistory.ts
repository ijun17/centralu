// Back and forward between screens: docs/state-management.md §5a. Pure; the store folds `screenOf` in here.

export type Screen =
  | { kind: 'session'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'app'; projectId: string | null; appId: string; machine?: string | null }
  | { kind: 'grid' }
  | { kind: 'assistant' }
  | { kind: 'settings' }
  /*
   * A file and the git screen are pages drawn over the screen they opened from (`under`, owner 2026-10-18), which is
   * not part of their sameness. A file's `sessionId` is the session whose worktree it opened in (#1209).
   */
  | { kind: 'file'; path: string; projectId: string | null; sessionId?: string | null; under: Screen | null }
  | {
      kind: 'git'
      sub: 'changes' | 'history' | 'branches'
      path: string | null
      sha: string | null
      staged: boolean | null
      under: Screen | null
    }

/** Oldest first; `index` is -1 only while there are none */
export type NavHistory = { entries: Screen[]; index: number }

export const EMPTY_NAV: NavHistory = { entries: [], index: -1 }

export const NAV_LIMIT = 50

export function sameScreen(a: Screen | undefined, b: Screen | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  switch (a.kind) {
    case 'session':
    case 'project':
      return a.id === (b as typeof a).id
    case 'app':
      return (
        a.projectId === (b as typeof a).projectId &&
        a.appId === (b as typeof a).appId &&
        (a.machine ?? null) === ((b as typeof a).machine ?? null)
      )
    case 'file':
      return a.path === (b as typeof a).path && a.projectId === (b as typeof a).projectId && (a.sessionId ?? null) === ((b as typeof a).sessionId ?? null)
    case 'git': {
      const c = b as typeof a
      return a.sub === c.sub && a.path === c.path && a.sha === c.sha && a.staged === c.staged
    }
    default:
      return true
  }
}

export function visit(h: NavHistory, screen: Screen): NavHistory {
  if (sameScreen(h.entries[h.index], screen)) return h
  const entries = [...h.entries.slice(0, h.index + 1), screen].slice(-NAV_LIMIT)
  return { entries, index: entries.length - 1 }
}

// Closing a layer over the previous entry is a step back, so forward reopens it (docs/state-management.md §5a).
export function closeLayer(h: NavHistory, under: Screen): NavHistory {
  const kind = h.entries[h.index]?.kind
  if (
    (kind === 'settings' || kind === 'file' || kind === 'git') &&
    sameScreen(h.entries[h.index - 1], under)
  ) {
    return { entries: h.entries, index: h.index - 1 }
  }
  return visit(h, under)
}

/**
 * Skips and drops gone entries and ones equal to the current (docs/state-management.md §5a). `screen` is null when
 * there is nowhere to go; `history` may still have lost entries.
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

export function canStep(h: NavHistory, dir: -1 | 1, exists: (s: Screen) => boolean): boolean {
  return step(h, dir, exists).screen !== null
}
