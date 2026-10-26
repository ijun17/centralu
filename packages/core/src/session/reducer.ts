import { applyBackgroundTasks, nextContext, toolCallLine } from '@cc/protocol'
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
} from '@cc/protocol'
import { stepSessionState } from './state-machine.js'

/**
 * A session's summary state (docs/state-management.md §2).
 * Even a session that is not focused keeps this much — message bodies are not here (§4 windowing).
 */
export type SessionSummary = {
  id: string
  /** Null only for the central orchestrator: a session that spans projects belongs to none of them */
  projectId: string | null
  /**
   * Whether this is a worker or an orchestrator (#13). The six places that used to decide it from projectId
   * were gathered into this one field. The orchestrator that belongs to a project (#13) has since been
   * dropped, but deciding it in one place is still better.
   */
  kind: 'worker' | 'orchestrator' | 'coordinator'
  /**
   * The tool this session uses.
   *
   * It can differ from the project's default tool, because one project can mix claude sessions and codex
   * sessions. Falling back to the project default when this is missing makes the header and the usage point
   * at the wrong tool (dogfooding: two sessions with similar titles were taken to be on the wrong tool).
   */
  tool: ToolName
  name: string
  autoNamed: boolean
  state: SessionState
  /**
   * While busy, what it is busy doing (this refines state; it does not replace it).
   * Null means it is simply waiting for the reply.
   */
  activity: SessionActivity | null
  waitingSince: number | null
  lastSeq: number
  lastReadSeq: number
  /**
   * Whether the process is alive (FR-10).
   * Restarting the host keeps the transcript but the process is gone — the UI has to know that state to be
   * able to suggest "resume". The worst thing is to let someone talk to a dead session and leave them
   * waiting.
   */
  live: boolean
  /** The one-line preview in the sidebar and the inbox */
  preview: string
  pendingApproval: { requestId: string; detail: ApprovalDetail } | null
  /**
   * The choices waiting for an answer (AskUserQuestion).
   *
   * **It is a list.** Approval is a single field, so a second request overwrote the first and left no way
   * to answer it — that mistake is not repeated here. Up to four questions arrive at once on one card, and
   * several cards can be stacked up.
   */
  pendingQuestions: { requestId: string; questions: Question[] }[]
  usage: TokenUsage | null
  context: { used: number; window: number; exactness: 'exact' | 'estimate' } | null
  limit: { resumeAt?: string; usedPercent?: number; windowMins?: number } | null
  lastError: { code: string; message: string } | null
  /** For detecting file conflicts between concurrent sessions (FR-2) */
  touchedPaths: string[]
  /** Changed from the session header (FR-7) */
  model: string | null
  /** Reasoning effort. Null for a model that does not support it (the levels differ from model to model) */
  effort: string | null
  /** Response length (#54). Support is stated in the adapter's capability declaration (verbosities) */
  verbosity: string | null
  /** Response speed (codex's service_tier). The model list (ModelOption.tiers) names the supported tiers */
  serviceTier: string | null
  permissionPreset: PermissionPreset
  /**
   * The worktree this session runs in (an FR-2 option). Null means it runs directly in the project directory.
   * The screen has to know this, or the person is left asking "why aren't the files in the project folder
   * changing?".
   */
  worktree: { path: string; branch: string } | null
  /**
   * The manager session this session hangs under (#69). Null means top level.
   * The sidebar tree is drawn from this one field — a manager is an ordinary session that has children.
   */
  parentSessionId: string | null
  /**
   * All the work on this worktree's branch has made it into the project's trunk (#69).
   * It is drawn as a single badge. Squash and rebase merges cannot be detected locally (measured), so this
   * can stay false — what a miss costs is a badge, not data.
   */
  merged: boolean
  /**
   * This branch's pull request (#76 stage 3). A derived fact measured with gh — it sees the endings that
   * `merged` cannot see locally, such as a squash merge. Null means "unknown" (including no gh, and offline).
   */
  pr: { number: number; state: 'open' | 'merged' | 'closed'; url: string } | null
  /**
   * The goal set on the session (2026-09-07 — claude /goal · codex thread/goal/*). It is a live fact that the
   * tool judges, so null means "there is none, or it is not known yet". It is only what the badge stands on;
   * the judging belongs to the tool.
   */
  goal: SessionGoal | null
  /**
   * The agent's background work (#290): every running task, then the ended ones still listed with how they ended.
   * Moved only by `background_tasks` events, through the same `applyBackgroundTasks` the host runs.
   */
  backgroundTasks: BackgroundTask[]
  /**
   * The version of the agent CLI this session's process runs (#297), or null when unknown. Compared with the installed
   * one (the store's `agentVersions`) to say the session runs an older CLI. Only meaningful while `live`.
   */
  agentVersion: string | null
  /**
   * The running total of the estimated tokens the model spent thinking in this turn (#58 — claude's thinking
   * text is encrypted, so this number is all there is to show). Same lifetime as activity: it dies when the
   * session leaves working.
   */
  thinkingTokens: number | null
  /**
   * The current snapshot of the plan the agent has made (#58 — codex turn/plan/updated).
   * Same lifetime as activity: it only shows progress, so it dies when the session leaves working.
   */
  plan: { text: string; status: 'pending' | 'inProgress' | 'completed' }[] | null
  /**
   * A session on a linked computer started this one (#1273, `SessionInfo.startedFromHub`): its row and header show its
   * preset. Absent from a host that predates it.
   */
  startedFromHub?: boolean
  /**
   * The app that created this session (#81). Null means it has no owner — then the sidebar takes it.
   * All the core knows is a single id; only the app knows what it means.
   */
  appId: string | null
  /**
   * The session in another project that asked for this one through ask_project (#371 part B), or null. The header
   * says "asked by" and links back; the caller's conversation finds its delegated session by this.
   */
  askedBy?: string | null
  /**
   * The session this one was forked from (#677): another session asked a busy one for work and chose a copy of its
   * conversation. The sidebar hangs it under that session, ahead of who asked for it.
   */
  forkedFrom?: string | null
  /**
   * The linked machine this session runs on (#82, docs/plans/remote-hub.md), or null/absent for this computer. Its id
   * then reads `<machine>.<id>`; nothing parses that, everything groups and labels by this field.
   */
  machine?: string | null
  /**
   * The hub could not reach the machine and listed this session from what it last heard (#82): `live` is the last-known
   * value, not a fact. While its machine is away such a session is shown as away and never woken, and that machine's
   * `machine_resync` replaces it. The mark is about the answer, not the machine (#1611): `isAway` reads the machine's status.
   */
  unreachable?: boolean
  /**
   * Why the last turn did not run to its end (#698): the network, a quit, an interrupt nobody here asked for, or a tool
   * reconnecting for too long. The host decides it (`SessionInfo.interruption`, the `interruption` event); the inbox
   * and the sidebar show it beside the state, which alone cannot tell a stopped turn from a finished one.
   */
  interruption?: Interruption | null
}

