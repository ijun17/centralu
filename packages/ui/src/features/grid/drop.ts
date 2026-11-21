import type { GridPanel } from '@cc/protocol/client'
import { appGridPanel, gridPanelKey, sessionGridPanel } from '@cc/core'
import { APP_MIME, SESSION_MIME, moveTo } from '../sidebar/reorder.js'

// The grid's side of a drag (#288), apart from the DOM events so it is testable without a browser. A panel carries what
// its sidebar row carries (`SESSION_MIME`, `APP_MIME`), so one rule reads both; a panel is told from a row by being the
// one this grid drags. Any project's app is taken, a user-folder one too.

/** Does the grid answer this drag? From its types alone — during dragover that is all a page may read */
export function gridTakes(types: readonly string[]): boolean {
  return types.includes(SESSION_MIME) || types.includes(APP_MIME)
}

/**
 * The panel a drop stands for, or null for a session that is not live or an app the list lacks (`apps` is keyed by
 * `appKeyOf`). Read from the data: a drop can come without a dragover that said yes (a script, a race).
 */
export function droppedGridPanel(
  read: (type: string) => string,
  sessions: ReadonlySet<string>,
  apps: ReadonlyMap<string, { projectId: string | null; appId: string; info?: { machine?: string | null } }>,
): GridPanel | null {
  const sessionId = read(SESSION_MIME)
  if (sessionId) return sessions.has(sessionId) ? sessionGridPanel(sessionId) : null
  const key = read(APP_MIME)
  const app = key ? apps.get(key) : undefined
  // A linked machine's user-folder app keeps its machine (#82); `appGridPanel` drops it for a project app
  return app ? appGridPanel(app.projectId, app.appId, app.info?.machine) : null
}

/**
 * The list after `panel` was dropped before or after the panel keyed `target`, or on the padding (`target` null): one
 * already there moves, or stays on the padding; a new one goes there, or at the end.
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
