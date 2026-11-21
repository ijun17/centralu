import { createListeners } from '@cc/common'
import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

// A cover over each slotted app view while anything is dragged, an OS file too (#296; measured in Playwright's WebKit;
// docs/apps/views.md "Pinned, in the main area"). Hiding every view instead empties the screen. The panel portals it
// into the view (AppPanel), as the view is not inside the panel (slots.ts), so the panel's own handlers hear the drag.

/**
 * How long after a `dragleave` with nothing entered the drag counts as gone from the window. Inside it, the next
 * `dragenter` precedes the old `dragleave` and a `dragover` follows, so a drag over the page cancels this in time;
 * WebKit has left `relatedTarget` empty on every `dragleave`, which only starts and cancels it at each edge.
 */
export const LEAVE_GRACE_MS = 150

/**
 * Reports whether a drag is in progress in `win`; returns the stop function. Captured on the window, as every panel's
 * `dragover` stops propagation. Ending waits a task: a `drop` is heard here before its target, and removing the cover
 * then would take the fiber React finds the panel's handler by. A real mouse move with no button also ends it (no mouse
 * events reach a page mid-drag), so a missed end leaves no cover taking clicks; a zero-distance move is engine noise.
 */
export function watchDrags(win: EventTarget, set: (dragging: boolean) => void): () => void {
  let leaving: ReturnType<typeof setTimeout> | undefined
  let ending: ReturnType<typeof setTimeout> | undefined
  const quiet = () => {
    clearTimeout(leaving)
    clearTimeout(ending)
  }
  const on = () => {
    quiet()
    set(true)
  }
  const end = () => {
    quiet()
    ending = setTimeout(() => set(false), 0)
  }
  const leave = (e: Event) => {
    if ((e as DragEvent).relatedTarget) return
    clearTimeout(leaving)
    leaving = setTimeout(() => set(false), LEAVE_GRACE_MS)
  }
  const move = (e: Event) => {
    const m = e as MouseEvent
    if (m.buttons === 0 && (m.movementX || m.movementY)) {
      quiet()
      set(false)
    }
  }
  const listeners: [string, (e: Event) => void][] = [
    ['dragstart', on],
    ['dragenter', on],
    ['dragover', on],
    ['drop', end],
    ['dragend', end],
    ['dragleave', leave],
    ['mousemove', move],
  ]
  // An options object, not `true`: Node 22's EventTarget (the tests', not WebKit's) does not remove a listener added
  // with a bare `true` (measured with v22.23.3 against v26.9.0); the object form is removed in both
  const capture = { capture: true } as const
  for (const [type, fn] of listeners) win.addEventListener(type, fn, capture)
  return () => {
    quiet()
    for (const [type, fn] of listeners) win.removeEventListener(type, fn, capture)
  }
}

let dragging = false
const dragListeners = createListeners((e) => console.error('A drag listener threw', e))
let watching = false

function subscribeDrag(listener: () => void): () => void {
  if (!watching && typeof window !== 'undefined') {
    // Once, for the page's life: drags are the window's, not a screen's
    watching = true
    watchDrags(window, (now) => {
      if (dragging === now) return
      dragging = now
      dragListeners.emit()
    })
  }
  return dragListeners.add(listener)
}

const draggingNow = () => dragging

/** Whether anything is being dragged over this window */
function useAnyDrag(): boolean {
  return useSyncExternalStore(subscribeDrag, draggingNow, draggingNow)
}

// Where a view takes its cover: its own element in the view (PinnedApps), so the portal never adds children to an
// element React fills. Keyed by the view's key, as in slots.ts.
const hosts = new Map<string, HTMLElement>()
const hostListeners = createListeners((e) => console.error('A shield-host listener threw', e))
const hostsChanged = () => hostListeners.emit()

/** A view laid over a panel offers this element for its cover. Returns the function that withdraws it */
export function registerShieldHost(key: string, el: HTMLElement): () => void {
  hosts.set(key, el)
  hostsChanged()
  return () => {
    if (hosts.get(key) !== el) return
    hosts.delete(key)
    hostsChanged()
  }
}

const subscribeHosts = (listener: () => void) => hostListeners.add(listener)

/**
 * The cover over the view laid on this panel, while a drag is in progress. `dimmed` for the panel being dragged: its
 * view fades with it rather than vanishing.
 */
export function DragShield({ viewKey, dimmed }: { viewKey: string; dimmed: boolean }) {
  const active = useAnyDrag()
  const host = useSyncExternalStore(
    subscribeHosts,
    () => hosts.get(viewKey) ?? null,
    () => null,
  )
  if (!active || !host) return null
  return createPortal(
    <div
      aria-hidden
      className={`absolute inset-0 z-10 ${dimmed ? 'bg-surface-floor/60' : ''}`}
      data-testid="app-drag-shield"
      data-dimmed={dimmed || undefined}
    />,
    host,
  )
}
