import { MACHINE_ID_RE, appKeyOf, isRecord, type GridPanel, type GridSpan } from '@cc/protocol/client'
import { sanitizeGridSpan } from './span.js'

/**
 * The grid's panels (#288): the one place a stored `GridPanel` becomes a screen key and back. A session's key is its
 * id (a UUID, never containing `:`); an app's is `app:<project id | _user>/<app id>`.
 */

export { USER_APP_SCOPE, appKeyOf, parseAppKey } from '@cc/protocol/client'

export const sessionGridPanel = (sessionId: string): GridPanel => ({ kind: 'session', sessionId })
/** `machine` is kept only for a linked machine's user-folder app (see `appKeyOf`) */
export const appGridPanel = (projectId: string | null, appId: string, machine?: string | null): GridPanel => ({
  kind: 'app',
  projectId,
  appId,
  ...(machine && projectId == null ? { machine } : {}),
})

/** `null` takes the placement's choice away (#306); session panels are always 1 × 1 */
export function withPanelSpan(panels: readonly GridPanel[], key: string, span: GridSpan | null): GridPanel[] {
  return panels.map((p) => {
    if (p.kind !== 'app' || gridPanelKey(p) !== key) return p
    const { span: _old, ...rest } = p
    return span ? { ...rest, span } : rest
  })
}

export function gridPanelKey(p: GridPanel): string {
  return p.kind === 'session' ? p.sessionId : `app:${appKeyOf(p.projectId, p.appId, p.machine)}`
}

export function gridSessionIds(panels: readonly GridPanel[]): string[] {
  return panels.flatMap((p) => (p.kind === 'session' ? [p.sessionId] : []))
}

/**
 * As `visiblePanels`: the stored list is not corrected, since an app that is gone cannot be told from one not yet read,
 * and an app folder put back brings its panel back where it stood.
 */
export function visibleGridPanels(
  panels: readonly GridPanel[],
  sessions: ReadonlySet<string>,
  apps: ReadonlySet<string>,
): GridPanel[] {
  return panels.filter((p) =>
    p.kind === 'session' ? sessions.has(p.sessionId) : apps.has(appKeyOf(p.projectId, p.appId, p.machine)),
  )
}

/** One bad entry costs that entry, never the list; a panel named twice keeps its first place */
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
    if (!isRecord(item)) continue
    const v = item
    if (v.kind === 'session' && typeof v.sessionId === 'string' && v.sessionId)
      put(sessionGridPanel(v.sessionId))
    else if (
      v.kind === 'app' &&
      typeof v.appId === 'string' &&
      v.appId &&
      (v.projectId === null || (typeof v.projectId === 'string' && v.projectId))
    ) {
      const span = sanitizeGridSpan(v.span)
      // A malformed machine is dropped with the panel: read as none, it would be this computer's app of the same id
      const machine = typeof v.machine === 'string' && MACHINE_ID_RE.test(v.machine) ? v.machine : null
      if (v.machine !== undefined && v.machine !== null && machine === null) continue
      put({ ...appGridPanel(v.projectId, v.appId, machine), ...(span ? { span } : {}) })
    }
  }
  return out
}
