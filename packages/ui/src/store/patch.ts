import type { AppState } from './state.js'

/** Small helpers the store's actions write state with, in every module that holds them */

/** A new object with one key removed (never mutates state directly) */
export function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const next = { ...obj }
  delete next[key]
  return next
}

/**
 * A `set` that updates one session **after** awaiting an RPC (#163) — changes nothing if
 * `session_deleted` arrived in the meantime.
 *
 * The post-await `set` used to spread `{ ...s.sessions[id]!, … }`. If the session was deleted while
 * awaiting, that revived a near-empty row (`{"live":true}`), which broke code that iterates all
 * sessions (`s.touchedPaths is not iterable`). Every post-await session update now goes through this
 * gate, so any future addition gets the same rule.
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
 * `current`, with its keys in the order `order` names (#842 item 3); keys `order` does not name keep their place after
 * those, and names no longer in `current` are skipped.
 *
 * What a failed reorder puts back. It used to put back the whole map as it was before the drag, so anything that
 * happened while the save was out went with it: a session created meanwhile vanished, a state change was undone, and a
 * project deleted meanwhile came back. Only the order was the reorder's to undo.
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
