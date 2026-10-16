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
