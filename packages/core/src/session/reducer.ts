import { applyBackgroundTasks, nextContext, toolCallLine } from '@cc/protocol/client'
import type {
  BackgroundTask,
  Interruption,
  ToolName,
  ApprovalDetail,
  NormalizedEvent,
  PermissionPreset,
  Question,
  SessionActivity,
  SessionGoal,
  SessionState,
  TokenUsage,
} from '@cc/protocol/client'
import { stepSessionState } from './state-machine.js'

/** A session's summary, kept even when not focused; message bodies are windowed (docs/state-management.md §2, §4) */
export type SessionSummary = {
  id: string
  /** Null only for the Assistant: a session that spans projects belongs to none of them */
  projectId: string | null
  /** Decided here once rather than from projectId wherever it is asked (#13) */
  kind: 'worker' | 'orchestrator' | 'coordinator' | 'assistant'
  /** Can differ from the project's default tool: one project mixes claude and codex sessions */
  tool: ToolName
  name: string
  autoNamed: boolean
  state: SessionState
  /** Refines `working`; null means simply waiting for the reply */
  activity: SessionActivity | null
  waitingSince: number | null
  lastSeq: number
  lastReadSeq: number
  /** Whether the process is alive (FR-10): a host restart keeps the transcript, and the UI offers "resume" */
  live: boolean
  preview: string
  pendingApproval: { requestId: string; detail: ApprovalDetail } | null
  /** A list, unlike pendingApproval, so a second request cannot overwrite the first; a card holds up to four questions */
  pendingQuestions: { requestId: string; questions: Question[] }[]
  usage: TokenUsage | null
  context: { used: number; window: number; exactness: 'exact' | 'estimate' } | null
  /** `credits`: a credits or spend limit, which no time resets (the host's `SessionInfo.limit` says the same) */
  limit: { resumeAt?: string; usedPercent?: number; windowMins?: number; credits?: boolean } | null
  lastError: { code: string; message: string } | null
  /** As its events reported them (FR-2) */
  touchedPaths: string[]
  model: string | null
  /** Null for a model without reasoning effort; the levels differ per model */
  effort: string | null
  /** Response length (#54); the adapter's `verbosities` capability says which are supported */
  verbosity: string | null
  /** codex's service_tier; ModelOption.tiers names the supported ones */
  serviceTier: string | null
  permissionPreset: PermissionPreset
  /** Null: runs directly in the project directory (FR-2) */
  worktree: { path: string; branch: string } | null
  /** The sidebar tree is drawn from this one field (#69); null is top level */
  parentSessionId: string | null
  /** The branch's work is in the trunk (#69). Squash and rebase merges cannot be detected locally (measured): may stay false */
  merged: boolean
  /** From gh (#76), so it sees a squash merge `merged` cannot; null is unknown (no gh, offline) */
  pr: { number: number; state: 'open' | 'merged' | 'closed'; url: string } | null
  /** claude /goal, codex thread/goal/*; the tool judges it. Null: none, or not known yet */
  goal: SessionGoal | null
  /** Running tasks, then ended ones still listed (#290); moved only through `applyBackgroundTasks`, as the host does */
  backgroundTasks: BackgroundTask[]
  /** Compared with the store's `agentVersions` to say the session runs an older CLI (#297); meaningful only while `live` */
  agentVersion: string | null
  /** Estimated thinking tokens this turn: claude's thinking text is encrypted, so this is all there is to show (#58) */
  thinkingTokens: number | null
  /** codex turn/plan/updated (#58) */
  plan: { text: string; status: 'pending' | 'inProgress' | 'completed' }[] | null
  /** A session on a linked computer started this one (#1273): its row and header show its preset */
  startedFromHub?: boolean
  /** The app that created this session (#81); null: the sidebar owns it */
  appId: string | null
  /** The session that asked for this one through ask_project (#371) */
  askedBy?: string | null
  /** Forked from a busy session asked for work (#677); the sidebar hangs it there, ahead of who asked */
  forkedFrom?: string | null
  /** Null/absent: this computer (#82). The id then reads `<machine>.<id>`; nothing parses it, everything reads this field */
  machine?: string | null
  /**
   * Listed from what the hub last heard (#82): `live` is not a fact, the session is never woken, `machine_resync`
   * replaces it. It marks the answer, not the machine (#1611): `isAway` reads the machine's status.
   */
  unreachable?: boolean
  /** Decided by the host (#698); the state alone cannot tell a stopped turn from a finished one */
  interruption?: Interruption | null
  /**
   * Its launch demands role text (`roleTextDemanded`, read from the host's row). Held rather than a selector
   * (docs/state-management.md §3) because its input, `SessionInfo.roleAppend`, is not kept in the store
   */
  roleText: boolean
}

