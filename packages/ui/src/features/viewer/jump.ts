import { createListeners } from '@cc/common'
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
const listeners = createListeners((e) => console.error('A viewer-jump listener threw', e))
const notify = () => listeners.emit()

/** Ask the viewer to land on `line` (1-based) once `path` is on screen */
export function requestViewerJump(path: string, line: number): void {
  current = { path, line, at: ++seq }
  notify()
}

/**
 * The pending request, read outside React.
 *
 * The viewer needs this when it re-opens the file under a different path (a relative path
 * resolved to where the file actually is): the line was asked for against the old path, and
 * it has to be asked again against the new one or the jump silently evaporates.
 */
export function currentViewerJump(): ViewerJump | null {
  return current
}

/** The viewer has flown there; the request is spent */
export function clearViewerJump(): void {
  if (!current) return
  current = null
  notify()
}

const subscribe = (listener: () => void) => listeners.add(listener)

function snapshot(): ViewerJump | null {
  return current
}

export function useViewerJump(): ViewerJump | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
