import type { SessionState } from '@cc/protocol'
import { URGENCY, isWaiting } from '../session/state-machine.js'
import { isUnread } from '../unread/unread.js'

/**
 * The inbox is derived state (docs/state-management.md §3). It is never stored.
 * Order: urgency → unread → when the wait started, ascending (the longest wait first).
 */

export type InboxCandidate = {
  id: string
  /** An orchestrator has no project */
  projectId: string | null
  name: string
  state: SessionState
  waitingSince: number | null
  lastSeq: number
  lastReadSeq: number
  preview?: string
}

export type InboxItem = InboxCandidate & {
  unread: boolean
  urgency: number
  waitingMs: number
}

export function buildInbox(sessions: readonly InboxCandidate[], now: number): InboxItem[] {
  return sessions
    .filter((s) => isWaiting(s.state))
    .map((s) => ({
      ...s,
      unread: isUnread(s),
      urgency: URGENCY[s.state],
      waitingMs: s.waitingSince == null ? 0 : Math.max(0, now - s.waitingSince),
    }))
    .sort(
      (a, b) =>
        a.urgency - b.urgency ||
        Number(b.unread) - Number(a.unread) ||
        (a.waitingSince ?? Infinity) - (b.waitingSince ?? Infinity) ||
        a.id.localeCompare(b.id),
    )
}

/** The global counters — never summed (FR-12: "2 approvals · 3 awaiting response") */
export type WaitingCounts = { approval: number; error: number; input: number }

export function countWaiting(sessions: readonly InboxCandidate[]): WaitingCounts {
  const c: WaitingCounts = { approval: 0, error: 0, input: 0 }
  for (const s of sessions) {
    if (s.state === 'waiting_approval') c.approval++
    else if (s.state === 'error') c.error++
    else if (s.state === 'waiting_input') c.input++
  }
  return c
}

/**
 * "Go to the next waiting item" (FR-17). Cycles to the item after the current session.
 * It follows the inbox order exactly, so the order is approval → error → awaiting response.
 */
export function nextWaitingSession(inbox: readonly InboxItem[], currentId: string | null): string | null {
  if (inbox.length === 0) return null
  if (currentId == null) return inbox[0]!.id
  const idx = inbox.findIndex((i) => i.id === currentId)
  if (idx === -1) return inbox[0]!.id
  return inbox[(idx + 1) % inbox.length]!.id
}

