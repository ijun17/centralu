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
 * One layer can open another and close with it: Git chosen in the palette opens over the palette's
 * field, which is what held focus when the overlay opened, and which is gone by the time the overlay
 * closes. So what is kept is not one element but the recent ones, most recent last (`recent`, fed by
 * one capture listener on the document), and focus goes to the latest of them still usable: past
 * the palette's field, to the composer it was opened from.
 *
 * Given back in a passive (`useEffect`) cleanup: it runs after React has removed the layer's DOM,
 * so `document.activeElement` already tells whether focus fell out. A layout cleanup runs while the
 * layer and its focused element are still in the document.
 */
export function useFocusReturn(open: boolean): void {
  const [wasOpen, setWasOpen] = useState(false)
  const [before, setBefore] = useState<readonly Element[]>([])
  if (open !== wasOpen) {
    setWasOpen(open)
    setBefore(open ? focusedSoFar() : [])
  }
  useEffect(() => {
    if (!open) return
    return () => {
      returnFocus(before)
    }
  }, [open, before])
}

/**
 * The elements that held focus lately, oldest first. Few, and the ones that left the document are
 * dropped on every focus, so this never holds a closed screen's DOM alive for long.
 */
const RECENT = 16
let recent: Element[] = []
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener(
    'focusin',
    () => {
      const now = document.activeElement
      recent = recent.filter((el) => el.isConnected && el !== now)
      if (now) recent.push(now)
      if (recent.length > RECENT) recent.shift()
    },
    true,
  )
}

/** What held focus up to now, the element holding it last */
function focusedSoFar(): Element[] {
  if (typeof document === 'undefined') return []
  const now = document.activeElement
  return now && now !== recent.at(-1) ? [...recent, now] : [...recent]
}

/**
 * Puts focus back on the latest of `before` still in the document, if focus has fallen to the page
 * since. Returns whether it did.
 */
export function returnFocus(before: readonly Element[]): boolean {
  if (typeof document === 'undefined') return false
  const now = document.activeElement
  if (now && now !== document.body && now.isConnected) return false
  for (let i = before.length - 1; i >= 0; i--) {
    const el = before[i]
    if (!(el instanceof HTMLElement) || el === document.body || !el.isConnected || el.closest('[inert]')) continue
    el.focus({ preventScroll: true })
    if (document.activeElement === el) return true
  }
  return false
}
