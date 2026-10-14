import type { SessionState } from '@cc/protocol'

/**
 * What a folded project's name line says in place of the sessions it hides (#205).
 *
 * The sidebar is the place to see "who is waiting for me" at a glance (FR-1). If folding hides the
 * session rows and also hides that signal along with them, folding stops being a tidying feature and
 * becomes a feature that hides signal instead. So the folded row keeps the state of the hidden rows
 * **as counts**.
 *
 * There are four states counted, in the same order of urgency as the inbox (approval → error →
 * waiting for input, then working). Error was not part of the original request, but it cannot be
 * dropped: it is a state that the inbox and ⌘⇧A count as a waiting session (core `isWaiting`), and if a
 * session stalled inside a folded project disappears with no indication at all, folding has just done
 * exactly that. Idle and rate-limited are not counted — they are rows that neither call the person nor
 * move.
 *
 * The counts are never summed (the same rule as the dashboard in FR-12): seeing only "3" does not say
 * whether it is three approvals or three working sessions.
 */
export const FOLD_SUMMARY_STATES = ['waiting_approval', 'error', 'waiting_input', 'working'] as const

export type FoldSummaryState = (typeof FOLD_SUMMARY_STATES)[number]

export function foldSummary(
  sessions: readonly { state: SessionState }[],
): { state: FoldSummaryState; count: number }[] {
  const counts = new Map<SessionState, number>()
  for (const s of sessions) counts.set(s.state, (counts.get(s.state) ?? 0) + 1)
  return FOLD_SUMMARY_STATES.flatMap((state) => {
    const count = counts.get(state) ?? 0
    return count > 0 ? [{ state, count }] : []
  })
}

/**
 * What a folded group (the children of a session, the sessions of an app) says about the rows it hides (#666).
 *
 * A fold must not hide the one thing the sidebar is for, "who is waiting for me" (FR-1), so a group that hides such a
 * row keeps a sign. Two strengths, the same ladder as a row: `alert` is a hidden row that needs an answer (an
 * approval, a question, an error) and is spoken in the signal ink; `unread` is a hidden row with something new to read
 * and is spoken one step quieter. Working, idle and asleep rows say nothing, as in a project's `foldSummary`.
 */
export type GroupAttention = 'alert' | 'unread'

export function groupAttention(
  sessions: readonly { state: SessionState; pendingQuestions: readonly unknown[]; lastSeq: number; lastReadSeq: number }[],
): GroupAttention | null {
  let found: GroupAttention | null = null
  for (const s of sessions) {
    if (s.state === 'waiting_approval' || s.state === 'error' || s.pendingQuestions.length > 0) return 'alert'
    if (s.lastSeq > s.lastReadSeq) found = 'unread'
  }
  return found
}
