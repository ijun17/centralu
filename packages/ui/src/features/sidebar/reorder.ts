/**
 * The pure part of drag-to-reorder.
 *
 * Kept apart from the DOM events, "what order results from dropping it here" can be verified
 * without a browser — this calculation is more prone to getting wrong than the dragging itself.
 */

/** What is being dragged. Different kinds must not be dropped into each other's place. */
export const PROJECT_MIME = 'application/x-cc-project'
export const SESSION_MIME = 'application/x-cc-session'
/**
 * A panel on the project screen (#203) — a session's or an app's. Its own type, so a sidebar row
 * dragged over the project screen is not taken for one of its panels: a panel is reordered, a row
 * is shown or moved (project/drop.ts), and the two must not be confused mid-drag.
 */
export const PANEL_MIME = 'application/x-cc-panel'
/**
 * A project's app, dragged from its sidebar row; the data is its key (`externalAppKey`). Its own
 * type rather than the session's, so nothing that takes a session takes an app — the grid shows
 * sessions only.
 */
export const APP_MIME = 'application/x-cc-app'

/**
 * Which project a dragged session or app belongs to, carried in the **type**, not the data.
 *
 * While a drag is over a page, the page can read the drag's types but none of its data (browser
 * security, see GridView). So the project screen cannot ask a dragged row which project it is from
 * until the drop — too late to show that it will not take it. With the project in the type, the
 * screen refuses another project's session or app while it is still being dragged, with no drop
 * cursor. The orchestrator's row belongs to no project and carries none, so it is refused too.
 *
 * The browser lowercases types. Project ids are UUIDs, lowercase already; the encoding only keeps
 * an unusual id from producing an odd type, and the drop checks the data anyway (project/drop.ts).
 */
export function projectItemMime(projectId: string): string {
  return `application/x-cc-of-project.${encodeURIComponent(projectId)}`.toLowerCase()
}

/**
 * The new order with `dragged` moved to before or after `target`.
 *
 * Dropping it on itself returns the original order unchanged — as if nothing happened. An
 * unknown id is also left unchanged: the list may have changed in the meantime, and doing
 * nothing is better than forcing it in regardless.
 */
export function moveTo(ids: readonly string[], dragged: string, target: string, before: boolean): string[] {
  if (dragged === target) return [...ids]
  if (!ids.includes(dragged) || !ids.includes(target)) return [...ids]

  const rest = ids.filter((id) => id !== dragged)
  const at = rest.indexOf(target)
  rest.splice(before ? at : at + 1, 0, dragged)
  return rest
}

/**
 * If the cursor is in the top half of the element, drop it before that element.
 *
 * Placing the boundary at the middle gives "above this row" / "below this row" a half each, so
 * the hand can predict which side it will land on.
 */
export function dropsBefore(rect: { top: number; height: number }, clientY: number): boolean {
  return clientY < rect.top + rect.height / 2
}
