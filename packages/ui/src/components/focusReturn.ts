import { useEffect, useState } from 'react'

/**
 * A layer gives focus back to what held it before the layer opened (#115).
 *
 * The inbox, the command palette, a dialog and the settings screen each take focus while they are
 * up: the inbox blurs the composer on purpose, the palette focuses its own field, a click inside a
 * dialog focuses whatever was clicked. When the layer closes, the element holding focus leaves the
 * DOM with it, and the browser drops focus on `<body>`. Nothing on screen says so: the composer
 * looks exactly as it did, the person goes on typing, and every key lands nowhere until they click
 * back into the box. That is #115's "the composer sometimes stops accepting keystrokes" — ⌘I then
 * Esc, ⌘K then Esc, /settings then Esc.
 *
 * Focus only goes back when it **fell out**: it sits on `<body>` (or nowhere) once the layer is
 * gone. A layer that moved focus somewhere real on purpose — choosing a session in the grid
 * focuses that pane's composer — keeps that choice. And only to an element still in the document
 * and not inert: a composer that went away with the session it belonged to is not brought back.
 *
 * What held focus is read **while rendering the render that opens the layer**, before React commits
 * it: by the first effect it is already too late, since `autoFocus` inside a dialog, or a child's
 * effect focusing its own content (the viewer's code view), has moved focus into the layer by then.
 * Remembered through state adjusted during render, React's pattern for keeping something from a
 * previous render.
 *
 * Given back in a passive (`useEffect`) cleanup: it runs after React has removed the layer's DOM,
 * so `document.activeElement` already tells whether focus fell out. A layout cleanup runs while the
 * layer and its focused element are still in the document.
 */
export function useFocusReturn(open: boolean): void {
  const [wasOpen, setWasOpen] = useState(false)
  const [before, setBefore] = useState<Element | null>(null)
  if (open !== wasOpen) {
    setWasOpen(open)
    setBefore(open && typeof document !== 'undefined' ? document.activeElement : null)
  }
  useEffect(() => {
    if (!open) return
    return () => {
      returnFocus(before)
    }
  }, [open, before])
}

/** Puts focus back on `before` if focus has fallen to the page since. Returns whether it did */
export function returnFocus(before: Element | null): boolean {
  if (typeof document === 'undefined') return false
  if (!(before instanceof HTMLElement) || before === document.body || !before.isConnected) return false
  const now = document.activeElement
  if (now && now !== document.body && now.isConnected) return false
  if (before.closest('[inert]')) return false
  before.focus({ preventScroll: true })
  return document.activeElement === before
}
