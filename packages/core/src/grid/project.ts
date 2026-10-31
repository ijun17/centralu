/**
 * Project screens contain only panels the person adds, in their chosen order (#604).
 * Availability filters drawing: a trashed session cannot appear, and new sessions never
 * join it automatically. Session and app ids carry their kind to avoid collisions.
 */
import { isRecord } from '@cc/protocol/client'

export type ProjectArrangement = {
  /** Explicit ordered membership */
  panels: string[]
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

/** Unavailable ids are skipped, not erased: an app catalog can be temporarily incomplete. */
export function arrangePanels(present: readonly string[], saved: ProjectArrangement | undefined): string[] {
  const here = new Set(present)
  return [...new Set(saved?.panels ?? [])].filter((id) => here.has(id))
}

/** Reorder available slots while keeping unavailable ids in their saved slots. A reorder never drops saved membership. */
export function withOrder(
  present: readonly string[],
  saved: ProjectArrangement | undefined,
  order: readonly string[],
): ProjectArrangement {
  const here = new Set(present)
  const previous = [...new Set(saved?.panels ?? [])]
  // Retain selected available ids omitted by an edit too; a reorder is not a removal.
  const ordered = [...new Set([...order, ...previous])].filter((id) => here.has(id))
  let at = 0
  const panels = previous.map((id) => (here.has(id) ? (ordered[at++] ?? id) : id))
  panels.push(...ordered.slice(at))
  return { panels }
}

/** Add at the end or remove only this id, even if other panels are temporarily unavailable. */
export function withPanel(
  present: readonly string[],
  saved: ProjectArrangement | undefined,
  id: string,
  add: boolean,
): ProjectArrangement {
  const previous = [...new Set(saved?.panels ?? [])]
  if (add && !present.includes(id)) return { panels: previous }
  const panels = previous.filter((x) => x !== id)
  if (add) panels.push(id)
  return { panels }
}

/** Workspace snapshots are untyped JSON; a malformed list must not break restoration. */
export function sanitizeArrangements(raw: unknown): Record<string, ProjectArrangement> {
  if (!isRecord(raw)) return {}
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const out: Record<string, ProjectArrangement> = {}
  for (const [projectId, value] of Object.entries(raw)) {
    if (isRecord(value)) out[projectId] = { panels: strings(value.panels) }
  }
  return out
}
