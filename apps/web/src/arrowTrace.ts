// @ts-nocheck
/* eslint-disable */
/**
 * TRACE ONLY, NOT FOR MERGE. A recorder for the composer's stuck ArrowLeft: it only listens and writes a ring of the last 400
 * entries (see the key list in the PR text). Press Cmd+Alt+L (Ctrl+Alt+L) right after the arrow gets stuck: the ring is
 * copied to the clipboard as JSON; paste it into a message. Cmd+Alt+K clears it.
 */
export function installArrowTrace() {
(() => {
  if (window.__arrowTrace) return
  const t0 = performance.now()
  const ring = []
  const box = () => document.querySelector('[data-testid="prompt-input"]')
  const where = (el) => (el && el.tagName ? el.tagName.toLowerCase() + (el.dataset && el.dataset.testid ? `[${el.dataset.testid}]` : '') : String(el))
  const state = () => {
    const el = box()
    return el
      ? { s: el.selectionStart, e: el.selectionEnd, len: el.value.length, top: el.scrollTop, focus: document.activeElement === el, ac: !!document.querySelector('[role="listbox"]') }
      : { box: false }
  }
  const put = (type, extra) => {
    ring.push({ t: Math.round(performance.now() - t0), type, ...extra, ...state() })
    if (ring.length > 400) ring.shift()
  }
  const stack = () => new Error().stack.split('\n').slice(2, 7).map((l) => l.trim()).join(' | ')
  const arrows = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape', 'Process'])
  const listeners = []
  const on = (target, type, fn, capture = true) => {
    target.addEventListener(type, fn, capture)
    listeners.push([target, type, fn, capture])
  }
  const lastCaret = { s: null }
  const preventedBy = new WeakMap()
  const realPrevent = Event.prototype.preventDefault
  Event.prototype.preventDefault = function () {
    if (this.type === 'keydown' && (arrows.has(this.key) || this.keyCode === 229)) preventedBy.set(this, stack())
    return realPrevent.apply(this, arguments)
  }
  on(window, 'keydown', (e) => {
    if (!arrows.has(e.key) && e.keyCode !== 229) return
    const before = state()
    const mods = ['shiftKey', 'altKey', 'metaKey', 'ctrlKey'].filter((m) => e[m]).join('+')
    // After every handler on the way to the target has run
    setTimeout(() => {
      put('key', { key: e.key, code: e.code, keyCode: e.keyCode, isComposing: e.isComposing, mods, target: where(e.target), prevented: e.defaultPrevented, ...(preventedBy.has(e) ? { by: preventedBy.get(e) } : {}), beforeS: before.s })
    }, 0)
    setTimeout(() => {
      const now = state()
      put('key+', { key: e.key, moved: now.s !== before.s || now.e !== before.e, from: before.s, to: now.s })
    }, 60)
  })
  on(document, 'selectionchange', () => put('sel', { on: 'document' }))
  on(window, 'select', (e) => put('sel', { on: where(e.target) }))
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) on(window, type, (e) => put('comp', { ev: type, data: e.data }))
  on(window, 'beforeinput', (e) => put('before', { inputType: e.inputType, data: e.data, isComposing: e.isComposing }))
  on(window, 'input', (e) => put('input', { inputType: e.inputType, isComposing: e.isComposing }))
  on(window, 'focusin', (e) => put('focus', { ev: 'in', on: where(e.target) }))
  on(window, 'focusout', (e) => put('focus', { ev: 'out', on: where(e.target), to: where(e.relatedTarget) }))
  // Script writes to the box: the value setter and the selection setters
  const patches = []
  const patch = (proto, name, isSetter) => {
    const d = Object.getOwnPropertyDescriptor(proto, name)
    if (!d) return
    if (isSetter && d.set) {
      Object.defineProperty(proto, name, { ...d, set(v) {
        if (this === box() && String(v) !== this.value) put('ws', { what: `${name} = ${JSON.stringify(String(v).slice(0, 20))}`, by: stack() })
        return d.set.call(this, v)
      } })
      patches.push(() => Object.defineProperty(proto, name, d))
    } else if (typeof d.value === 'function') {
      Object.defineProperty(proto, name, { ...d, value: function () {
        if (this === box()) put('ws', { what: `${name}(${[...arguments].map((a) => JSON.stringify(a)).join(',')})`, by: stack() })
        return d.value.apply(this, arguments)
      } })
      patches.push(() => Object.defineProperty(proto, name, d))
    }
  }
  patch(HTMLTextAreaElement.prototype, 'value', true)
  patch(HTMLTextAreaElement.prototype, 'setSelectionRange', false)
  patch(HTMLTextAreaElement.prototype, 'setRangeText', false)
  patch(HTMLElement.prototype, 'focus', false)
  window.__arrowTrace = {
    dump: () => JSON.stringify(ring),
    ring,
    off: () => {
      for (const [t, type, fn, c] of listeners) t.removeEventListener(type, fn, c)
      Event.prototype.preventDefault = realPrevent
      for (const undo of patches) undo()
      delete window.__arrowTrace
    },
  }
  put('installed', {})
})()
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !(e.metaKey || e.ctrlKey)) return
    if (e.code === 'KeyL') {
      e.preventDefault()
      void navigator.clipboard.writeText(window.__arrowTrace.dump())
    }
    if (e.code === 'KeyK') {
      e.preventDefault()
      window.__arrowTrace.ring.length = 0
    }
  }, true)
}
