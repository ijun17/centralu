import type { AppState } from './state.js'

export function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const next = { ...obj }
  delete next[key]
  return next
}

/**
 * Every post-await update of one session goes through this (#163): it changes nothing once `session_deleted`
 * arrived, where spreading the deleted row would revive a near-empty one that breaks code iterating all sessions.
 */
export function ifSessionStill(
  sessionId: string,
  patch: (st: AppState, cur: AppState['sessions'][string]) => Partial<AppState>,
): (st: AppState) => Partial<AppState> {
  return (st) => {
    const cur = st.sessions[sessionId]
    return cur ? patch(st, cur) : {}
  }
}

/**
 * What a failed reorder puts back (#842): only the order, never the map from before the drag, which would undo what
 * changed while the save was out. Keys `order` does not name keep their place after those it does.
 */
export function inOrder<T>(current: Record<string, T>, order: readonly string[]): Record<string, T> {
  const next: Record<string, T> = {}
  for (const id of order) if (Object.hasOwn(current, id)) next[id] = current[id]!
  for (const [id, v] of Object.entries(current)) if (!Object.hasOwn(next, id)) next[id] = v
  return next
}

/**
 * Whether the keys of `current` that `order` names still stand in that order (#842 item 3): a failed reorder undoes its
 * order only while the screen still shows it, so it never undoes a later reorder that was saved.
 */
export function stillInOrder(current: Record<string, unknown>, order: readonly string[]): boolean {
  const named = new Set(order)
  const shown = Object.keys(current).filter((id) => named.has(id))
  const ours = order.filter((id) => Object.hasOwn(current, id))
  return shown.length === ours.length && shown.every((id, i) => id === ours[i])
}
