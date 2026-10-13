/**
 * Project screens contain only panels the person adds, in their chosen order (#604).
 * Availability filters that list: a trashed session cannot appear, and new sessions never
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

/** Write explicit membership and its legacy projection, keeping only available ids. */
export function withOrder(
  present: readonly string[],
  _saved: ProjectArrangement | undefined,
  order: readonly string[],
): ProjectArrangement {
  const here = new Set(present)
  const panels = [...new Set(order)].filter((id) => here.has(id))
  const shown = new Set(panels)
  return { panels, order: panels, hidden: [...new Set(present)].filter((id) => !shown.has(id)) }
}

/** Add at the end or remove, as on the grid; the underlying session or app is untouched. */
export function withPanel(
  present: readonly string[],
  saved: ProjectArrangement | undefined,
  id: string,
  add: boolean,
): ProjectArrangement {
  const panels = arrangePanels(present, saved).filter((x) => x !== id)
  if (add && present.includes(id)) panels.push(id)
  return withOrder(present, saved, panels)
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
