import type { Tool } from '@modelcontextprotocol/client'

/**
 * A tool's audience (M4 A-4, MCP Apps `_meta.ui.visibility`).
 *
 *   model  listed in the agent's tool list — called by the session, and by other apps (D-2)
 *   app    called by that app's own view
 *
 * When absent, it is both (the spec's default). Enforcing it is **the host's job** — a server has
 * no way to tell who called it (ext-apps #746). So the check happens in the one place every call
 * passes through (`ExternalApps.call`).
 */
export type Audience = 'model' | 'app'

export const DEFAULT_VISIBILITY: readonly Audience[] = ['model', 'app']

/**
 * A single tool's audience. **When the field is present but malformed, this rejects it** — reading
 * it as if it were absent and falling back to the default (both) would open a tool to the agent
 * that its author meant to restrict to `["app"]`. It is better to let the malformed one stay closed.
 */
export function visibilityOf(tool: Tool): { ok: true; visibility: Audience[] } | { ok: false; error: string } {
  const ui = (tool._meta as { ui?: unknown } | undefined)?.ui
  if (ui === undefined) return { ok: true, visibility: [...DEFAULT_VISIBILITY] }
  if (ui === null || typeof ui !== 'object') return { ok: false, error: `${tool.name}: _meta.ui must be an object` }
  const v = (ui as { visibility?: unknown }).visibility
  if (v === undefined) return { ok: true, visibility: [...DEFAULT_VISIBILITY] }
  if (!Array.isArray(v) || !v.every((x) => x === 'model' || x === 'app')) {
    return { ok: false, error: `${tool.name}: _meta.ui.visibility must be a list of "model" and "app" (got ${JSON.stringify(v)})` }
  }
  return { ok: true, visibility: [...new Set(v as Audience[])] }
}

/**
 * The view a tool declares (MCP Apps `_meta.ui.resourceUri`, the old shape `_meta["ui/resourceUri"]`)
 * — B-2.
 *
 * When the new shape is present, it wins (same order as ext-apps's `getToolUiResourceUri`). A value
 * that is not `ui://` is not a view, it is a **malformed declaration**. Reading it as if it were
 * absent would leave the author with no way to find out why their view does not show up.
 */
export function resourceUriOf(tool: Tool): { uri: string | null; error: string | null } {
  const meta = tool._meta as { ui?: { resourceUri?: unknown }; 'ui/resourceUri'?: unknown } | undefined
  const raw = meta?.ui?.resourceUri ?? meta?.['ui/resourceUri']
  if (raw === undefined) return { uri: null, error: null }
  if (typeof raw !== 'string' || !raw.startsWith('ui://')) {
    return { uri: null, error: `${tool.name}: _meta.ui.resourceUri must be a ui:// URI (got ${JSON.stringify(raw)})` }
  }
  return { uri: raw, error: null }
}
