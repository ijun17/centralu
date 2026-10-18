import { appKeyOf, appPanelId, arrangePanels, sessionPanelId } from '@cc/core'
import type { AppState } from './state.js'
import type { Screen } from './navHistory.js'
import { externalAppKey, gridAppViewKey, isApp } from './appKeys.js'
import { sidebarProjectOf } from './sidebarTree.js'

/**
 * Which screen the person is on, read from the store's state: the project screen and what it shows,
 * the project the focus lane is in, the apps the grid shows, and the screen history records (#374).
 * Pure selectors; components and the store's actions read them alike.
 */

/**
 * The project whose screen is showing (#203), or null. The project screen is the focus lane with no session
 * picked: `focusProject` releases the session focus to open it, and picking a session leaves it.
 */
export function projectScreenOf(
  s: Pick<AppState, 'view' | 'focusedSessionId' | 'focusedProjectId' | 'projects'>,
): string | null {
  const pid = s.view === 'focus' && !s.focusedSessionId ? s.focusedProjectId : null
  return pid && s.projects[pid] ? pid : null
}

/**
 * The project the focus lane is showing — its screen, one of its sessions or one of its apps — or null. The sidebar tints that
 * project's group, so the person can see which project they are in as well as which row.
 *
 * Only the focus lane counts: the grid and the orchestrator are views of their own, lit by their own buttons, and a
 * tinted project beside them would be a second answer to "what am I looking at".
 *
 * A focused session answers with **its own** project, not `focusedProjectId`. Opening a session that has no project
 * (a coordinator) leaves `focusedProjectId` on the project looked at last, and reading that would tint a project the
 * screen is not showing.
 */
export function openProjectOf(
  s: Pick<
    AppState,
    'view' | 'focusedSessionId' | 'focusedProjectId' | 'focusedApp' | 'projects' | 'sessions'
  >,
): string | null {
  /*
   * An app open in the app view belongs to its project the way a session does: the person is inside that project, so
   * its group is tinted and the app's own row carries the mark. An app in the user folder belongs to no project and
   * tints nothing, like a session with no project.
   */
  if (s.view === 'app') {
    const pid = s.focusedApp?.projectId
    return pid && s.projects[pid] ? pid : null
  }
  if (!s.focusedSessionId) return projectScreenOf(s)
  if (s.view !== 'focus') return null
  // The group the session's row stands in, which is not its own project for a child started on another machine (#1038)
  const picked = s.sessions[s.focusedSessionId]
  const pid = picked ? sidebarProjectOf(picked, s.sessions) : null
  return pid && s.projects[pid] ? pid : null
}

/**
 * Where "New session" from the command palette starts one (#529): the project the person is in, by the same answer the
 * sidebar tints (`openProjectOf`); on the grid, the focused panel's session's project; otherwise the project looked at
 * last, then the first one. null only when there is no project at all, and the palette then does not offer it.
 */
export function newSessionProjectOf(
  s: Pick<
    AppState,
    'view' | 'focusedSessionId' | 'focusedProjectId' | 'focusedApp' | 'projects' | 'sessions'
  >,
): string | null {
  const known = (pid: string | null | undefined) => (pid && s.projects[pid] ? pid : null)
  return (
    openProjectOf(s) ??
    known(s.focusedSessionId ? s.sessions[s.focusedSessionId]?.projectId : null) ??
    known(s.focusedProjectId) ??
    Object.keys(s.projects)[0] ??
    null
  )
}

/**
 * The sessions explicitly placed on the project screen right now. The
 * trash (#204) needs no rule here — a trashed session is not in `sessions`.
 */
export function projectScreenSessions(
  s: Pick<
    AppState,
    'view' | 'focusedSessionId' | 'focusedProjectId' | 'projects' | 'sessions' | 'projectPanels'
  >,
): string[] {
  const pid = projectScreenOf(s)
  if (!pid) return []
  const sessions = Object.values(s.sessions).filter((x) => x.projectId === pid)
  const shown = new Set(
    arrangePanels(
      sessions.map((x) => sessionPanelId(x.id)),
      s.projectPanels[pid],
    ),
  )
  return sessions.filter((x) => shown.has(sessionPanelId(x.id))).map((x) => x.id)
}

/**
 * The apps the project screen shows as panels right now, as pinned view keys (#203). PinnedApps lays exactly these
 * over their panels, so it and ProjectView must not decide this separately.
 */
