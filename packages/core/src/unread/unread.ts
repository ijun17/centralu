/**
 * 읽음/안읽음 (FR-16). 세션 상태와 독립된 축이다.
 * "에이전트가 5분 혼자 일하고 끝냄" = waiting_input + 안읽음 — 두 축이 다 보여야 안 놓친다.
 */

export type ReadTracked = { lastSeq: number; lastReadSeq: number }

export function isUnread(s: ReadTracked): boolean {
  return s.lastSeq > s.lastReadSeq
}

export function unreadCount(s: ReadTracked): number {
  return Math.max(0, s.lastSeq - s.lastReadSeq)
}

/** 읽음 처리 조건 — 짧은 응답은 스크롤이 없으므로 포커스 경과 시간을 보조로 쓴다 */
export const FOCUS_READ_MS = 3000

export type ReadSignals = {
  focused: boolean
  /** 스크롤이 최신에 닿았는가 */
  atBottom: boolean
  /** 포커스된 후 경과 시간(ms) */
  focusedForMs: number
}

export function shouldMarkRead(sig: ReadSignals): boolean {
  if (!sig.focused) return false
  return sig.atBottom || sig.focusedForMs >= FOCUS_READ_MS
}
