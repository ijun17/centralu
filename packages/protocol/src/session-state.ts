import type { SessionInfo } from './commands.js'
import type { SessionState } from './entities.js'
import type { NormalizedEvent } from './events.js'

/**
 * The session state machine (product-spec FR-12), shared by both sides.
 *
 * The UI's reducer (core `applyEvent`) holds the live state; the host keeps the same state for a reconnecting
 * window and for the next host after a swap (`SessionInfo.state`, `waitingSince`, the open cards). The host
 * used to keep a hand-copied table of its own, and the copy drifted (#428): a question did not block the
 * session, a `turn_complete` in idle was taken, a limit came down on every hint. A window that reconnected was
 * then shown a different state from the one it had been showing live. Both sides now run these rules; they are
 * pure and live here because the host may not import core (docs/architecture.md §2).
 */

/** Whether the state is waiting for the user to step in (what the inbox holds) */
export function isWaiting(state: SessionState): boolean {
  return state === 'waiting_approval' || state === 'waiting_input' || state === 'error'
}

/**
 * In a turn: producing an answer or blocked on a card inside it. Anything else (awaiting input, idle, limit hit,
 * error) means the turn is over (C-4). Takes a raw value too, since a linked machine's event is read before it is
 * parsed (`state` is then whatever that machine sent).
 */
export function isInTurn(state: unknown): boolean {
  return state === 'working' || state === 'waiting_approval'
}

/** The legal transitions in the FR-12 table. Anything not here is illegal. */
const ALLOWED: Record<SessionState, readonly SessionState[]> = {
  idle: ['working', 'error'],
  working: ['waiting_approval', 'waiting_input', 'limited', 'error', 'idle'],
  /*
   * waiting_approval → waiting_input: the path where an interrupt ends the turn while approval is waiting.
   * Without this transition, a session stopped with its approval card ignored is stuck in waiting_approval
   * forever.
   *
   * waiting_approval → limited: a card the host raised between turns (#673) closes back into the rest the
   * session had before it (`restAfterCard`, host-cards.ts), and limited is one of those rests. Refused, the
   * card's own resolve then read as "back to work" and the session sat in working with nothing to end it.
   */
  waiting_approval: ['working', 'waiting_input', 'limited', 'error', 'idle'],
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
  /*
   * A resolve only means "back to work" for a session that was blocked on a card. The host sends resolves late:
   * a handle being disposed (a swap, a crash) releases every request still in its map, and the manager passes
   * those through even from a set-aside handle so the card comes down; a request the CLI itself cancelled stays
   * in that map until then. Arriving after the turn ended (waiting_input), an error or a return to idle, it used
   * to flip the session to working with nothing left to ever end it, and in error it also cleared the banner.
   * Outside waiting_approval it is not a state change, and not illegal either: the reducer still removes the card.
   */
  if ((event.type === 'approval_resolved' || event.type === 'question_resolved') && from !== 'waiting_approval') {
    return { state: from, illegal: false }
  }
  if (!canTransition(from, to)) return { state: from, illegal: true }
  return { state: to, illegal: false }
}

/** What the state rules read of a session: the UI's summary and the host's `SessionInfo` both carry it */
export type SessionStateFacts = {
  state: SessionState
  waitingSince: number | null
  pendingApproval: { requestId: string } | null
  pendingQuestions: readonly { requestId: string }[]
}

/** What one event does to a session's state, and what that change takes down with it */
export type SessionStateStep = {
  state: SessionState
  illegal: boolean
  /** The state is different from before */
  changed: boolean
  /** When the current wait began (what the inbox order and the elapsed time are based on); null when not waiting */
  waitingSince: number | null
  /** The session recovered: the limit and error banners come down */
  recovered: boolean
  /** The open approval and question cards died with this change */
  cardsDead: boolean
}

/**
 * One event's effect on a session's state — the part of the reducer both sides run.
 * `now` is taken as an argument because recording when a wait started has to be testable.
 */
