import type { LiveStateFields, SessionInfo } from './commands.js'
import { liveBackgroundTasks, workTasks, type BackgroundTask, type SessionState } from './entities.js'
import type { NormalizedEvent } from './events.js'

// The session state machine (product-spec FR-12, docs/domain-model.md §3). The UI's reducer and the host's copy for a
// reconnecting window run these same rules; they live here because the host may not import core (architecture.md §2).

/** Whether the state is waiting for the user to step in (what the inbox holds) */
export function isWaiting(state: SessionState): boolean {
  return state === 'waiting_approval' || state === 'waiting_input' || state === 'error'
}

/** Takes a raw value: a linked machine's event is read before it is parsed */
export function isInTurn(state: unknown): boolean {
  return state === 'working' || state === 'waiting_approval'
}

/**
 * Its turn ended while its own work (`workTasks`: background commands or the tool's background subagents, not `/loop`
 * timers) still runs; a failed, cut-short or limited turn is shown as that instead. Shown as waiting with a background
 * dot (product-spec.md, the sidebar; #2146).
 */
export function pausedOnBackground(s: { state: unknown; backgroundTasks?: readonly BackgroundTask[]; interruption?: unknown }): boolean {
  return (s.state === 'waiting_input' || s.state === 'idle') && !s.interruption && workTasks(s.backgroundTasks ?? []).length > 0
}

type CardFacts = { state: unknown; pendingApproval?: unknown; pendingQuestions?: { readonly length: number } }

/**
 * An approval or question card is open; every busy check and mark asks this so they agree. `waiting_approval` with no
 * card listed counts: a linked machine's row or a summary does not carry the card.
 */
export function needsAnswer(s: CardFacts): boolean {
  return s.state === 'waiting_approval' || !!s.pendingApproval || (s.pendingQuestions?.length ?? 0) > 0
}

/**
 * The one busy rule (#2158, docs/agent-host/delegation/start-agent.md). A tool's timer counts as busy because it ends
 * with its process; a check that may end one on purpose passes the tasks it counts (worktree cleanup: `workTasks`).
 */
export function atRest(s: CardFacts & { backgroundTasks?: readonly BackgroundTask[] }): boolean {
  return busyWith(s) === null
}

export type BusyReason = 'approval' | 'question' | 'turn' | 'background'

/** `atRest` written out once, so a check that says why it refuses names the part it tested */
export function busyWith(s: CardFacts & { backgroundTasks?: readonly BackgroundTask[] }): BusyReason | null {
  return cardOrTurn(s) ?? (liveBackgroundTasks(s.backgroundTasks ?? []).length > 0 ? 'background' : null)
}

/**
 * `busyWith` without background work, for checks that work does not hold off: mail starts the next turn while it
 * runs, and `stop` of a child's resting work (#718) is how that work ends
 */
export function cardOrTurn(s: CardFacts): Exclude<BusyReason, 'background'> | null {
  if (needsAnswer(s)) return (s.pendingQuestions?.length ?? 0) > 0 && !s.pendingApproval ? 'question' : 'approval'
  return isInTurn(s.state) ? 'turn' : null
}

/** A session's state in the one word an agent reads (#2158); `stopped` is resumed, not deleted */
export type AgentLook = 'waiting' | 'working' | 'paused' | 'stopped' | 'finished'

export function agentLook(s: CardFacts & { backgroundTasks?: readonly BackgroundTask[]; interruption?: unknown }): AgentLook {
  if (needsAnswer(s)) return 'waiting'
  if (isInTurn(s.state)) return 'working'
  if (pausedOnBackground(s)) return 'paused'
  if (s.state === 'error' || s.state === 'limited' || s.interruption) return 'stopped'
  return 'finished'
}

/**
 * A linked machine's session while the hub cannot reach it (docs/state-management.md §7 "An away session is not
 * working"). Its background work is dropped too, or it would stay shown as paused while the machine is gone.
 */
export function unheard<T extends { state?: unknown; backgroundTasks?: unknown }>(row: T): T {
  const working = row.state === 'working'
  const tasks = Array.isArray(row.backgroundTasks) && row.backgroundTasks.length > 0
  if (!working && !tasks) return row
  return { ...row, ...(working ? { state: 'idle' } : {}), ...(tasks ? { backgroundTasks: [] } : {}) }
}

/** The FR-12 table (docs/domain-model.md §3); anything not here is illegal */
const ALLOWED: Record<SessionState, readonly SessionState[]> = {
  idle: ['working', 'error'],
  working: ['waiting_approval', 'waiting_input', 'limited', 'error', 'idle'],
  // → waiting_input: an interrupt while a card waits, or the session stays stuck on it.
  // → limited: only a host card raised between turns closing back into its rest (`restAfterCard`, #673).
  waiting_approval: ['working', 'waiting_input', 'limited', 'error', 'idle'],
  waiting_input: ['working', 'error', 'idle'],
  limited: ['working', 'idle', 'error'],
  error: ['working', 'idle'],
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return from === to || (ALLOWED[from] ?? []).includes(to)
}

