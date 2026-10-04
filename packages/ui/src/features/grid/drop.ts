import type { GridPanel } from '@cc/protocol'
import { appGridPanel, gridPanelKey, sessionGridPanel } from '@cc/core'
import { APP_MIME, SESSION_MIME, moveTo } from '../sidebar/reorder.js'

/**
 * The grid's side of a drag (#288) — kept apart from the DOM events, like the project screen's
 * drop.ts, so "is this taken, and where does it land" can be checked without a browser.
 *
 * The grid takes a session or an app, dragged from the sidebar or from one of its own panels. A
 * panel carries what a sidebar row carries — a session panel the session (`SESSION_MIME`), an app
 * panel the app's key (`APP_MIME`) — so one rule reads both, and a panel is told from a row by
 * being the one this grid is dragging. Any project's app is taken, a user-folder app too: the grid
 * is a hand-picked selection across projects, unlike the project screen.
 */

/** Does the grid answer this drag? From its types alone — during dragover that is all a page may read */
export function gridTakes(types: readonly string[]): boolean {
  return types.includes(SESSION_MIME) || types.includes(APP_MIME)
}

/**
 * The panel a drop stands for, or null when it is nothing the grid can show: a session that is not
 * live, or an app the list does not have (`apps` is keyed by `externalAppKey`). Decided from the
 * data, because a drop can arrive without a dragover that said yes (a script, a race) — and the
 * grid never adds an app by itself, nor one it cannot draw.
 */
export function droppedGridPanel(
  read: (type: string) => string,
  sessions: ReadonlySet<string>,
  apps: ReadonlyMap<string, { projectId: string | null; appId: string }>,
): GridPanel | null {
  const sessionId = read(SESSION_MIME)
  if (sessionId) return sessions.has(sessionId) ? sessionGridPanel(sessionId) : null
  const key = read(APP_MIME)
  const app = key ? apps.get(key) : undefined
  return app ? appGridPanel(app.projectId, app.appId) : null
}

/**
 * The list after `panel` was dropped before or after the panel keyed `target`, or on the padding
 * when `target` is null. One already on the grid moves there, and dropped on the padding stays
 * where it is; a new one is placed there, or at the end.
 */
export function droppedGridList(
  panels: readonly GridPanel[],
  panel: GridPanel,
  target: string | null,
  before: boolean,
): GridPanel[] {
  const key = gridPanelKey(panel)
  const all = new Map(panels.map((p) => [gridPanelKey(p), p] as const))
  const keys = [...all.keys()]
  const placed = keys.includes(key)
  if (!placed) all.set(key, panel)
  const withIt = placed ? keys : [...keys, key]
  const order = target ? moveTo(withIt, key, target, before) : withIt
  return order.map((k) => all.get(k)!)
}
