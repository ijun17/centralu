import type { NormalizedEvent, SessionState } from '@cc/protocol'

/**
 * The session state machine (product-spec FR-12).
 * The UI does not infer state with if statements — every transition goes through here.
 */

/** Urgency: what the inbox order and the notification policy are based on. Lower is more urgent. */
export const URGENCY: Record<SessionState, number> = {
  waiting_approval: 0, // The agent is blocked — nothing happens unless I press something
  error: 1,
  waiting_input: 2, // The turn has ended — not urgent
  limited: 3,
  working: 9,
  idle: 9,
}

/** Whether the state is waiting for the user to step in (what the inbox holds) */
export function isWaiting(state: SessionState): boolean {
  return state === 'waiting_approval' || state === 'waiting_input' || state === 'error'
}

/** The legal transitions in the FR-12 table. Anything not here is illegal. */
const ALLOWED: Record<SessionState, readonly SessionState[]> = {
  idle: ['working', 'error'],
  working: ['waiting_approval', 'waiting_input', 'limited', 'error', 'idle'],
  /*
   * waiting_approval → waiting_input: the path where an interrupt ends the turn while approval is waiting.
   * Without this transition, a session stopped with its approval card ignored is stuck in waiting_approval
   * forever.
   */
  waiting_approval: ['working', 'waiting_input', 'error', 'idle'],
  waiting_input: ['working', 'error', 'idle'],
  limited: ['working', 'idle', 'error'],
  error: ['working', 'idle'],
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return from === to || (ALLOWED[from] ?? []).includes(to)
}

/**
 * The next state an event implies. Null means no change of state.
 * A state_change event was sent explicitly by the adapter, so it is followed as is.
 */
export function nextStateFor(event: NormalizedEvent): SessionState | null {
  switch (event.type) {
    case 'state_change':
      return event.state
    case 'message_delta':
    case 'tool_call':
    case 'tool_result':
      return 'working'
    case 'approval_request':
      return 'waiting_approval'
    case 'approval_resolved':
      return 'working'
    /* A set of choices is waiting on the person too — the status light must not stay on 'running' */
    case 'question_request':
      return 'waiting_approval'
    case 'question_resolved':
      return 'working'
    case 'turn_complete':
      return 'waiting_input'
    case 'limit_reached':
      return 'limited'
    case 'error':
      return 'error'
    default:
      return null
  }
}

export type TransitionResult = {
  state: SessionState
  /** Whether it was ignored as an illegal transition (a warning in dev, a log in prod) */
  illegal: boolean
}

export function transition(from: SessionState, event: NormalizedEvent): TransitionResult {
  const to = nextStateFor(event)
  if (to === null) return { state: from, illegal: false }
  /*
   * An approval or question request is not an inference but a fact the host actually sent.
   * If the table swallowed a request that arrived in idle right after a resume, the inbox and the badge would
   * never see it and the agent would be blocked forever — the table filters only inferred transitions such
   * as state_change.
   */
  if (event.type === 'approval_request' || event.type === 'question_request') return { state: to, illegal: false }
  if (!canTransition(from, to)) return { state: from, illegal: true }
  return { state: to, illegal: false }
}
