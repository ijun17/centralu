import type { Interruption, SessionState } from '@cc/protocol'
import { URGENCY, isWaiting } from '../session/state-machine.js'
import { isUnread, type ReadTracked } from '../unread/unread.js'

/**
 * The inbox is derived state (docs/state-management.md §3). It is never stored.
 * Order: urgency → unread → when the wait started, ascending (the longest wait first).
 *
 * **What is listed** (#669): approvals and errors while the session is in that state, and a
 * `waiting_input` session only while it is unread. A finished turn the person has already read
 * (or marked Done) needs nothing more, so it leaves the list; a new answer (a new `lastSeq`)
 * makes it unread again and it returns. The list, the counters, the sidebar's folded summary and
 * "next waiting" all ask `isListedWaiting`, so they cannot disagree.
 *
 * **A stopped turn is listed too** (#698): a session whose last turn the network, a quit or its tool cut short rests in
 * a state that says nothing of it (`idle` after a quit, `waiting_input` after an interrupt). It is listed like a
 * finished turn, while unread, with the urgency of an error; the line Centralu writes for a quit makes it unread.
 * A tool reconnecting for too long is listed while it lasts, though the session is still working.
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
  interruption?: Interruption | null
}

export type InboxItem = InboxCandidate & {
  unread: boolean
  urgency: number
  waitingMs: number
}

/** Does this session belong in the inbox and its counters? */
export function isListedWaiting(s: { state: SessionState; interruption?: Interruption | null } & ReadTracked): boolean {
  if (s.interruption?.reason === 'reconnecting') return true
  if (s.interruption && s.state === 'idle') return isUnread(s)
  return s.state === 'waiting_input' ? isUnread(s) : isWaiting(s.state)
}

/** A stopped turn waits on the person as an error does (#698): only an approval blocks the agent more */
export function urgencyOf(s: { state: SessionState; interruption?: Interruption | null }): number {
  return s.interruption ? Math.min(URGENCY[s.state], URGENCY.error) : URGENCY[s.state]
}

export function buildInbox(sessions: readonly InboxCandidate[], now: number): InboxItem[] {
  return sessions
    .filter(isListedWaiting)
    .map((s) => ({
      ...s,
      // An idle session stopped by a quit has no wait of its own; it has waited since it stopped
      waitingSince: s.waitingSince ?? s.interruption?.at ?? null,
      unread: isUnread(s),
      urgency: urgencyOf(s),
    }))
    .map((s) => ({ ...s, waitingMs: s.waitingSince == null ? 0 : Math.max(0, now - s.waitingSince) }))
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
    if (!isListedWaiting(s)) continue
    if (s.state === 'waiting_approval') c.approval++
    // A stopped turn, or a tool reconnecting for too long, counts with the errors (#698), as `urgencyOf` orders it
    else if (s.state === 'error' || s.interruption) c.error++
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

