import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

/**
 * A transparent cover over each app view laid over a panel, for as long as anything is dragged (#296).
 *
 * In WebKit a drag goes into a frame whatever the frame's pointer-events say: measured in Playwright's WebKit, a row or
 * a panel dragged over an app's view went quiet on the page the moment it crossed the frame's edge, and its drop never
 * arrived. #294 answered that by hiding every view for the length of any drag, which emptied the screen — views
 * nowhere near the hand included. The cover answers it instead: it is an element of this page lying above the frame, so
 * `dragenter`, `dragover` and `drop` land on the page, and the view stays where it was, showing what it showed.
 *
 * The view is not inside its panel (slots.ts: an iframe that moves loses its document), so a cover inside the view
 * would send the drag to the view's parents, not the panel's. The panel draws the cover itself (AppPanel) through a
 * portal into the view: in the page it lies over the frame, and in React's tree it is the panel's child, so the
 * panel's own drag handlers hear the drag exactly as they hear it over its header.
 *
 * Any drag: one of the screen's panels, a sidebar row, selected text, a file from the OS — the frame swallows them all
 * the same way. The cover goes on a drag's `dragend` or `drop`, and when the drag leaves the window.
 */

/**
 * How long after a `dragleave` with nothing entered the drag counts as gone from the window. Inside the window the
 * next element's `dragenter` comes before the old one's `dragleave` and its `dragover` right after, so a drag still
 * over the page cancels this well within it; an engine that leaves `relatedTarget` empty on every `dragleave` (WebKit
 * has) only starts and cancels it at each edge.
 */
export const LEAVE_GRACE_MS = 150

/**
 * Follows drags in `win` and reports whether one is in progress. Returns the function that stops.
 *
 * Capture on the window, so a handler below that stops propagation (every panel's `dragover` does) cannot hide the
 * drag from it. Ending is put off a task: a `drop` is heard here before its target, and removing the cover under it
 * then would take the fiber React looks the target up by, and with it the panel's handler.
 *
 * Also ended by a real mouse move with no button held. No mouse events reach the page during a drag, so one arriving
 * means the drag is over, however its end was missed — a cover left behind would take the frames' clicks. A move
 * with no distance is not counted: an engine sends those by itself when the page changes under a still pointer.
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
  // An options object, not `true`: Node 22's EventTarget does not remove a listener added with a
  // bare `true` when it is removed with `true` (the test environment's, not WebKit's), measured
  // on 2026-10-04 with v22.23.3 against v26.9.0. The object form is removed in both.
  const capture = { capture: true } as const
  for (const [type, fn] of listeners) win.addEventListener(type, fn, capture)
  return () => {
    quiet()
    for (const [type, fn] of listeners) win.removeEventListener(type, fn, capture)
  }
}

let dragging = false
const dragListeners = new Set<() => void>()
let watching = false

function subscribeDrag(listener: () => void): () => void {
  if (!watching && typeof window !== 'undefined') {
    // Once, for the page's life: drags are the window's, not a screen's
    watching = true
    watchDrags(window, (now) => {
      if (dragging === now) return
      dragging = now
      for (const l of dragListeners) l()
    })
  }
  dragListeners.add(listener)
  return () => {
    dragListeners.delete(listener)
  }
}

const draggingNow = () => dragging

/** Whether anything is being dragged over this window */
export function useAnyDrag(): boolean {
  return useSyncExternalStore(subscribeDrag, draggingNow, draggingNow)
}

/*
 * Where a view takes its cover: an element of its own inside the view (PinnedApps), so the portal never adds children
 * to an element React already fills. Keyed like slots.ts, by the view's key.
 */
const hosts = new Map<string, HTMLElement>()
const hostListeners = new Set<() => void>()
const hostsChanged = () => {
  for (const l of hostListeners) l()
}

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

function subscribeHosts(listener: () => void): () => void {
  hostListeners.add(listener)
  return () => {
    hostListeners.delete(listener)
  }
}

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
      className={`absolute inset-0 z-10 ${dimmed ? 'bg-void/60' : ''}`}
      data-testid="app-drag-shield"
      data-dimmed={dimmed || undefined}
    />,
    host,
  )
}
