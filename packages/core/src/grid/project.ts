/**
 * The project screen's arrangement (#203).
 *
 * Clicking a project's name shows that project's sessions and apps as panels, laid out the
 * way the grid lays out sessions. Unlike the grid, nobody has to put a panel there: **everything
 * the project has appears on its own**, because the screen is "this project", not a selection
 * from it. A grid you fill by hand is a way of watching some sessions; a project screen that
 * waited to be filled would be empty the first time it is opened, which is the one time it has
 * to explain itself. (A row dropped there from the sidebar only shows or moves one of the
 * project's own panels — the UI's project/drop.ts.)
 *
 * So what is remembered is not the list of panels but the person's hand on it: the order they
 * dragged panels into, and the panels they hid. Everything else is derived from what exists,
 * which is also why a session in the trash (#204) can never appear here — it is not in the
 * session list, so there is nothing to derive it from.
 *
 * Panel ids carry their kind (`session:<id>`, `app:<appId>`), because a session and an app are
 * arranged in one order and nothing stops their ids from colliding.
 */

/** What the person did to one project's screen. Absent means they have not touched it */
export type ProjectArrangement = {
  /** The order they last dragged the panels into. Panels not in it follow, in the given order */
  order: string[]
  /** Panels they took off the screen. The session or app itself is untouched */
  hidden: string[]
}

export const sessionPanelId = (sessionId: string): string => `session:${sessionId}`
export const appPanelId = (appId: string): string => `app:${appId}`

/** The panel's kind and the id inside it, or null for an id this build does not know */
export function parsePanelId(id: string): { kind: 'session' | 'app'; id: string } | null {
  const at = id.indexOf(':')
  const kind = id.slice(0, at)
  if (at <= 0 || (kind !== 'session' && kind !== 'app')) return null
  return { kind, id: id.slice(at + 1) }
}

/**
 * The panels the screen shows, in order.
 *
 * `present` is everything the project has right now, in its natural order (the sidebar's: its
 * sessions, then its apps). Placed panels come first in the order they were dragged into; the
 * rest follow in the natural order, so a session created after the last drag lands at the end
 * rather than pushing into the middle of an arrangement someone made. Hidden panels are left out.
 *
 * Ids in the arrangement that no longer exist are skipped here, not deleted — this cannot tell
 * "gone" from "not listed yet". They are dropped the next time the arrangement is written.
 */
export function arrangePanels(present: readonly string[], saved: ProjectArrangement | undefined): string[] {
  const here = new Set(present)
  const hidden = new Set(saved?.hidden ?? [])
  const placed = [...new Set(saved?.order ?? [])].filter((id) => here.has(id) && !hidden.has(id))
  const seen = new Set(placed)
  return [...placed, ...present.filter((id) => !seen.has(id) && !hidden.has(id))]
}

/**
 * The arrangement after the panels were dragged into `order` (what the screen now shows).
 * Written whole, and only with ids that exist — see `arrangePanels`.
 */
export function withOrder(
  present: readonly string[],
  saved: ProjectArrangement | undefined,
  order: readonly string[],
): ProjectArrangement {
  const here = new Set(present)
  return { order: [...new Set(order)].filter((id) => here.has(id)), hidden: (saved?.hidden ?? []).filter((id) => here.has(id)) }
}

/**
 * The arrangement after one panel was hidden or shown again.
 *
 * A panel shown again comes back **at the end**, like a new one, rather than at the place it
 * held before it was hidden: that place is a memory of a screen that has changed since, and
 * a panel reappearing in the middle moves every panel after it. So showing one first writes
 * down the order the screen shows now — otherwise, on a screen nobody has dragged, it would
 * fall back into its natural place among the others.
 */
export function withHidden(
  present: readonly string[],
  saved: ProjectArrangement | undefined,
  id: string,
  hide: boolean,
): ProjectArrangement {
  const here = new Set(present)
  const hidden = (saved?.hidden ?? []).filter((x) => x !== id && here.has(x))
  if (!hide) return { order: arrangePanels(present, saved).filter((x) => x !== id), hidden }
  const order = (saved?.order ?? []).filter((x) => here.has(x) && x !== id)
  return { order, hidden: here.has(id) ? [...hidden, id] : hidden }
}

/**
 * A stored arrangement read back from the workspace snapshot, which is untyped JSON written
 * by whatever build ran last. Anything that is not a list of strings is dropped rather than
 * trusted: a bad entry costs one project its order, a thrown error would cost the restore.
 */
export function sanitizeArrangements(raw: unknown): Record<string, ProjectArrangement> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const out: Record<string, ProjectArrangement> = {}
  for (const [projectId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const v = value as { order?: unknown; hidden?: unknown }
    out[projectId] = { order: strings(v.order), hidden: strings(v.hidden) }
  }
  return out
}
