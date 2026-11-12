import { appArrivalCandidates, buildInbox, listedState, pendingProposals, proposalCandidates, type InboxCandidate, type InboxItem, type SessionSummary } from '@cc/core'
import type { AppState } from './state.js'

/**
 * What waits on the person, as a list: pure, so the store's own actions and a global shortcut read it as the hooks in
 * `selectors.ts` do (docs/state-management.md §3).
 */

/*
 * A question the agent asked and the person has not answered is listed as an approval is (owner, 2026-10-18): it stays
 * in the inbox until it is answered, read or not. An error keeps its own place: it outranks the question.
 */
const toCandidate = (x: SessionSummary) => ({
  id: x.id, projectId: x.projectId, name: x.name,
  state: listedState(x),
  asking: x.pendingQuestions.length > 0,
  waitingSince: x.waitingSince, lastSeq: x.lastSeq, lastReadSeq: x.lastReadSeq,
  preview: x.preview, interruption: x.interruption ?? null,
})

/** Everything that waits on the person (#703): sessions in a waiting state, and the Assistant's proposals nobody answered */
export function candidates(state: Pick<AppState, 'sessions' | 'mcpProposals' | 'skillProposals' | 'appArrivals'>): InboxCandidate[] {
  // And the apps trusted projects gained (#1141)
  return [...Object.values(state.sessions).map(toCandidate), ...proposalCandidates(pendingProposals(state)), ...appArrivalCandidates(state.appArrivals)]
}

/** A pure computation for use outside a hook (e.g. a global shortcut handler) */
export function computeInbox(state: AppState, now = Date.now()): InboxItem[] {
  return buildInbox(candidates(state), now)
}

/**
 * Where "next waiting" starts from (#703): the session on screen, or on the Assistant's screen with a proposal
 * waiting, the last proposal (its cards stand there), so the jump moves on instead of landing on the same screen.
 */
export function currentWaitingId(state: AppState): string | null {
  if (state.view === 'assistant') {
    const last = computeInbox(state).findLast((i) => i.proposal)
    if (last) return last.id
  }
  return state.focusedSessionId
}

