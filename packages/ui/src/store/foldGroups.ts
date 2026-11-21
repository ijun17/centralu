import { parseAppKey, type SessionSummary } from '@cc/core'
import { treeParentOf } from './sidebarTree.js'

// A folded group's key is remembered in `UiPreferences.foldedGroups` (#666), so it must name the group after a restart.
export const FOLDED_GROUPS_MAX = 500

export const childrenGroupKey = (sessionId: string): string => `session:${sessionId}`
export const appGroupKey = (appKey: string): string => `app:${appKey}`

/**
 * The groups that must open for this session's row to show; opening too many is harmless, too few leaves it selected
 * and invisible. A removed app does not claim its sessions (`groupProjectAppSessions`), hence `listedApps`.
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
  // The parent the tree draws this row under: one in the same project and the same app group (or none)
  const parentId = treeParentOf(session, (id) => {
    const parent = all[id]
    if (!parent || parent.projectId !== session.projectId) return false
    const parentOwn = parent.appId ? appKeyOf(parent) : null
    return (parentOwn !== null && listedApps.has(parentOwn) ? parentOwn : null) === appKey
  })
  if (parentId) keys.push(childrenGroupKey(parentId))
  return keys
}

// By value: a reconnect hands over a new array of the same keys
export function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i])
}

/**
 * Dead folds would crowd the cap and push out old folds still in use (#666). A linked machine's keys stay: its rows
 * arrive only with its link. `apps` null (the list says nothing) judges no app key.
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
