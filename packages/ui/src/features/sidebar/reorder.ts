// The pure part of drag-to-reorder, testable without a browser.

/** What is being dragged: one kind is never dropped into another's place */
export const PROJECT_MIME = 'application/x-cc-project'
export const SESSION_MIME = 'application/x-cc-session'
/** A project-screen panel (#203): its own type, as a panel is reordered but a sidebar row is shown or moved (project/drop.ts) */
export const PANEL_MIME = 'application/x-cc-panel'
/** An app (data: `appKeyOf`); its own type, so only what says so takes it, as the grid and project screen do (#288, #203) */
export const APP_MIME = 'application/x-cc-app'

/**
 * A dragged row's project, in the type: during a drag the browser exposes types but not data, so the project screen
 * can refuse another project's row (and the Assistant's, which has none) before the drop. The browser lowercases
 * types; ids are lowercase UUIDs, and the drop checks the data anyway (project/drop.ts).
 */
export function projectItemMime(projectId: string): string {
  return `application/x-cc-of-project.${encodeURIComponent(projectId)}`.toLowerCase()
}

/** `dragged` moved before or after `target`. An unknown id leaves the order as is: the list may have changed meanwhile */
export function moveTo(ids: readonly string[], dragged: string, target: string, before: boolean): string[] {
  if (dragged === target) return [...ids]
  if (!ids.includes(dragged) || !ids.includes(target)) return [...ids]

  const rest = ids.filter((id) => id !== dragged)
  const at = rest.indexOf(target)
  rest.splice(before ? at : at + 1, 0, dragged)
  return rest
}

export function dropsBefore(rect: { top: number; height: number }, clientY: number): boolean {
  return clientY < rect.top + rect.height / 2
}

export function dropsLeft(rect: { left: number; width: number }, clientX: number): boolean {
  return dropsBefore({ top: rect.left, height: rect.width }, clientX)
}
