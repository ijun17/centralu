import { createHash } from 'node:crypto'

/**
 * The sandbox proxy page (M4 B-3, spike S-1 `harness/static/sandbox.js`).
 *
 * An app view runs inside two nested iframes. The outer one is this page (the origin of the host's
 * port), and the inner one is the app's HTML. This page does two things: builds the inner frame
 * according to the rules, and shuttles messages between our view (the parent) and the app's view
 * (the child). While shuttling, it reads the theme's side from what the parent sends, to keep its
 * own color scheme matching (`DEFAULT_COLOR_SCHEME` below); it never changes a message.
 *
 * It follows the rules the spike settled on exactly.
 *   - `sandbox` is applied **before** the document is inserted. The opaque method is `srcdoc`.
 *     `document.write` is not used. In the reference host's version of that method, the view
 *     inherited the proxy's own origin, and it ended up reaching other proxies' addresses
 *     (including secret paths) and their storage (measured).
 *   - A frame is distinguished by `event.source`, not by origin. Every opaque origin is `"null"`.
 *     Origin is checked a second time afterward. If the inner frame is opaque but reports an
 *     origin other than `"null"`, something has swapped out the inner document.
 *   - The parent's origin is not read via `document.referrer` — it is empty under `tauri://`. The
 *     host embeds the value it already checked against the allow list directly into the page.
 *
 * The view's HTML arrives as JSON inside this same response. The spec's reference flow has the
 * parent send the HTML via `postMessage` (`sandbox-resource-ready`). Here, the host reads the
 * document itself and embeds it in the same response as the CSP. That way the policy and the
 * document are decided in one place, and the parent view never touches the app's HTML.
 *
 * Message ordering: the parent (AppFrame) wires up the bridge **before** loading this page. An
 * iframe's `contentWindow` stays the same object across navigation, so the inner view's first
 * `ui/initialize` reaches a bridge that is already listening. So no readiness signal
 * (`sandbox-proxy-ready`) needs to be exchanged.
 */

export type ProxyPageConfig =
  | { mode: 'opaque'; hostOrigin: string; sandbox: string; allow: string; html: string }
  | { mode: 'app'; hostOrigin: string; sandbox: string; allow: string; src: string; appOrigin: string }

/**
 * The proxy script. Kept as a string because this is code that runs **inside the proxy page**, not
 * in the host. Under the per-app origin method, the CSP allows only this script's hash
 * (`PROXY_SCRIPT_HASH`).
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

/**
 * JSON to place inside a `<script type="application/json">` block. `<` is escaped so that the
 * app's HTML cannot close the block early with `</script>`. `\\u003c` inside a JSON string is the
 * same character.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * The proxy page's color scheme — must match the host view's: the side of the theme that shows
 * (#312), which AppFrame sets on the frame element and tells the view as `theme`.
 *
 * If a frame element's color scheme differs from the document inside it, Chromium paints that
 * document's background **opaque** (CSS Color Adjustment: a rule meant to keep a light document
 * embedded in a dark surrounding readable; Playwright's WebKit does the same). A proxy that did
 * not state a color scheme counted as a light document, so a white canvas covered the entire app
 * view on the dark theme, and a template view using the host's light text color became unreadable
 * against it. Stating the same scheme makes it transparent — the inner frame inherits it, so an
 * app view that states its color scheme from the theme it was given (ext-apps'
 * `applyDocumentTheme`, and our own template) also sits transparently on the host's background.
 * An app that states nothing counts as light: transparent on a light theme, and on a dark one it
 * gets the browser's light canvas laid underneath it (its default black text remains readable).
 * WKWebView keeps child frames transparent, so under Tauri this mostly matters for what the
 * scheme does inside the view (form controls, scrollbars) — this page draws nothing of its own.
 *
 * The page follows the theme without being served again: the script reads the side from the
 * address's fragment (`#color-scheme=light`, set by AppFrame before the first paint), then from
 * every host context the bridge passes through (the `ui/initialize` answer and
 * `host-context-changed`). A side is only ever `light` or `dark`; anything else is ignored. This
 * default is for an address without a fragment (a UI from before the theme reached apps).
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
