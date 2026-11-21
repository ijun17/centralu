/** Read/unread (FR-16), an axis independent of the session state */

export type ReadTracked = { lastSeq: number; lastReadSeq: number }

export function isUnread(s: ReadTracked): boolean {
  return s.lastSeq > s.lastReadSeq
}

export function unreadCount(s: ReadTracked): number {
  return Math.max(0, s.lastSeq - s.lastReadSeq)
}

/** A short response has nothing to scroll, so time focused also marks it read */
export const FOCUS_READ_MS = 3000

export type ReadSignals = {
  focused: boolean
  atBottom: boolean
  focusedForMs: number
}

export function shouldMarkRead(sig: ReadSignals): boolean {
  if (!sig.focused) return false
  return sig.atBottom || sig.focusedForMs >= FOCUS_READ_MS
}
