import { appPanelId, arrangePanels, sessionPanelId, withHidden, withOrder, type ProjectArrangement } from '@cc/core'
import { APP_MIME, PANEL_MIME, SESSION_MIME, moveTo, projectItemMime } from '../sidebar/reorder.js'

/**
 * The project screen's side of a drag from the sidebar — kept apart from the DOM events, like
 * reorder.ts, so "is this taken, and where does it land" can be checked without a browser.
 *
 * The screen takes a session or app dropped on it the way the grid takes a session (GridView's
 * `dropSession`), with one difference: only **this project's**. The screen is one project, whole,
 * and a panel from another project would make it something else.
 */

/**
 * What the screen does with a drag, from its types alone — during dragover that is all a page may
 * read (GridView).
 *
 *   panel   one of the screen's own panels, being reordered
 *   add     a session or app of this project: shown, or moved, where it is dropped
 *   refuse  a session or app from anywhere else — another project, the orchestrator, a session
 *           with no project. No drop cursor, anywhere on the screen
 *   ignore  anything else (a file, a path, a project row, a panel tab) — another owner's business
 */
export type DragVerdict = 'panel' | 'add' | 'refuse' | 'ignore'

export function dragVerdict(types: readonly string[], projectId: string): DragVerdict {
  if (types.includes(PANEL_MIME)) return 'panel'
  if (!types.includes(SESSION_MIME) && !types.includes(APP_MIME)) return 'ignore'
  return types.includes(projectItemMime(projectId)) ? 'add' : 'refuse'
}

/**
 * The panel a drop from the sidebar stands for, or null when what was dropped is not this
 * project's.
 *
 * Decided again from the data, not from the type that let the drag in: a drop can arrive without
 * the dragover having said yes — one fired by a script, or one that raced the dragover's answer —
 * and the screen must not take another project's then either. An app is matched by its key, which
 * carries its project: two projects can each have an app called `slider`, and the other one's is
 * not this one's.
 */
export function droppedPanelId(
  read: (type: string) => string,
  sessions: readonly { id: string }[],
  apps: readonly { key: string; appId: string }[],
): string | null {
  const sessionId = read(SESSION_MIME)
  if (sessionId) return sessions.some((s) => s.id === sessionId) ? sessionPanelId(sessionId) : null
  const key = read(APP_MIME)
  const app = key ? apps.find((a) => a.key === key) : undefined
  return app ? appPanelId(app.appId) : null
}

/**
 * The arrangement after one of the project's panels was dropped on its screen from the sidebar —
 * before or after the panel `target`, or at the end when `target` is null (the padding, a gap, the
 * empty screen). Null when nothing changes, so nothing is written.
 *
 * The grid's rule, with the screen's hidden set standing in for the grid's list: a hidden panel is
 * shown again where it was dropped; a visible one moves there, and dropped on the padding stays
 * where it is, as a session already on the grid does. An id the project does not have changes
 * nothing — the panels are derived from what the project has, so it could not appear anyway, and
 * writing an order down for it would pin the order of a screen nobody arranged.
 */
export function droppedArrangement(
  present: readonly string[],
  saved: ProjectArrangement | undefined,
  id: string,
  target: string | null,
  before: boolean,
): ProjectArrangement | null {
  if (!present.includes(id)) return null
  const visible = arrangePanels(present, saved)
  if (visible.includes(id)) {
    if (!target) return null
    const order = moveTo(visible, id, target, before)
    return order.every((x, i) => x === visible[i]) ? null : withOrder(present, saved, order)
  }
  // Hidden: shown again (at the end, withHidden's rule), then moved to where it was dropped
  const shown = withHidden(present, saved, id, false)
  return target ? withOrder(present, shown, moveTo(arrangePanels(present, shown), id, target, before)) : shown
}
