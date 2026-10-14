import type { SessionSummary } from '@cc/core'

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
