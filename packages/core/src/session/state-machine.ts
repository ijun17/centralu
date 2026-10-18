import type { SessionState } from '@cc/protocol'

/**
 * The session state machine (product-spec FR-12).
 * The UI does not infer state with if statements — every transition goes through here.
 *
 * The table and the event rules live in `@cc/protocol` (session-state.ts) because the host keeps the same state
 * for reconnects and swaps and may not import core; they are re-exported here under their old names.
 */
export {
  isWaiting,
  isInTurn,
  canTransition,
  nextStateFor,
  transition,
  stepSessionState,
  type TransitionResult,
  type SessionStateFacts,
  type SessionStateStep,
} from '@cc/protocol'

/** Urgency: what the inbox order and the notification policy are based on. Lower is more urgent. */
export const URGENCY: Record<SessionState, number> = {
  waiting_approval: 0, // The agent is blocked — nothing happens unless I press something
  error: 1,
  waiting_input: 2, // The turn has ended — not urgent
  limited: 3,
  working: 9,
  idle: 9,
}

/**
 * Whether the session is waiting on an answer from the person: an approval card, or a question card it asked. The
 * sidebar's marks, the look of a panel and a folded group's alert all ask this, so they cannot disagree (#428). An
 * error or a finished turn is not one: it needs a look, not an answer.
 */
export function needsAnswer(s: { state: SessionState; pendingQuestions: { readonly length: number } }): boolean {
  return s.state === 'waiting_approval' || s.pendingQuestions.length > 0
}

/**
 * The state a session is listed, counted and drawn under. An open question is listed as an approval is (owner,
 * 2026-10-18): the inbox, its counters and a folded project's line all keep it until it is answered, whatever else the
 * session is doing. An error keeps its own place: it outranks the question.
 */
export function listedState(s: { state: SessionState; pendingQuestions: { readonly length: number } }): SessionState {
  return s.state !== 'error' && s.pendingQuestions.length > 0 ? 'waiting_approval' : s.state
}