/** The next state an event implies; null means no change */
export function nextStateFor(event: NormalizedEvent): SessionState | null {
  switch (event.type) {
    case 'state_change':
      return event.state
    // Output (message_delta, tool_call, tool_result) moves nothing: it also arrives after a turn ended, and read as
    // work it would leave a session working with nothing to end it (docs/domain-model.md §3, #1830).
    case 'approval_request':
      return 'waiting_approval'
    case 'approval_resolved':
      return 'working'
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
  /** Ignored as illegal (a warning in dev, a log in prod) */
  illegal: boolean
}

// The exceptions to `ALLOWED`, as docs/domain-model.md §3 gives them: a request is a fact, applied in any state; a
// resolve arrives late and moves only waiting_approval; a limit leaves a session on its card.
export function transition(from: SessionState, event: NormalizedEvent): TransitionResult {
  const to = nextStateFor(event)
  if (to === null) return { state: from, illegal: false }
  if (event.type === 'approval_request' || event.type === 'question_request')
    return { state: to, illegal: false }
  // Not illegal either: the reducer still removes the card
  if (
    (event.type === 'approval_resolved' || event.type === 'question_resolved') &&
    from !== 'waiting_approval'
  ) {
    return { state: from, illegal: false }
  }
  if (event.type === 'limit_reached' && from === 'waiting_approval') return { state: from, illegal: false }
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

export type SessionStateStep = {
  state: SessionState
  illegal: boolean
  changed: boolean
  /** When the current wait began (the inbox order and elapsed time); null when not waiting */
  waitingSince: number | null
  /** Entering working or idle: the limit and error banners come down */
  recovered: boolean
  /** The open cards' requests died with this change */
  cardsDead: boolean
}

/** One event's effect on a session's state: the part of the reducer both sides run */
export function stepSessionState(
  s: SessionStateFacts,
  event: NormalizedEvent,
  now: number,
): SessionStateStep {
  // Answering one card while another is open keeps waiting_approval and that card (the host's `respondApproval` too)
  const { state, illegal } = otherCardOpen(s, event)
    ? { state: s.state, illegal: false }
    : transition(s.state, event)
  const changed = state !== s.state

  const waitingSince = isWaiting(state)
    ? isWaiting(s.state) && s.waitingSince != null
      ? s.waitingSince
      : now
    : null

  const recovered = !illegal && changed && (state === 'working' || state === 'idle')
  // A card lives only while its request can be answered; one still valid is sent again by the host, which
  // `transition` lets through from any state
  const cardsDead =
    !illegal &&
    changed &&
    (state === 'error' || recovered || (s.state === 'waiting_approval' && state === 'waiting_input'))
  return {
    state,
    illegal,
    changed,
    waitingSince: illegal ? s.waitingSince : waitingSince,
    recovered,
    cardsDead,
  }
}

/**
 * The host's copy of a session's live state (`SessionInfo`) for a reconnecting window and the next host after a swap
 * (docs/domain-model.md §3); a hub's mirror of a linked machine runs it too. Clears as the core reducer does, then sets
 * the event's own facts on top.
 */
export function applySessionState(m: LiveStateFields, e: NormalizedEvent, now: number): SessionStateStep {
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
      m.limit = { resumeAt: e.resumeAt, usedPercent: e.usedPercent, windowMins: e.windowMins, ...(e.credits ? { credits: true } : {}) }
      break
  }
  return step
}

/** Null when no reading has come yet */
export type ContextReading = SessionInfo['context']

/**
 * The one way a context reading moves (host, UI reducer and mock), so a reconnect reads back the gauge shown live.
 * A compaction with a size (Claude's `post_tokens`) sets an estimate at once: the tool's next exact reading comes only
 * at a turn's end, and until then the gauge showed the pre-compaction share (#1282). Codex's compaction has no size.
 */
export function nextContext(context: ContextReading, e: NormalizedEvent): ContextReading {
  switch (e.type) {
    case 'context_update':
      return {
        used: e.used,
        window: e.window,
        exactness: e.exactness,
        ...(e.capped ? { capped: true } : {}),
        ...(e.compactAt !== undefined ? { compactAt: e.compactAt } : {}),
      }
    case 'conversation_reset':
      return null
    case 'compaction':
      if (e.failed || e.after === undefined || !context) return context
      return { ...context, used: e.after, exactness: 'estimate' }
    default:
      return context
  }
}

export type ContextShare = {
  /** Not clamped, so a reading past the window shows */
  fraction: number
  window: number
  /** The window is a floor under the model's, so `fraction` is a ceiling over the real share */
  capped: boolean
  /** Where the process compacts by itself; `fraction` is null when the window is only a floor */
  compactAt: { tokens: number; fraction: number | null } | null
}

/**
 * The one context share (#1553, docs/agent-host/context-compaction.md): used / the model's full window, so the compaction
 * point is a mark on it. Null with no reading or a window of 0 (a model the host could not size).
 */
export function contextShare(context: ContextReading): ContextShare | null {
  if (!context || !(context.window > 0)) return null
  const capped = context.capped === true
  const compactAt =
    context.compactAt !== undefined && context.compactAt > 0
      ? { tokens: context.compactAt, fraction: capped ? null : context.compactAt / context.window }
      : null
  return { fraction: context.used / context.window, window: context.window, capped, compactAt }
}

/** Blocked on a question only (the state says waiting_approval for both kinds), for a text that names the card */
export function blockedOnQuestion(
  s: Pick<SessionInfo, 'state' | 'pendingApproval' | 'pendingQuestions'>,
): boolean {
  return s.state === 'waiting_approval' && !s.pendingApproval && s.pendingQuestions.length > 0
}

function otherCardOpen(s: SessionStateFacts, event: NormalizedEvent): boolean {
  if (s.state !== 'waiting_approval') return false
  if (event.type === 'approval_resolved') {
    return (
      (s.pendingApproval !== null && s.pendingApproval.requestId !== event.requestId) ||
      s.pendingQuestions.length > 0
    )
  }
  if (event.type === 'question_resolved') {
    return s.pendingApproval !== null || s.pendingQuestions.some((q) => q.requestId !== event.requestId)
  }
  return false
}
