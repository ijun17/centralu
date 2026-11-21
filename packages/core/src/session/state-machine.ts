import { needsAnswer, type SessionState } from '@cc/protocol/client'

/**
 * The session state machine (FR-12; docs/domain-model.md §3). It lives in `@cc/protocol` because the host keeps the
 * same state for reconnects and may not import core.
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

/** A card the person answers (approval or open question) is listed as an approval until answered; an error outranks it */
export function listedState(s: { state: SessionState; pendingQuestions: { readonly length: number }; pendingApproval?: unknown }): SessionState {
  return s.state !== 'error' && needsAnswer(s) ? 'waiting_approval' : s.state
}
