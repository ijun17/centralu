import type { WorktreeRecovery } from '../dev-services/worktree-recovery.js'
import type { QueuedRequest } from '../dev-services/store.js'
import type { ChildOwnership } from './child-ownership.js'
import type { AppRef } from '../apps/external/runtime.js'
import type { ToolProfile } from '../apps/contract.js'
import type { AgentRunWait } from './app-agents.js'
import type {
  BackgroundTask,
  ProjectConsentKind,
  ModelOption,
  Attachment,
  CreateSessionParams,
  NormalizedEvent,
  PermissionPreset,
  SessionInfo,
  ToolName,
  UiPreferences,
} from '@cc/protocol'
import type { AgentAdapter, BusyAnswer, BusyChoice, ChildRunResult, RoutedCard, LinkedSessions, SessionHandle } from '../adapters/contract.js'
import type { MemoryGate } from './memory-gate.js'
import type { Store } from '../dev-services/store.js'
import type { HostAsk, HostAskAnswer } from './host-cards.js'

/**
 * What the delegation flow reaches of the session manager (#428), typed as the manager declares each member. The
 * manager builds it with getters for its fields, so each is read when used, never kept.
 */
export type DelegationHost = {
  readonly adapters: Map<string, AgentAdapter>
  readonly agentRuns: Map<string, AgentRunWait>
  answerRoutedCard: (callerId: string, sessionId: string, card: string | undefined, text: string) => Promise<ChildRunResult>
  applyDeferredRestart: (sessionId: string) => void
  askHost: (sessionId: string, detail: HostAsk["detail"], signal?: AbortSignal, card?: { requestId?: string; shown?: boolean; alwaysAsk?: boolean }) => Promise<HostAskAnswer>
  autoBoundaryOpen: (sessionId: string, boundary?: string) => boolean
  builderRefOf: (m: Pick<SessionInfo, "id" | "appId" | "projectId">) => AppRef | null
  busyAnswer: (callerId: string, target: SessionInfo, from: QueuedRequest["via"]) => Extract<BusyAnswer, { state: "busy"; }>
  busyChoices: (callerId: string, target: SessionInfo, from: QueuedRequest["via"]) => BusyChoice[]
  busyForCaller: (callerId: string, sessionId: string) => boolean
  readonly children: ChildOwnership
  cleanUpWorktreeChild: (target: SessionInfo) => Promise<{ ok: true; branch: string; setAside: { changedFiles: number; commits: number; }; warning?: string; note?: string; } | { ok: false; error: string; }>
  createSession: (params: Omit<CreateSessionParams, "projectId" | "tool"> & { projectId: string | null; tool: ToolName | null; kind?: Exclude<SessionInfo["kind"], "coordinator">; roleAppend?: string; appId?: string | null; builderOf?: AppRef; appAgent?: { outputSchema?: Record<string, unknown>; }; askedBy?: string; forkedFrom?: string; lsp?: boolean; onSetupProblems?: (problems: string[]) => void; onWorktreeBase?: (note: string) => void; }) => Promise<SessionInfo>
  cwdFor: (m: SessionInfo) => string
  /** A session as Centralu's word names it to another: as read_session lists it, or its id once it is gone */
  nameOf: (sessionId: string) => string
  /** Tells a session something in its conversation, never while the host leaves, never throwing (`ChildReports.tellSession`, #428) */
  tellSession: (sessionId: string, text: string, from: { sessionId: string; name: string }, relayed: boolean, forModel?: string, opts?: { keep?: boolean; onDelivered?: () => void }) => Promise<boolean>
  /** The seat a session's tools are, which decides the form an answer names a call in (`namedCall`, tool-seats.ts) */
  toolProfileOf: (sessionId: string) => ToolProfile | null
  deliver: (sessionId: string, text: string, attachments: Attachment[] | undefined, from: { sessionId: string; name: string } | undefined, relayed: boolean, fromApp?: undefined, fromAppVia?: 'inline', sendInput?: (handle: SessionHandle, text: string) => void, stillAllowed?: () => string | null, relayedText?: string) => Promise<void>
  readonly disposing: boolean
  readonly emit: (e: NormalizedEvent) => void
  enqueue: (callerId: string, target: SessionInfo, via: QueuedRequest["via"], text: string) => Extract<BusyAnswer, { state: "queued"; }>
  ensureProjectAccess: (callerSessionId: string, toProjectId: string, access: ProjectConsentKind, what: { text: string; app?: { appId: string; name: string; }; session?: { id: string; name: string; }; }, signal?: AbortSignal) => Promise<{ ok: true; } | { ok: false; error: string; }>
  firstTool: (preferred?: ToolName | null) => ToolName | null
  gitTrust: (projectId: string | null) => { trusted: boolean; }
  readonly handingOver: boolean
  readonly handles: Map<string, SessionHandle>
  readonly linkedReader: LinkedSessions | null
  readonly memoryGate: MemoryGate | null
  readonly meta: Map<string, SessionInfo>
  modelsWithin: (tool: ToolName, ms: number, fresh?: boolean) => Promise<{ models: ModelOption[]; cached: boolean; } | null>
  onEvent: (raw: NormalizedEvent, from?: SessionHandle | null) => void
  ownTasksRunning: (sessionId: string) => BackgroundTask[]
  pauseReport: (sessionId: string, running: readonly BackgroundTask[]) => void
  pausedTasksNow: (sessionId: string) => BackgroundTask[]
  queuedOf: (callerId: string, sessionId: string) => ChildRunResult | undefined
  readonly readGrants: Map<string, Set<string>>
  rename: (sessionId: string, name: string) => void
  reportBackIfAwaited: (sessionId: string, ending: NormalizedEvent, answer?: string, settled?: readonly BackgroundTask[]) => Promise<void>
  routedCards: (sessionId: string, callerId: string) => RoutedCard[]
  readonly running: Map<string, { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null; permissionPreset: PermissionPreset; }>
  sleepSession: (sessionId: string) => Promise<boolean>
  stopBackgroundTask: (sessionId: string, taskId: string) => Promise<void>
  readonly store: Store
  trashSession: (sessionId: string, removeWorktree?: boolean, removeExternal?: boolean, recovery?: WorktreeRecovery, fromCleanup?: boolean) => Promise<void>
  readonly trashing: Map<string, Promise<void>>
  readonly turnObservers: Map<string, Set<AgentRunWait>>
  uiPreferences: () => UiPreferences
  untilCard: (sessionId: string, callerId: string) => { asked: Promise<"asked">; done(): void; }
  withdrawHostAsk: (requestId: string) => void
  /** A project's `origin` remote (#1038); null with no repository or no origin */
  projectOrigin: (projectId: string) => Promise<string | null>
  /** A linked machine's session's own background work running there, as the hub last heard it (`LinkedReports`, #723) */
  linkedTasksRunning: (sessionId: string) => BackgroundTask[]
  /** A linked session's turn end the hub missed while the link was down: settled as its `turn_complete` would be (#1038) */
  settleLinkedTurn: (sessionId: string) => void
}