export function projectScreenAppKeys(
  s: Pick<
    AppState,
    'view' | 'focusedSessionId' | 'focusedProjectId' | 'projects' | 'externalApps' | 'projectPanels'
  >,
): string[] {
  const pid = projectScreenOf(s)
  if (!pid) return []
  const apps = s.externalApps.filter((a) => a.projectId === pid)
  const shown = new Set(
    arrangePanels(
      apps.map((a) => appPanelId(a.appId)),
      s.projectPanels[pid],
    ),
  )
  return apps.filter((a) => shown.has(appPanelId(a.appId))).map((a) => externalAppKey(pid, a.appId))
}

/**
 * The apps the grid shows as panels right now, as their grid view keys (#288, `gridAppViewKey`). PinnedApps lays exactly
 * these over the grid's panels, and GridView opens a view for each, so the two read this one answer. An app the list does
 * not have is not a panel (`visibleGridPanels`), so it gets no view either.
 */
export function gridScreenAppKeys(s: Pick<AppState, 'view' | 'gridPanels' | 'externalApps'>): string[] {
  if (s.view !== 'grid') return []
  const listed = new Set(s.externalApps.map((a) => appKeyOf(a.projectId, a.appId, a.machine)))
  return s.gridPanels.flatMap((p) =>
    p.kind === 'app' && listed.has(appKeyOf(p.projectId, p.appId, p.machine))
      ? [gridAppViewKey(p.projectId, p.appId, p.machine)]
      : [],
  )
}

/**
 * Whether leaving the app view for this pinned view lands on a screen that shows it in a panel (#203): the view is
 * the one on screen, and the focus lane it goes back to is its project's screen with the app not hidden there.
 */
export function returnsToPanel(
  s: Pick<
    AppState,
    | 'view'
    | 'focusedApp'
    | 'focusedSessionId'
    | 'focusedProjectId'
    | 'projects'
    | 'externalApps'
    | 'projectPanels'
  >,
  key: string,
): boolean {
  if (
    s.view !== 'app' ||
    !s.focusedApp ||
    externalAppKey(s.focusedApp.projectId, s.focusedApp.appId, s.focusedApp.machine) !== key
  )
    return false
  return projectScreenAppKeys({ ...s, view: 'focus' }).includes(key)
}

/**
 * The screen on now, as history records it (#374), or null for one that is not a place to return to (nothing
 * picked yet, the intro). Settings is a layer over the screen under it, and counts as a screen of its own.
 */
export function screenOf(
  s: Pick<
    AppState,
    | 'settingsOpen'
    | 'view'
    | 'focusedApp'
    | 'focusedSessionId'
    | 'focusedProjectId'
    | 'projects'
    | 'overlay'
    | 'viewerPath'
    | 'viewerProjectId'
    | 'viewerSessionId'
  >,
): Screen | null {
  if (s.settingsOpen) return { kind: 'settings' }
  const under = screenUnder(s)
  const o = s.overlay
  if (o?.kind === 'viewer' && s.viewerPath)
    return { kind: 'file', path: s.viewerPath, projectId: s.viewerProjectId ?? null, sessionId: s.viewerSessionId ?? null, under }
  if (o?.kind === 'git') {
    return {
      kind: 'git',
      sub: o.sub ?? 'changes',
      path: o.path ?? null,
      sha: o.sha ?? null,
      staged: o.staged ?? null,
      under,
    }
  }
  return under
}

/** The screen under any layer */
function screenUnder(
  s: Pick<AppState, 'view' | 'focusedApp' | 'focusedSessionId' | 'focusedProjectId' | 'projects'>,
): Screen | null {
  switch (s.view) {
    case 'grid':
      return { kind: 'grid' }
    case 'orchestrator':
      return { kind: 'orchestrator' }
    case 'app':
      return s.focusedApp
        ? {
            kind: 'app',
            projectId: s.focusedApp.projectId,
            appId: s.focusedApp.appId,
            ...(s.focusedApp.machine ? { machine: s.focusedApp.machine } : {}),
          }
        : null
    case 'focus': {
      if (s.focusedSessionId) return { kind: 'session', id: s.focusedSessionId }
      const pid = projectScreenOf(s)
      return pid ? { kind: 'project', id: pid } : null
    }
  }
}

/** Whether going back or forward to this screen would still find it (#374): the session, project or app is still here */
export function screenExists(
  s: Pick<AppState, 'sessions' | 'projects' | 'externalApps'>,
  screen: Screen,
): boolean {
  switch (screen.kind) {
    case 'session':
      return !!s.sessions[screen.id]
    case 'project':
      return !!s.projects[screen.id]
    case 'app':
      return s.externalApps.some((a) => isApp(a, screen.projectId, screen.appId, screen.machine))
    default:
      return true
  }
}
