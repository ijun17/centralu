import { createListeners } from '@cc/common'
import { useSyncExternalStore } from 'react'

/**
 * The line of an "open this file at this line", beside the store's `openFile(path)`. Subscribable, not a plain variable:
 * `store.ts:20` then `store.ts:900` leaves `viewerPath` as it is, so nothing would re-render. `at` makes two identical
 * requests two. The viewer clears it on arrival, or a later visit to the file would jump again.
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

/** The pending request, read outside React: a file re-opened under its resolved path asks for the line again */
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
