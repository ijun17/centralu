import { appPanelId, arrangePanels, sessionPanelId, withPanel, withOrder, type ProjectArrangement } from '@cc/core'
import { APP_MIME, PANEL_MIME, SESSION_MIME, moveTo, projectItemMime } from '../sidebar/reorder.js'

/**
 * The project screen's side of a sidebar drag, apart from DOM events (like reorder.ts) so it is testable without a
 * browser. Taken as the grid's `dropSession` takes a session, but only this project's: the screen is one project.
 */

/**
 * What the screen does with a drag, from its types alone (all a page may read in dragover; GridView). `refuse`: a
 * session or app of another project, the Assistant or no project, with no drop cursor anywhere on the screen.
 * `ignore`: a file, a path, a project row or a panel tab, another owner's business.
 */
export type DragVerdict = 'panel' | 'add' | 'refuse' | 'ignore'

export function dragVerdict(types: readonly string[], projectId: string): DragVerdict {
  if (types.includes(PANEL_MIME)) return 'panel'
  if (!types.includes(SESSION_MIME) && !types.includes(APP_MIME)) return 'ignore'
  return types.includes(projectItemMime(projectId)) ? 'add' : 'refuse'
}

/**
 * The panel a sidebar drop stands for, or null when it is not this project's. Decided again from the data: a drop can
 * come without the dragover's yes (fired by a script, or racing its answer). An app matches by its key, which carries
 * its project: two projects can each have an app called `slider`.
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
 * The arrangement after a sidebar drop before or after `target`, or at the end when it is null (padding, a gap, the
 * empty screen); null when nothing changes. The grid's rule: an absent panel is added where it lands, a visible one
 * moves there, or stays when dropped on padding.
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
  const shown = withPanel(present, saved, id, true)
  return target ? withOrder(present, shown, moveTo(arrangePanels(present, shown), id, target, before)) : shown
}
