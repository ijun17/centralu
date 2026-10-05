import { APP_DRAG_NOTIFICATION, APP_DRAG_TEXT_MAX } from '@cc/protocol'

/**
 * The drag relay (#308): a few lines the host adds to every app view's document, so an item dragged
 * out of a view can land in a session's composer.
 *
 * **Why the drag's own data cannot do it.** A drag that starts in a document of one origin is not
 * delivered to a document of another origin in the same page. Measured on 2026-10-05 in Playwright's
 * Chromium and WebKit (Playwright 1.62.1): a card in a frame setting `text/uri-list` and `text/plain`,
 * dragged onto a textarea in the page, reached it from a same-origin `srcdoc` frame, and from a frame
 * on another host, on the same host and another port, and from a sandboxed (opaque) `srcdoc` frame,
 * the page heard **nothing**: no `dragenter`, no `dragover`, no `drop`. Only the frame's `dragend`
 * fired. Both engines carry the same rule (`SecurityOrigin::canReceiveDragData` in WebKit, and Blink
 * kept it), and an app view is always another origin: the proxy is the host's port, the view inside
 * it opaque or its own port (proxy-page.ts). So the UI never sees the drag, let alone its data.
 *
 * **What this does instead.** It listens in the view's own window, where the drag does happen: at
 * `dragstart`, after the app's own handler has put its data on, it reads `text/uri-list` and
 * `text/plain` and posts them to the parent; at that drag's `dragend` it posts where the drag
 * ended, in the view's coordinates, with the view's size. The proxy passes both on unchanged, as it
 * does every message from the view, and the UI (app-frame/dragRelay.ts) turns the end point into a
 * point in its page and hands the link to the session under it.
 *
 * **Why the host adds it, not the app runtime.** The runtime (`runtime/mcp-app.js`) is copied into
 * every app folder and committed with it, so a change there reaches an app only when its runtime is
 * replaced, and never reaches an app built for another host. Added here, every view gets it, and the
 * contract for an app stays the standard one: put `text/uri-list` and `text/plain` on the drag.
 *
 * It only posts, to its own parent, what the app's document could post itself, so it gives the app
 * nothing it did not have. The UI treats both messages as the app's words: it checks their shape,
 * and the link only ever goes into a draft the person sees and sends themselves.
 *
 * It needs inline script, which every view's CSP allows (csp.ts: a view is inline HTML). A view
 * whose own `<meta>` policy forbids inline script blocks it, and its items simply do not drop into
 * a composer.
 */

/**
 * The relay script. Kept to ES5 and wrapped, so it runs in any app's page and leaves no name behind.
 *
 * `dragstart` is heard on the window in the bubble phase, after the item's own handler has set the
 * data (the data can be read only during `dragstart`). A drag the app cancelled is left alone. The
 * end is only reported for a drag whose start was, so an app's own drags with no link or text (the
 * project board's column moves carry only their own type) send nothing.
 */
export const DRAG_RELAY_SCRIPT = `(function () {
  'use strict'
  var METHOD = ${JSON.stringify(APP_DRAG_NOTIFICATION)}
  var MAX = ${APP_DRAG_TEXT_MAX}
  var open = false
  function post(params) {
    try { window.parent.postMessage({ jsonrpc: '2.0', method: METHOD, params: params }, '*') } catch (e) {}
  }
  function read(dt, type) {
    try { return String(dt.getData(type) || '').slice(0, MAX) } catch (e) { return '' }
  }
  window.addEventListener('dragstart', function (e) {
    open = false
    if (e.defaultPrevented || !e.dataTransfer) return
    var uri = read(e.dataTransfer, 'text/uri-list')
    var text = read(e.dataTransfer, 'text/plain')
    if (!uri && !text) return
    open = true
    post({ phase: 'start', uri: uri, text: text })
  })
  window.addEventListener('dragend', function (e) {
    if (!open) return
    open = false
    post({ phase: 'end', x: e.clientX, y: e.clientY, width: window.innerWidth, height: window.innerHeight })
  })
})()`

/**
 * The view's document with the relay added: before the last `</body>`, or at the very end when there
 * is none. Never at the start: anything before `<!doctype html>` would put the page in quirks mode.
 */
export function withDragRelay(html: string): string {
  const tag = `<script>${DRAG_RELAY_SCRIPT}</script>`
  const at = html.toLowerCase().lastIndexOf('</body>')
  return at === -1 ? `${html}${tag}` : `${html.slice(0, at)}${tag}${html.slice(at)}`
}
