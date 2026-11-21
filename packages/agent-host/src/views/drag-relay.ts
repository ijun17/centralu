import { APP_DRAG_NOTIFICATION, APP_DRAG_TEXT_MAX } from '@cc/protocol'

/**
 * The drag relay (#308): a script added to every app view so an item dragged out of it can land in a session's composer.
 * Why the drag's own data cannot do it, and the messages it sends: docs/apps/view-theme-layout-drag.md "Dragging an item out of a view"
 */

/**
 * The relay script, kept to ES5 and wrapped so it runs in any page and leaves no name behind. A drag the app cancelled is left
 * alone; an end is reported only for a drag whose start was (the board's column moves carry no link or text)
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
 * The view's document with the relay added before the last `</body>`, or at the end; never at the start, where it would put the
 * page in quirks mode
 */
export function withDragRelay(html: string): string {
  const tag = `<script>${DRAG_RELAY_SCRIPT}</script>`
  const at = html.toLowerCase().lastIndexOf('</body>')
  return at === -1 ? `${html}${tag}` : `${html.slice(0, at)}${tag}${html.slice(at)}`
}