export function initialSession(init: Pick<SessionSummary, 'id' | 'projectId' | 'name' | 'tool'> & Partial<SessionSummary>): SessionSummary {
  return {
    autoNamed: true, state: 'idle', activity: null, waitingSince: null, lastSeq: 0, lastReadSeq: 0,
    live: true, preview: '', pendingApproval: null, pendingQuestions: [], usage: null, context: null,
    limit: null, lastError: null, touchedPaths: [], model: null, effort: null, verbosity: null, serviceTier: null,
    permissionPreset: 'normal', worktree: null, parentSessionId: null, merged: false, pr: null, goal: null, backgroundTasks: [], agentVersion: null, thinkingTokens: null, plan: null, kind: 'worker' as const,
    appId: null, roleText: false,
    ...init,
  }
}

const PREVIEW_MAX = 80
const truncate = (s: string) => (s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '…' : s)

/** The only place the state changes; `now` is an argument so when a wait started is testable */
export function applyEvent(s: SessionSummary, event: NormalizedEvent, now: number): SessionSummary {
  // The rules the host runs too, so the state it keeps for a reconnect is the one shown here
  const { state, illegal, changed: stateChanged, waitingSince, recovered, cardsDead } = stepSessionState(s, event, now)

  // Activity, thinking and plan die with `working`: a turn ending mid-compaction never sends the "done" signal
  const activity = event.type === 'activity' ? event.activity : state === 'working' ? s.activity : null

  const thinkingTokens =
    event.type === 'reasoning_delta' && event.estTokens ? (s.thinkingTokens ?? 0) + event.estTokens
    : state === 'working' ? s.thinkingTokens
    : null

  const plan =
    event.type === 'plan_update' ? event.steps
    : state === 'working' ? s.plan
    : null

  const next: SessionSummary = illegal
    ? { ...s }
    : {
        ...s, state, waitingSince, activity, thinkingTokens, plan,
        ...(recovered ? { limit: null, lastError: null } : {}),
        // The host clears it too, a moment later (#698)
        ...(stateChanged && state === 'working' ? { interruption: null } : {}),
        ...(cardsDead ? { pendingApproval: null, pendingQuestions: [] } : {}),
      }

  switch (event.type) {
    case 'message_delta':
      return { ...next, preview: truncate((s.state === 'working' ? s.preview : '') + event.text) }
    case 'tool_call':
      return { ...next, preview: truncate(toolCallLine(event.summary)) }
    case 'question_request':
      // The same id again replaces its entry
      return {
        ...next,
        pendingQuestions: [
          ...s.pendingQuestions.filter((q) => q.requestId !== event.requestId),
          { requestId: event.requestId, questions: event.questions },
        ],
      }
    case 'question_resolved':
      return { ...next, pendingQuestions: s.pendingQuestions.filter((q) => q.requestId !== event.requestId) }
    case 'approval_request':
      return { ...next, pendingApproval: { requestId: event.requestId, detail: event.detail } }
    case 'approval_resolved':
      return {
        ...next,
        pendingApproval: s.pendingApproval?.requestId === event.requestId ? null : s.pendingApproval,
      }
    case 'usage_update':
      return { ...next, usage: event.tokens }
    // /clear (#304) empties it to unknown; a compaction that says its size moves it (#1282)
    case 'context_update':
    case 'conversation_reset':
    case 'compaction':
      return { ...next, context: nextContext(s.context, event) }
    case 'limit_reached':
      return {
        ...next,
        limit: { resumeAt: event.resumeAt, usedPercent: event.usedPercent, windowMins: event.windowMins, ...(event.credits ? { credits: true } : {}) },
      }
    case 'worktree_merged':
      return { ...next, merged: true }
    case 'worktree_pr':
      return { ...next, pr: event.pr }
    case 'goal':
      return { ...next, goal: event.goal }
    case 'background_tasks':
      return { ...next, backgroundTasks: applyBackgroundTasks(s.backgroundTasks, event) }
    case 'agent_version':
      return { ...next, agentVersion: event.version }
    case 'interruption':
      return { ...next, interruption: event.interruption }
    case 'session_live':
      return { ...next, live: event.live }
    /*
     * An automatic name never overwrites a given one (FR-18). Decided from the event, not autoNamed alone, or a second
     * given name never reaches other screens. A missing `auto` is automatic, as the schema's default; `!event.auto`
     * would turn an unparsed event's undefined into "the person chose it".
     */
    case 'session_title':
      if (event.auto !== false) return s.autoNamed ? { ...next, name: event.title } : next
      return { ...next, name: event.title, autoNamed: false }
    case 'files_touched':
      return { ...next, touchedPaths: [...new Set([...s.touchedPaths, ...event.paths])] }
    case 'error':
      return { ...next, lastError: { code: event.error.code, message: event.error.message } }
    case 'turn_complete':
    case 'state_change': // `recovered` above clears the banners
      return next
    default:
      return next
  }
}

export function bumpSeq(s: SessionSummary, seq: number): SessionSummary {
  return seq > s.lastSeq ? { ...s, lastSeq: seq } : s
}

export function markRead(s: SessionSummary, seq: number): SessionSummary {
  return { ...s, lastReadSeq: Math.max(s.lastReadSeq, seq) }
}

export function rename(s: SessionSummary, name: string): SessionSummary {
  return { ...s, name, autoNamed: false }
}
