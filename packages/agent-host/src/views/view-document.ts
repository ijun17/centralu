import type { ViewCspDomains, ViewPermissions } from './csp.js'

/**
 * `ui://` 리소스 읽기 결과 → 화면 문서 (M4 B-3).
 *
 * 앱 런타임은 MCP `resources/read`의 답을 **그대로** 넘긴다. 무엇이 화면인지는 규격(ext-apps
 * 2.0)이 정하고, 그 규격을 아는 것은 화면을 띄우는 이쪽이다. 그래서 해석을 여기 한 곳에 둔다.
 * 런타임이 이것까지 알면 규격을 읽는 자리가 둘이 된다.
 *
 * 규격의 모양: `contents[0]`이 `mimeType: "text/html;profile=mcp-app"`이고 본문은 `text`
 * 또는 base64 `blob`이다. 보안 설정은 그 항목의 `_meta.ui.csp`·`_meta.ui.permissions`에 있다.
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
 * 화면이 아니면 이유와 함께 던진다. 그 문장은 사람(앱을 만드는 쪽)이 읽는다.
 *
 * MIME의 매개변수는 공백과 대소문자를 느슨하게 본다(`text/html; profile=mcp-app`).
 * 그러나 `profile=mcp-app`이 없는 그냥 `text/html`은 받지 않는다. 규격이 화면으로 정한 것은
 * 그 프로필이다. 아무 HTML 리소스나 화면으로 띄우면, 앱이 읽기용으로 내놓은 문서가 스크립트가
 * 도는 화면이 된다.
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
