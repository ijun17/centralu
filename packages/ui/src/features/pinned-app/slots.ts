// A pinned view laid over its panel's empty slot on the project screen (#203) or grid (#288): a moved iframe loses its
// document (docs/apps/views.md "Pinned, in the main area"). Keyed by `appKeyOf`, or `gridAppViewKey` on the grid. The
// second side to register places it; the slot's ResizeObserver and `placeSlots` (a move without a resize) follow.

const slots = new Map<string, HTMLElement>()
const views = new Map<string, HTMLElement>()

/**
 * Lays one view over its slot. The two sit in different parents, so the slot is measured on
 * screen and turned into the CSS pixels of the view's containing block (the middle lane). A rect
 * has the text zoom (App.tsx, on the root) multiplied in and a style length would get it again,
 * so the rect is divided by it first — the same conversion the tooltip makes (primitives.tsx).
 */
function place(key: string): void {
  const view = views.get(key)
  const slot = slots.get(key)
  const block = view?.offsetParent as HTMLElement | null | undefined
  if (!view || !slot || !block || !slot.isConnected) return
  const b = block.getBoundingClientRect()
  const r = slot.getBoundingClientRect()
  const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--text-zoom')) || 1
  view.style.left = `${(r.left - b.left) / scale - block.clientLeft}px`
  view.style.top = `${(r.top - b.top) / scale - block.clientTop}px`
  view.style.width = `${r.width / scale}px`
  view.style.height = `${r.height / scale}px`
}

/** What can take focus, for the keyboard order around a slot */
const FOCUSABLE = 'iframe, button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/** The element that last had focus in this document — read by a slot as focus reaches it (see `slotFocused`) */
let lastFocus: Element | null = null
let trackingFocus = false
function trackFocus(): void {
  if (trackingFocus || typeof document.addEventListener !== 'function') return
  trackingFocus = true
  // Capture, so it is recorded however the element's own handlers treat the event. A frame taking focus is reported
  // here as the frame element: focus inside another document is that frame, seen from this one. The active element
  // rather than the event's target: a slot hands focus on from its own focus handler, and the slot's focusin still
  // arrives after that, naming the slot as if it had kept focus
  document.addEventListener('focusin', () => (lastFocus = document.activeElement), true)
}

/**
 * Focus reached a slot, the view's place in the Tab order (the view sits after every panel in the document). From
 * before it, focus goes into the view: its frame, or its first control (Trust this project, Restart). Coming out of the
 * view (Shift+Tab), it goes to what stands before the slot, or Shift+Tab would bounce back into the view.
 */
function slotFocused(key: string, slot: HTMLElement): void {
  const view = views.get(key)
  if (!view) return
  if (lastFocus && view.contains(lastFocus)) {
    const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
    const at = all.indexOf(slot)
    all[at - 1]?.focus()
    return
  }
  const inside = [...view.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => el.getClientRects().length > 0)
  inside?.focus()
}

/** A panel's body for this app (the project screen's or the grid's). Returns the function that removes it */
export function registerSlot(key: string, el: HTMLElement): () => void {
  slots.set(key, el)
  const ro = new ResizeObserver(() => place(key))
  ro.observe(el)
  place(key)
  trackFocus()
  const onFocus = () => slotFocused(key, el)
  el.addEventListener?.('focus', onFocus)
  return () => {
    ro.disconnect()
    el.removeEventListener?.('focus', onFocus)
    if (slots.get(key) === el) slots.delete(key)
  }
}

/** The pinned view to lay over that slot. Returns the function that lets it go back to where it stands */
export function registerSlottedView(key: string, el: HTMLElement): () => void {
  views.set(key, el)
  place(key)
  return () => {
    if (views.get(key) === el) views.delete(key)
    for (const p of ['left', 'top', 'width', 'height'] as const) el.style[p] = ''
  }
}

/** Places every slotted view again — the project screen and the grid call this after each render */
export function placeSlots(): void {
  for (const key of views.keys()) place(key)
}
