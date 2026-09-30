import type { ViewCspDomains, ViewPermissions } from './csp.js'

/**
 * `ui://` resource read result → view document (M4 B-3).
 *
 * The app runtime passes through the MCP `resources/read` answer **as is**. What counts as a
 * view is defined by the spec (ext-apps 2.0), and this side, which renders the view, is the one
 * that knows that spec. So the interpretation lives in this one place. If the runtime also knew
 * this, there would be two places reading the spec.
 *
 * The spec's shape: `contents[0]` has `mimeType: "text/html;profile=mcp-app"`, and the body is
 * either `text` or a base64 `blob`. Security settings live in that entry's `_meta.ui.csp` and
 * `_meta.ui.permissions`.
 */

export const VIEW_MIME_TYPE = 'text/html;profile=mcp-app'

export type ViewDocument = {
  html: string
  csp?: ViewCspDomains
  permissions?: ViewPermissions
}

type Content = {
  uri?: unknown
  mimeType?: unknown
  text?: unknown
  blob?: unknown
  _meta?: { ui?: { csp?: unknown; permissions?: unknown } }
}

/**
 * Throws with a reason when the resource is not a view. That message is read by a person — the
 * one building the app.
 *
 * The MIME parameter is read leniently about whitespace and case (`text/html; profile=mcp-app`).
 * But plain `text/html` without `profile=mcp-app` is not accepted. The spec defines that profile,
 * specifically, as what counts as a view. Rendering any HTML resource as a view would turn a
 * document the app meant only for reading into a view where scripts run.
 */
export function viewDocumentFromResource(result: unknown, uri: string): ViewDocument {
  const contents = (result as { contents?: unknown } | null)?.contents
  if (!Array.isArray(contents) || contents.length === 0) throw new Error(`${uri}: the app returned no content for this view`)
  const item = (contents.find((c: Content) => c?.uri === uri) ?? contents[0]) as Content
  const mime = typeof item.mimeType === 'string' ? item.mimeType.replace(/\s+/g, '').toLowerCase() : ''
  if (mime !== VIEW_MIME_TYPE) {
    throw new Error(`${uri}: not an app view (mimeType ${JSON.stringify(item.mimeType ?? null)}, expected ${VIEW_MIME_TYPE})`)
  }
  let html: string
  if (typeof item.text === 'string') html = item.text
  else if (typeof item.blob === 'string') html = Buffer.from(item.blob, 'base64').toString('utf8')
  else throw new Error(`${uri}: the view has neither text nor blob`)
  const ui = item._meta?.ui
  const csp = ui?.csp && typeof ui.csp === 'object' ? (ui.csp as ViewCspDomains) : undefined
  const permissions = ui?.permissions && typeof ui.permissions === 'object' ? (ui.permissions as ViewPermissions) : undefined
  return { html, csp, permissions }
}
