import { useSyncExternalStore } from 'react'

/**
 * "Open this file **at this line**" — the half of the request `openFile` does not carry.
 *
 * `openFile(path)` is the store's entire viewer contract and a line is not part of it, so
 * the line rides beside it instead of inside it. It cannot just be a module variable,
 * though: clicking `store.ts:20` and then `store.ts:900` leaves `viewerPath` untouched, so
 * nothing re-renders and the second click would quietly do nothing — precisely the silent
 * no-op this app refuses to ship. Hence a subscribable box, small enough to be read in one
 * sitting, with `at` making two identical requests still count as two.
 *
 * The viewer clears the request once it has flown there. Otherwise a stale line would lie
 * in wait: open some other file from the tree, come back to this one, and it would jump
 * again to a line nobody asked about this time.
 */
export type ViewerJump = { path: string; line: number; at: number }

let current: ViewerJump | null = null
let seq = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of [...listeners]) l()
}

/** Ask the viewer to land on `line` (1-based) once `path` is on screen */
export function requestViewerJump(path: string, line: number): void {
  current = { path, line, at: ++seq }
  notify()
}

/** The viewer has flown there; the request is spent */
export function clearViewerJump(): void {
  if (!current) return
  current = null
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): ViewerJump | null {
  return current
}

export function useViewerJump(): ViewerJump | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
