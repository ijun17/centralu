/**
 * Where a pinned view stands while the project screen shows it (#203).
 *
 * An iframe cannot move. Taking it out of the document throws its document away, and moving it
 * is taking it out and putting it back (PinnedApps' header comment). So the project screen does
 * not draw an app's view inside its panel: the panel holds an empty slot, and the pinned view —
 * the one instance, in the one frame, that the app view also shows — is laid over that slot from
 * where it always stands. Only its style changes, so going between the project screen, the app
 * view and a session keeps one document, and the view never has a second frame.
 *
 * Two sides register here: the panel's slot (ProjectView) and the pinned view laid over it
 * (PinnedApps). Whichever arrives second places the view. After that the slot's own resize
 * observer follows the window, and the project screen calls `placeSlots` after every render,
 * which is what follows a panel that moved without changing size (a drag's preview order).
 *
 * Slots and views are keyed by the pinned view's key (`externalAppKey`, `<project>/<appId>`). The
 * grid lays its app panels' views out the same way (#288), keyed by the grid's own view of the app
 * (`gridAppViewKey`, `grid:<project>/<appId>`).
 *
 * A drag over a view is not this file's business: the view stays in place and in sight, and the panel lays a
 * transparent cover over it for the length of the drag (dragShield.tsx, #296).
 *
 * A slot is also the view's place in the **keyboard** order. The view sits after every panel in the
 * document, so Tab from an app panel's header would skip its own view and land on the next panel,
 * reaching the view only after the last panel. The slot is focusable and hands focus on to the view
 * laid over it — and back to the header when focus comes back out of the view, so Shift+Tab is not
 * caught between the two.
 */

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
 * Focus reached a slot. Coming from before it (Tab from the panel's header), it goes on into the view laid over it:
 * its frame, or the first control a view without one shows (Trust this project, Restart). Coming back out of that view
 * (Shift+Tab from its frame), it goes on to whatever stands before the slot — the header's last control — or Shift+Tab
 * would be sent straight back into the view.
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
