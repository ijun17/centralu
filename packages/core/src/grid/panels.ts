import type { GridPanel, GridSpan } from '@cc/protocol'
import { sanitizeGridSpan } from './span.js'

/**
 * The grid's panels (#288) — sessions and apps in one order.
 *
 * The stored shape is `GridPanel` (protocol): a tagged reference made of the panel's identity
 * alone. What the screen needs on top of that is a **string key** per panel — the drag carries
 * one, the reorder in `layout.ts` and the sidebar's `moveTo` work on lists of strings, and React
 * keys its cells by one. This file is the one place a reference becomes a key and back.
 *
 * A session's key is its id, unchanged. Grid panels were keyed by session id long before apps
 * could stand there, and the test ids, the composer focus and every drag that carries a session
 * already speak in it; a session id never contains `:` (a UUID), so it cannot be mistaken for an
 * app's key, which is `app:<project id | _user>/<app id>`.
 */

/**
 * The scope name of a user-folder app. It matches the host's scope name and the UI's
 * `externalAppKey`, and never collides with a project id (a UUID).
 */
export const USER_APP_SCOPE = '_user'

/** One app as a single string: `<project id | _user>/<app id>` — the UI's `externalAppKey` */
export function appKeyOf(projectId: string | null | undefined, appId: string): string {
  return `${projectId ?? USER_APP_SCOPE}/${appId}`
}

/**
 * The (project, app) pair an app key stands for, or null for a string that is not one. Neither a
 * project id nor an app id can contain `/`, so the first one splits it.
 */
export function parseAppKey(key: string): { projectId: string | null; appId: string } | null {
  const at = key.indexOf('/')
  if (at <= 0 || at === key.length - 1) return null
  const scope = key.slice(0, at)
  return { projectId: scope === USER_APP_SCOPE ? null : scope, appId: key.slice(at + 1) }
}

export const sessionGridPanel = (sessionId: string): GridPanel => ({ kind: 'session', sessionId })
export const appGridPanel = (projectId: string | null, appId: string): GridPanel => ({
  kind: 'app',
  projectId,
  appId,
})

/**
 * The list with the app panel keyed `key` given this span for its placement (#306), or its choice taken away
 * (`null`: the panel falls back to the person's setting for the app, then the app's recommendation). Any other panel,
 * and a session's, is left as it is: a session panel is always 1 × 1.
 */
export function withPanelSpan(panels: readonly GridPanel[], key: string, span: GridSpan | null): GridPanel[] {
  return panels.map((p) => {
    if (p.kind !== 'app' || gridPanelKey(p) !== key) return p
    const { span: _old, ...rest } = p
    return span ? { ...rest, span } : rest
  })
}

/** The panel's key on the screen — see the file comment */
export function gridPanelKey(p: GridPanel): string {
  return p.kind === 'session' ? p.sessionId : `app:${appKeyOf(p.projectId, p.appId)}`
}

/** The sessions on the grid, in order — what "is this session on screen" and warming up at launch ask about */
export function gridSessionIds(panels: readonly GridPanel[]): string[] {
  return panels.flatMap((p) => (p.kind === 'session' ? [p.sessionId] : []))
}

/**
 * The panels to draw: those whose session or app exists right now, in order.
 *
 * `sessions` is the set of live session ids, `apps` the set of app keys (`appKeyOf`) in the app
 * list. Filtered once before the panels are seated, as `visiblePanels` does for sessions: the
 * stored list is not corrected, because nothing here can tell an app that is gone from one the
 * list has not been read for yet — and an app folder put back, or a project's apps read a moment
 * later, brings its panel back where it stood.
 */
export function visibleGridPanels(
  panels: readonly GridPanel[],
  sessions: ReadonlySet<string>,
  apps: ReadonlySet<string>,
): GridPanel[] {
  return panels.filter((p) =>
    p.kind === 'session' ? sessions.has(p.sessionId) : apps.has(appKeyOf(p.projectId, p.appId)),
  )
}

/**
 * A grid list read from somewhere untyped — an older host, or the client's own storage once the
 * grid moves there (#82).
 *
 * A bare string is a session id: that is what the grid stored before apps could stand on it, so a
 * list written by an older build keeps every panel. Anything else that is not a well-formed
 * reference is dropped rather than trusted, and a panel named twice keeps its first place — one
 * bad entry costs that entry, never the list.
 */
export function sanitizeGridPanels(raw: unknown): GridPanel[] {
  if (!Array.isArray(raw)) return []
  const out: GridPanel[] = []
  const seen = new Set<string>()
  const put = (p: GridPanel) => {
    const key = gridPanelKey(p)
    if (seen.has(key)) return
    seen.add(key)
    out.push(p)
  }
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item) put(sessionGridPanel(item))
      continue
    }
    if (!item || typeof item !== 'object') continue
    const v = item as { kind?: unknown; sessionId?: unknown; projectId?: unknown; appId?: unknown; span?: unknown }
    if (v.kind === 'session' && typeof v.sessionId === 'string' && v.sessionId)
      put(sessionGridPanel(v.sessionId))
    else if (
      v.kind === 'app' &&
      typeof v.appId === 'string' &&
      v.appId &&
      (v.projectId === null || (typeof v.projectId === 'string' && v.projectId))
    ) {
      // The span chosen for this placement (#306) comes along when it is one; anything else reads as none chosen
      const span = sanitizeGridSpan(v.span)
      put({ ...appGridPanel(v.projectId as string | null, v.appId), ...(span ? { span } : {}) })
    }
  }
  return out
}
