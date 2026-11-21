import type { ViewCspDomains, ViewPermissions } from './csp.js'

/**
 * A `ui://` resource read result as a view document. The runtime passes MCP `resources/read` through as is; what counts as a view is the spec's
 * (ext-apps 2.0) and this side renders it, so the interpretation lives only here: `contents[0]` has `mimeType: "text/html;profile=mcp-app"`
 * and a body in `text` or a base64 `blob`, with security settings in `_meta.ui.csp` and `_meta.ui.permissions`
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
 * Whether a `mimeType` makes a resource a view, lenient about whitespace and case; the app check (apps/external/check.ts) asks
 * it too, so it never calls a screen broken that this side renders
 */
export function isViewMimeType(mimeType: unknown): boolean {
  return typeof mimeType === 'string' && mimeType.replace(/\s+/g, '').toLowerCase() === VIEW_MIME_TYPE
}

export function viewHtmlOf(item: Pick<Content, 'text' | 'blob'>): string | null {
  if (typeof item.text === 'string') return item.text
  if (typeof item.blob === 'string') return Buffer.from(item.blob, 'base64').toString('utf8')
  return null
}

/**
 * Throws a reason when the resource is not a view; the message is read by the person building the app. The MIME parameter is
 * lenient about whitespace and case, but plain `text/html` is refused: the spec defines the profile as what counts, and
 * rendering any HTML resource would turn a read-only document into a view where scripts run
 */
export function viewDocumentFromResource(result: unknown, uri: string): ViewDocument {
  const contents = (result as { contents?: unknown } | null)?.contents
  if (!Array.isArray(contents) || contents.length === 0) throw new Error(`${uri}: the app returned no content for this view`)
  const item = (contents.find((c: Content) => c?.uri === uri) ?? contents[0]) as Content
  if (!isViewMimeType(item.mimeType)) {
    throw new Error(`${uri}: not an app view (mimeType ${JSON.stringify(item.mimeType ?? null)}, expected ${VIEW_MIME_TYPE})`)
  }
  const html = viewHtmlOf(item)
  if (html === null) throw new Error(`${uri}: the view has neither text nor blob`)
  const ui = item._meta?.ui
  const csp = ui?.csp && typeof ui.csp === 'object' ? (ui.csp as ViewCspDomains) : undefined
  const permissions = ui?.permissions && typeof ui.permissions === 'object' ? (ui.permissions as ViewPermissions) : undefined
  return { html, csp, permissions }
}
