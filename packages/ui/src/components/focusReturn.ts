import { useEffect, useState, type RefObject } from 'react'

/**
 * A layer gives focus back to what held it before it opened (#115): when the layer closes, its focused element leaves
 * the DOM and the browser drops focus on `<body>`, so every key typed into the composer lands nowhere (⌘I, ⌘K or
 * /settings, then Esc).
 *
 * Only when focus fell out (it is on `<body>` or nowhere): a layer that moved it somewhere on purpose (a grid pane's
 * composer) keeps that choice. Only to an element still connected and not inert. What held focus is read while
 * rendering the render that opens the layer: by the first effect `autoFocus` or a child's effect has moved it inside.
 *
 * The recent holders are kept, not one (`recent`): a layer opened from another (Git from the palette) closes with it,
 * and focus goes past the palette's field to the composer. Given back in a passive cleanup, which runs after React
 * removed the layer's DOM (a layout cleanup runs while it is still there). A layer that stays for its exit
 * (usePresence) passes itself as `layer`: focus inside it counts as fallen out the moment it closes, not 150 ms later.
 */
export function useFocusReturn(open: boolean, layer?: RefObject<HTMLElement | null>): void {
  const [wasOpen, setWasOpen] = useState(false)
  const [before, setBefore] = useState<readonly Element[]>([])
  if (open !== wasOpen) {
    setWasOpen(open)
    setBefore(open ? focusedSoFar() : [])
  }
  useEffect(() => {
    if (!open) return
    // The layer as it stands while open: the node that keeps focus through its exit
    const node = layer?.current ?? null
    return () => {
      returnFocus(before, node)
    }
  }, [open, before, layer])
}

/** Recent focus holders, oldest first; disconnected ones are dropped on every focus, so no closed screen is kept alive */
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

/** Focuses the latest usable of `before` if focus fell to the page or is inside the closing `layer`; whether it did */
export function returnFocus(before: readonly Element[], layer: Element | null = null): boolean {
  if (typeof document === 'undefined') return false
  const now = document.activeElement
  // Let go of the leaving layer first, so what asks for the keyboard next (a composer the palette opened, #528) gets it
  if (now instanceof HTMLElement && layer?.contains(now)) now.blur()
  else if (now && now !== document.body && now.isConnected) return false
  for (let i = before.length - 1; i >= 0; i--) {
    const el = before[i]
    if (!(el instanceof HTMLElement) || el === document.body || !el.isConnected || el.closest('[inert]')) continue
    if (layer?.contains(el)) continue
    el.focus({ preventScroll: true })
    if (document.activeElement === el) return true
  }
  return false
}
