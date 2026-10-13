/**
 * Project screens contain only panels the person adds, in their chosen order (#604).
 * Availability filters drawing: a trashed session cannot appear, and new sessions never
 * join it automatically. Session and app ids carry their kind to avoid collisions.
 * Legacy order/hidden fields remain readable by the previous build during an update.
 */
export type ProjectArrangement = {
  /** Explicit ordered membership. Absent only in snapshots from the previous build. */
  panels?: string[]
  /** Compatibility projection for the previous build; remove in a later release. */
  order: string[]
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

/** Unavailable ids are skipped, not erased: an app catalog can be temporarily incomplete. */
export function arrangePanels(present: readonly string[], saved: ProjectArrangement | undefined): string[] {
  const here = new Set(present)
  return [...new Set(saved?.panels ?? [])].filter((id) => here.has(id))
}

/** Freeze a legacy arrangement once the initial session and app catalogs have loaded. */
export function migrateArrangement(present: readonly string[], saved: ProjectArrangement): ProjectArrangement {
  if (saved.panels !== undefined) return saved
  const hidden = new Set(saved.hidden)
  // Startup discovery can fail or omit offline machines: absence is not evidence of deletion.
  // Any saved entry is arranged, even empty arrays left by showing a lone panel again.
  const panels = [...new Set([...saved.order, ...present])].filter((id) => !hidden.has(id))
  return { ...saved, panels }
}

/** Preserve legacy exclusions too: an older window may read the snapshot after discovery recovers. */
function writeArrangement(
  present: readonly string[],
  saved: ProjectArrangement | undefined,
  panels: string[],
): ProjectArrangement {
  const shown = new Set(panels)
  const hidden = [...new Set([...(saved?.hidden ?? []), ...present, ...(saved?.panels ?? [])])]
    .filter((id) => !shown.has(id))
  return { panels, order: panels, hidden }
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
  const panels = previous.map((id) => here.has(id) ? ordered[at++]! : id)
  panels.push(...ordered.slice(at))
  return writeArrangement(present, saved, panels)
}

/** Add at the end or remove only this id, even if other panels are temporarily unavailable. */
export function withPanel(
  present: readonly string[],
  saved: ProjectArrangement | undefined,
  id: string,
  add: boolean,
): ProjectArrangement {
  const previous = [...new Set(saved?.panels ?? [])]
  if (add && !present.includes(id)) return writeArrangement(present, saved, previous)
  const panels = previous.filter((x) => x !== id)
  if (add) panels.push(id)
  return writeArrangement(present, saved, panels)
}

/** Workspace snapshots are untyped JSON; a malformed list must not break restoration. */
export function sanitizeArrangements(raw: unknown): Record<string, ProjectArrangement> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const out: Record<string, ProjectArrangement> = {}
  for (const [projectId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const v = value as { panels?: unknown; order?: unknown; hidden?: unknown }
    out[projectId] = {
      order: strings(v.order), hidden: strings(v.hidden),
      ...(Object.hasOwn(v, 'panels') ? { panels: strings(v.panels) } : {}),
    }
  }
  return out
}
