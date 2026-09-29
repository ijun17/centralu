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
 */

const slots = new Map<string, HTMLElement>()
const views = new Map<string, HTMLElement>()
/** The panel being dragged on the project screen, if any — see `placeSlots` */
let dragging: string | null = null

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
  view.style.pointerEvents = dragging ? 'none' : ''
  // The dragged panel is dimmed (ProjectView); its view is not inside it, so it is dimmed here
  view.style.opacity = dragging === key ? '0.4' : ''
}

/** The project screen's panel body for this app. Returns the function that removes it */
export function registerSlot(key: string, el: HTMLElement): () => void {
  slots.set(key, el)
  const ro = new ResizeObserver(() => place(key))
  ro.observe(el)
  place(key)
  return () => {
    ro.disconnect()
    if (slots.get(key) === el) slots.delete(key)
  }
}

/** The pinned view to lay over that slot. Returns the function that lets it go back to where it stands */
export function registerSlottedView(key: string, el: HTMLElement): () => void {
  views.set(key, el)
  place(key)
  return () => {
    if (views.get(key) === el) views.delete(key)
    for (const p of ['left', 'top', 'width', 'height', 'pointerEvents', 'opacity'] as const) el.style[p] = ''
  }
}

/** Places every slotted view again — the project screen calls this after each render */
export function placeSlots(draggingKey: string | null): void {
  dragging = draggingKey
  for (const key of views.keys()) place(key)
}
