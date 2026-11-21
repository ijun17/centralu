import { appArrivalCandidates, buildInbox, listedState, pendingProposals, proposalCandidates, type InboxCandidate, type InboxItem, type SessionSummary } from '@cc/core'
import type { AppState } from './state.js'

// The inbox, pure so store actions and shortcuts read it as the hooks in `selectors.ts` do (docs/state-management.md §3).

// An unanswered question stays listed, read or not, as an approval does; an error outranks it (owner, 2026-10-18).
const toCandidate = (x: SessionSummary) => ({
  id: x.id, projectId: x.projectId, name: x.name,
  state: listedState(x),
  asking: x.pendingQuestions.length > 0,
  waitingSince: x.waitingSince, lastSeq: x.lastSeq, lastReadSeq: x.lastReadSeq,
  preview: x.preview, interruption: x.interruption ?? null,
})

export function candidates(state: Pick<AppState, 'sessions' | 'mcpProposals' | 'skillProposals' | 'appArrivals'>): InboxCandidate[] {
  return [...Object.values(state.sessions).map(toCandidate), ...proposalCandidates(pendingProposals(state)), ...appArrivalCandidates(state.appArrivals)]
}

export function computeInbox(state: AppState, now = Date.now()): InboxItem[] {
  return buildInbox(candidates(state), now)
}

// On the Assistant's screen "next waiting" starts after its last proposal, whose cards stand there (#703).
export function currentWaitingId(state: AppState): string | null {
  if (state.view === 'assistant') {
    const last = computeInbox(state).findLast((i) => i.proposal)
    if (last) return last.id
  }
  return state.focusedSessionId
}

