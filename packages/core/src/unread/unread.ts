/**
 * Read/unread (FR-16). An axis independent of the session state.
 * "The agent worked alone for 5 minutes and finished" = waiting_input + unread — both axes have to show, or
 * it gets missed.
 */

export type ReadTracked = { lastSeq: number; lastReadSeq: number }

export function isUnread(s: ReadTracked): boolean {
  return s.lastSeq > s.lastReadSeq
}

export function unreadCount(s: ReadTracked): number {
  return Math.max(0, s.lastSeq - s.lastReadSeq)
}

/** When to mark read — a short response has nothing to scroll, so time focused is a secondary condition */
export const FOCUS_READ_MS = 3000

export type ReadSignals = {
  focused: boolean
  /** Whether the scroll has reached the latest */
  atBottom: boolean
  /** Time since it was focused (ms) */
  focusedForMs: number
}

export function shouldMarkRead(sig: ReadSignals): boolean {
  if (!sig.focused) return false
  return sig.atBottom || sig.focusedForMs >= FOCUS_READ_MS
}
