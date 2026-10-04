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
 * (`gridAppViewKey`, `grid:<project>/<appId>`). Only one of the two screens is ever on show, so they
 * share the drag state below.
 *
 * A slot is also the view's place in the **keyboard** order. The view sits after every panel in the
 * document, so Tab from an app panel's header would skip its own view and land on the next panel,
 * reaching the view only after the last panel. The slot is focusable and hands focus on to the view
 * laid over it — and back to the header when focus comes back out of the view, so Shift+Tab is not
 * caught between the two.
 */

const slots = new Map<string, HTMLElement>()
const views = new Map<string, HTMLElement>()
/** Whether a panel is being dragged on the screen showing the views — see `place` */
let panelDragged = false
/** A drag from outside the screen that the screen takes (a sidebar row) — see `place` */
let inbound = false

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
  /*
   * While a panel is dragged, frames stop taking the pointer. An iframe swallows `dragover`, and
   * this one is not inside the panel it covers, so the panel under the hand would never hear
   * where the drag is and the preview order would freeze over every app panel.
   */
  view.style.pointerEvents = panelDragged || inbound ? 'none' : ''
  /*
   * And more than that: while anything is dragged, the views are hidden until it is dropped. In
   * WebKit a drag goes into a frame whatever the frame's pointer-events say — measured in
   * Playwright's WebKit, a row dragged over an app's view went quiet on the page the moment it
   * crossed the frame's edge, and its drop never arrived; with the view hidden the page heard
   * every dragover and the drop.
   *
   * A panel drag was once thought to get by, because its preview moves a panel under the hand. It
   * does only when the hand happens to reach an app panel through its header: measured again for
   * #288, a session panel dragged sideways into an app's view went just as quiet, on the grid and
   * on the project screen, and a drop let go over the dragged app panel's own view would be lost
   * the same way, taking the preview with it. So a panel drag hides them too — the dragged app
   * panel's view included, which used to be dimmed with its panel and now steps aside with the
   * rest. Hidden is not unloaded: the documents stay, and show again when the drag ends.
   */
  view.style.visibility = panelDragged || inbound ? 'hidden' : ''
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
    for (const p of ['left', 'top', 'width', 'height', 'pointerEvents', 'visibility'] as const) el.style[p] = ''
  }
}

/**
 * Places every slotted view again — the project screen and the grid call this after each render.
 * `panelDragged` is whether one of the screen's own panels is being dragged; `rowDragged` is a drag
 * from outside the screen that the screen takes (a sidebar row). While either is true, every view
 * steps aside (`place`).
 */
export function placeSlots(panelDraggedNow: boolean, rowDragged = false): void {
  panelDragged = panelDraggedNow
  inbound = rowDragged
  for (const key of views.keys()) place(key)
}
