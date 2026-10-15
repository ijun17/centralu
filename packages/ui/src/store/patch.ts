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
