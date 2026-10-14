import { parseAppKey, type SessionSummary } from '@cc/core'

/*
 * Folding a group (#666). A group is the rows hidden behind one chevron: the children a session started, or the
 * sessions an app owns. Its key is what the screen preferences remember (`UiPreferences.foldedGroups`), so it has to
 * name the same group after a restart: a session id and an app key both do.
 */
/** The most keys the preference holds (`UiPreferences.foldedGroups`); the oldest fold is dropped past it */
export const FOLDED_GROUPS_MAX = 500

export const childrenGroupKey = (sessionId: string): string => `session:${sessionId}`
export const appGroupKey = (appKey: string): string => `app:${appKey}`

/**
 * Every group that has to be open for this session's row to be on screen: its app's group (when the app is listed, so
 * the row stands under it) and its parent's group (when the parent is in the same list, so it is drawn nested).
 *
 * Opening more than strictly needed is harmless; opening less leaves a session selected and invisible, which is the
 * one thing this exists to prevent. `listedApps` is the set of app keys the sidebar has a row for: a removed app does
 * not claim its sessions (`groupProjectAppSessions`), so its key must not unfold anything.
 */
export function foldGroupsHiding(
  session: SessionSummary,
  all: Readonly<Record<string, SessionSummary>>,
  appKeyOf: (s: SessionSummary) => string | null,
  listedApps: ReadonlySet<string>,
): string[] {
  const own = session.appId ? appKeyOf(session) : null
  const appKey = own !== null && listedApps.has(own) ? own : null
  const keys: string[] = appKey !== null ? [appGroupKey(appKey)] : []
  const parentId =
    session.parentSessionId ? session.parentSessionId
    : session.askedBy && session.askedBy !== session.id ? session.askedBy
    : null
  const parent = parentId ? all[parentId] : undefined
  if (parent && parent.projectId === session.projectId) {
    const parentOwn = parent.appId ? appKeyOf(parent) : null
    // Only a parent in the same list draws this row nested under itself
    if ((parentOwn !== null && listedApps.has(parentOwn) ? parentOwn : null) === appKey) keys.push(childrenGroupKey(parent.id))
  }
  return keys
}

/** The same keys in the same order. Folds are compared by what they hold, never by which array holds them */
export function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i])
}

/**
 * The folds whose group no longer exists, to be dropped (#666).
 *
 * A fold outlives its group otherwise: a deleted session or a removed app leaves its key in the preference, the keys
 * add up toward the cap, and past it the oldest are dropped, which are the folds a person set long ago and still uses.
 *
 * Only a key that can be judged here is judged. A linked machine's sessions and apps arrive when its link comes up and
 * are absent before that, so a key naming one (a session id or a project id with a `.`, an app key with a `:`) stays
 * until it is deleted for real. `apps` is null when the app list says nothing (never read, or empty), and then no app
 * key is judged.
 */
export function deadFoldKeys(
  keys: readonly string[],
  sessions: Readonly<Record<string, unknown>>,
  apps: ReadonlySet<string> | null,
): string[] {
  return keys.filter((key) => {
    if (key.startsWith('session:')) {
      const id = key.slice('session:'.length)
      return !id.includes('.') && !(id in sessions)
    }
    if (key.startsWith('app:')) {
      const appKey = key.slice('app:'.length)
      const parsed = parseAppKey(appKey)
      // A key that does not parse, or one of a linked machine (its own user folder, or a project id `<machine>.<id>`)
      if (apps === null || !parsed || parsed.machine || parsed.projectId?.includes('.')) return false
      return !apps.has(appKey)
    }
    return false
  })
}