export function stepSessionState(s: SessionStateFacts, event: NormalizedEvent, now: number): SessionStateStep {
  /*
   * Answering one card while another is still open (an approval and a question, or two questions) leaves the agent
   * blocked on the other: the session stays waiting_approval and keeps that card. Taken as a transition to working,
   * the recovery rule below cleared every card, so an unanswered question vanished when an approval next to it was
   * answered, and the agent sat waiting on a question nobody could see. The host does the same (manager.ts
   * `respondApproval`: working again only when no card is left).
   */
  const { state, illegal } = otherCardOpen(s, event) ? { state: s.state, illegal: false } : transition(s.state, event)
  const changed = state !== s.state

  // Record when the wait began (what the inbox order and the elapsed time are based on)
  const waitingSince = isWaiting(state) ? (isWaiting(s.state) && s.waitingSince != null ? s.waitingSince : now) : null

  /*
   * When the session recovers, the banners come down with it.
   *
   * limit and lastError are what the "blocked right now" banner stands on. If they stayed after the limit
   * lifted, or after the session came back from an error and started working again, the screen would go on
   * claiming it is blocked, which is a lie — entering working or idle is itself recovery, so they are
   * cleared at that moment.
   */
  const recovered = !illegal && changed && (state === 'working' || state === 'idle')
  /*
   * Approval and question cards live **only while they can be answered**.
   *
   * error is not the only way a requestId dies: an interrupt while waiting for approval (turn_complete →
   * waiting_input), a return to idle through resume, and working resuming all finish that request off too.
   * Leave the card up and a click tries to answer a dead request and throws — the state (visibility) and the
   * payload (whether it can be acted on) must not drift apart. If the request is still valid after recovery,
   * the host sends it again, and `transition` lets an approval or question request through from any state, so
   * the card comes back. A new request is set up again by the reducer's own switch, on top of this clearing.
   */
  const cardsDead =
    !illegal &&
    changed &&
    (state === 'error' || recovered || (s.state === 'waiting_approval' && state === 'waiting_input'))
  return { state, illegal, changed, waitingSince: illegal ? s.waitingSince : waitingSince, recovered, cardsDead }
}

/**
 * The host's copy of a session's live state, for a reconnecting window and for the next host after a swap
 * (`SessionInfo`): the host's `applyStateHint` (agent-host sessions/manager.ts) and the mock's list run this.
 *
 * Authority over the live state belongs to the UI (the core reducer); the host records what it needs to restore
 * (M1.5) and nothing more. It runs **the same rules** (`stepSessionState`), not a table of its own: the hand-copied
 * one drifted (#428), and a window that reconnected was shown a state it had not been showing live (a question that
 * did not block, a `turn_complete` in idle that did, a limit dropped mid-turn). The mock had a third copy, in which
 * a question left the session waiting_input.
 *
 * The clearing follows the core reducer (docs/state-management.md §2): a kind of busy never outlives being busy,
 * recovering removes the limit banner, and a card for a requestId that has died (ended by an error, an interrupt, or
 * recovery) is torn down too, since clicking it would have nowhere to answer — a reconnect restore must never bring
 * a dead card back to life. The event's own facts (a new card, an activity, a limit) are set after that, as the
 * reducer's switch sets them on top of its clearing.
 */
export function applySessionState(m: SessionInfo, e: NormalizedEvent, now: number): void {
  const step = stepSessionState(m, e, now)
  if (!step.illegal) {
    m.state = step.state
    m.waitingSince = step.waitingSince
    if (step.state !== 'working') m.activity = null
    if (step.recovered) m.limit = null
    if (step.cardsDead) {
      m.pendingApproval = null
      m.pendingQuestions = []
    }
  }
  switch (e.type) {
    case 'approval_request':
      m.pendingApproval = { requestId: e.requestId, detail: e.detail }
      break
    case 'approval_resolved':
      if (m.pendingApproval?.requestId === e.requestId) m.pendingApproval = null
      break
    case 'question_request':
      // The same id arriving again replaces its entry; otherwise it is added at the end (never overwritten)
      m.pendingQuestions = [
        ...m.pendingQuestions.filter((q) => q.requestId !== e.requestId),
        { requestId: e.requestId, questions: e.questions },
      ]
      break
    case 'question_resolved':
      m.pendingQuestions = m.pendingQuestions.filter((q) => q.requestId !== e.requestId)
      break
    case 'activity':
      m.activity = e.activity
      break
    case 'limit_reached':
      m.limit = { resumeAt: e.resumeAt, usedPercent: e.usedPercent, windowMins: e.windowMins }
      break
  }
}

/** Whether a resolve leaves some other approval or question card of a waiting session still open */
function otherCardOpen(s: SessionStateFacts, event: NormalizedEvent): boolean {
  if (s.state !== 'waiting_approval') return false
  if (event.type === 'approval_resolved') {
    return (s.pendingApproval !== null && s.pendingApproval.requestId !== event.requestId) || s.pendingQuestions.length > 0
  }
  if (event.type === 'question_resolved') {
    return s.pendingApproval !== null || s.pendingQuestions.some((q) => q.requestId !== event.requestId)
  }
  return false
}
