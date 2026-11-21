import { createHash } from 'node:crypto'

/**
 * The sandbox proxy page: the outer of an app view's two nested iframes (the origin of the host's port); the inner is the app's HTML.
 * It builds the inner frame and relays messages between the parent and the app's view, reading the theme side from what the parent sends
 * (`DEFAULT_COLOR_SCHEME`) and never changing a message. The rules, as the spike settled them (docs/security-boundaries/app-views.md):
 * `sandbox` is applied before the document is inserted, as an opaque `srcdoc` (never `document.write`, which let a view inherit the proxy's
 * origin and reach other proxies' addresses and storage, measured); a frame is told by `event.source`, not origin (every opaque origin is
 * `"null"`), and an opaque inner frame reporting another origin means the document was swapped; the parent's origin is embedded after the
 * allow-list check, not read from `document.referrer` (empty under `tauri://`). The view's HTML arrives as JSON in this response, so the
 * policy and document are decided in one place and the parent never touches it. AppFrame wires the bridge before loading this page, so
 * the view's first `ui/initialize` reaches a listener and no `sandbox-proxy-ready` is needed
 */

export type ProxyPageConfig =
  | { mode: 'opaque'; hostOrigin: string; sandbox: string; allow: string; html: string }
  | { mode: 'app'; hostOrigin: string; sandbox: string; allow: string; src: string; appOrigin: string }

/**
 * The proxy script, a string because it runs inside the proxy page, not the host; under the per-app origin method the CSP
 * allows only its hash (`PROXY_SCRIPT_HASH`)
 */
export const PROXY_SCRIPT = `(function () {
  'use strict'
  var cfg = JSON.parse(document.getElementById('cc-view-config').textContent)
  var HOST = cfg.hostOrigin
  var root = document.documentElement
  function scheme(theme) {
    if (theme === 'light' || theme === 'dark') root.style.colorScheme = theme
  }
  var asked = /(?:^#|&)color-scheme=(light|dark)(?:&|$)/.exec(location.hash)
  if (asked) scheme(asked[1])
  function follow(d) {
    if (!d || typeof d !== 'object') return
    var ctx = d.method === 'ui/notifications/host-context-changed' ? d.params : d.result && d.result.hostContext
    if (ctx && typeof ctx === 'object') scheme(ctx.theme)
  }
  var inner = document.createElement('iframe')
  inner.setAttribute('sandbox', cfg.sandbox)
  if (cfg.allow) inner.setAttribute('allow', cfg.allow)
  inner.setAttribute('title', 'app view')
  document.body.appendChild(inner)
  var toInner = cfg.mode === 'app' ? cfg.appOrigin : '*'
  var innerOrigin = cfg.mode === 'app' ? cfg.appOrigin : 'null'
  window.addEventListener('message', function (e) {
    if (e.source === window.parent) {
      if (e.origin !== HOST) return
      follow(e.data)
      if (inner.contentWindow) inner.contentWindow.postMessage(e.data, toInner)
      return
    }
    if (e.source === inner.contentWindow && e.source !== null) {
      if (e.origin !== innerOrigin) return
      window.parent.postMessage(e.data, HOST)
    }
  })
  if (cfg.mode === 'app') inner.src = cfg.src
  else inner.srcdoc = cfg.html
})()`

export const PROXY_SCRIPT_HASH = `sha256-${createHash('sha256').update(PROXY_SCRIPT).digest('base64')}`

/** JSON for a `<script type="application/json">` block, with `<` escaped so the app's HTML cannot close it with `</script>` */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * The proxy page's color scheme, matching the host view's visible theme side (#312). When a frame element's scheme differs from the
 * document inside it, Chromium (and Playwright's WebKit) paints that document opaque (CSS Color Adjustment), so a proxy that stated no scheme
 * laid a white canvas over a dark view. The same scheme keeps it transparent, and an app that states its scheme from the theme it was given
 * sits transparently too; one that states nothing counts as light and gets the light canvas under it on a dark theme. WKWebView keeps child
 * frames transparent, so under Tauri this mostly affects form controls and scrollbars. The script follows the theme without a new serve: the
 * address fragment (`#color-scheme=`, set before first paint), then every host context the bridge passes (`ui/initialize`,
 * `host-context-changed`); only `light` or `dark` count. The default covers an address with no fragment
 */
const DEFAULT_COLOR_SCHEME = 'dark'

export function proxyPageHtml(config: ProxyPageConfig): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>app view</title>',
    `<meta name="color-scheme" content="${DEFAULT_COLOR_SCHEME}">`,
    '<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style>',
    '</head><body>',
    `<script type="application/json" id="cc-view-config">${embedJson(config)}</script>`,
    `<script>${PROXY_SCRIPT}</script>`,
    '</body></html>',
  ].join('')
}
