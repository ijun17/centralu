import { needsAnswer, type SessionState } from '@cc/protocol/client'

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
  needsAnswer,
  canTransition,
  nextStateFor,
  transition,
  stepSessionState,
  type TransitionResult,
  type SessionStateFacts,
  type SessionStateStep,
} from '@cc/protocol/client'

/**
 * The state a session is listed, counted and drawn under. A card the person answers (`needsAnswer`: an approval, or an open
 * question, owner 2026-10-18) is listed as an approval: the inbox, its counters and a folded project's line all keep it until
 * it is answered, whatever else the session is doing. An error keeps its own place: it outranks the card.
 */
export function listedState(s: { state: SessionState; pendingQuestions: { readonly length: number }; pendingApproval?: unknown }): SessionState {
  return s.state !== 'error' && needsAnswer(s) ? 'waiting_approval' : s.state
}