export function initialSession(init: Pick<SessionSummary, 'id' | 'projectId' | 'name' | 'tool'> & Partial<SessionSummary>): SessionSummary {
  return {
    autoNamed: true, state: 'idle', activity: null, waitingSince: null, lastSeq: 0, lastReadSeq: 0,
    live: true, preview: '', pendingApproval: null, pendingQuestions: [], usage: null, context: null,
    limit: null, lastError: null, touchedPaths: [], model: null, effort: null, verbosity: null, serviceTier: null,
    permissionPreset: 'normal', worktree: null, parentSessionId: null, merged: false, pr: null, goal: null, backgroundTasks: [], agentVersion: null, thinkingTokens: null, plan: null, kind: 'worker' as const,
    appId: null,
    ...init,
  }
}

const PREVIEW_MAX = 80
const truncate = (s: string) => (s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '…' : s)

/**
 * The only place the state changes. A pure function — the same input gives the same output.
 * `now` is taken as an argument because recording when a wait started has to be testable.
 */
export function applyEvent(s: SessionSummary, event: NormalizedEvent, now: number): SessionSummary {
  /*
   * The state, when the wait began, and what the change takes down with it: the rules both sides run
   * (`stepSessionState`, protocol session-state.ts), so the state the host keeps for a reconnect is the one shown here.
   */
  const { state, illegal, changed: stateChanged, waitingSince, recovered, cardsDead } = stepSessionState(s, event, now)

  /*
   * What it is busy with cannot outlive its being busy.
   *
   * If the process dies or the turn ends in the middle of compacting, the tool never sends the "done" signal.
   * If activity were still set then, the screen would claim "Compacting" forever, which is a lie —
   * so it is cleared along with it the moment the session leaves working.
   */
  const activity = event.type === 'activity' ? event.activity : state === 'working' ? s.activity : null

  // The amount of thinking cannot outlive being busy either (the same rule as activity)
  const thinkingTokens =
    event.type === 'reasoning_delta' && event.estTokens ? (s.thinkingTokens ?? 0) + event.estTokens
    : state === 'working' ? s.thinkingTokens
    : null

  // The plan cannot outlive being busy either (#58 — the same rule: left behind, a finished turn's plan lies)
  const plan =
    event.type === 'plan_update' ? event.steps
    : state === 'working' ? s.plan
    : null

  const next: SessionSummary = illegal
    ? { ...s }
    : {
        ...s, state, waitingSince, activity, thinkingTokens, plan,
        ...(recovered ? { limit: null, lastError: null } : {}),
        // A new turn is the end of whatever stopped the last one; the host says so too, a moment later (#698)
        ...(stateChanged && state === 'working' ? { interruption: null } : {}),
        ...(cardsDead ? { pendingApproval: null, pendingQuestions: [] } : {}),
      }

  switch (event.type) {
    case 'message_delta':
      return { ...next, preview: truncate((s.state === 'working' ? s.preview : '') + event.text) }
    case 'tool_call':
      return { ...next, preview: truncate(toolCallLine(event.summary)) }
    case 'question_request':
      // The same id arriving again replaces its entry; otherwise it is added at the end (never overwritten)
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
    /*
     * The tool's reading at a turn's end. A fresh conversation inside the session (#304, Claude Code's /clear) empties
     * it: "unknown" until the tool reports the new one, the same as a session with no turn yet. A compaction that says
     * its size moves it there (#1282). The host and the mock run the same rule (`nextContext`, protocol session-state.ts).
     */
    case 'context_update':
    case 'conversation_reset':
    case 'compaction':
      return { ...next, context: nextContext(s.context, event) }
    case 'limit_reached':
      return {
        ...next,
        limit: { resumeAt: event.resumeAt, usedPercent: event.usedPercent, windowMins: event.windowMins },
      }
    /*
     * An automatic name does not overwrite a name the person gave (FR-18, issue #5).
     *
     * The point is that the decision rests on the **event**. It used to be decided by looking only at this
     * side's own autoNamed, and then the second name the person gave never reached the other screens —
     * autoNamed had already been turned off there, so the whole event was thrown away.
     *
     * A missing `auto` **counts as automatic** — the same decision as the schema's default. Written as
     * `!event.auto`, an event built by hand without going through the parser (a frame from an old version, a
     * test fixture) would have its undefined flipped into "the person chose it".
     */
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
    // The process went to sleep or came back (#568), whoever caused it
    case 'session_live':
      return { ...next, live: event.live }
    case 'session_title':
      if (event.auto !== false) return s.autoNamed ? { ...next, name: event.title } : next
      return { ...next, name: event.title, autoNamed: false }
    case 'files_touched':
      return { ...next, touchedPaths: [...new Set([...s.touchedPaths, ...event.paths])] }
    case 'error':
      return { ...next, lastError: { code: event.error.code, message: event.error.message } }
    case 'turn_complete':
    case 'state_change': // Banners on recovery (leaving limited, say) are all cleared by recovered above
      return next
    default:
      return next
  }
}

/** Advances seq when a message is stored (what read/unread is based on) */
export function bumpSeq(s: SessionSummary, seq: number): SessionSummary {
  return seq > s.lastSeq ? { ...s, lastSeq: seq } : s
}

export function markRead(s: SessionSummary, seq: number): SessionSummary {
  return { ...s, lastReadSeq: Math.max(s.lastReadSeq, seq) }
}

export function rename(s: SessionSummary, name: string): SessionSummary {
  return { ...s, name, autoNamed: false }
}

/** Concurrent sessions in the same directory that touched the same file (FR-2 data-loss warning) */
export function detectFileConflicts(sessions: readonly SessionSummary[]): { path: string; sessionIds: string[] }[] {
  const byPath = new Map<string, string[]>()
  for (const s of sessions) {
    for (const p of s.touchedPaths) byPath.set(p, [...(byPath.get(p) ?? []), s.id])
  }
  return [...byPath.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([path, sessionIds]) => ({ path, sessionIds }))
}
