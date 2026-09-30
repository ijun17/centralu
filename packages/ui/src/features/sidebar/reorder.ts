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
 * dragged over the project screen is not taken for one of its panels: that screen shows what the
 * project has, and nothing is added to it by hand.
 */
export const PANEL_MIME = 'application/x-cc-panel'

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
