import type { WorktreeRecovery } from '../dev-services/worktree-recovery.js'
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
import type { AgentAdapter, BusyAnswer, ChildRunResult, RoutedCard, LinkedSessions, SessionHandle } from '../adapters/contract.js'
import type { MemoryGate } from './memory-gate.js'
import type { Store } from '../dev-services/store.js'
import type { HostCards } from './host-cards.js'
import type { RestartPolicy } from './restart-policy.js'
import type { WorktreeSessions } from './worktree-sessions.js'
import type { ProjectFiles } from '../dev-services/project-files.js'
import type { LinkedReports } from './linked-reports.js'

/** The tool a send to another session came through, the task's origin when it goes as mail */
export type SendOrigin = 'agent_session' | 'ask_project' | 'send_to_session'

/** Where a delegation goes (docs/plans/mailbox.md §7.4): a session, a project (null: outside any), the Assistant, or a linked machine's session */
export type DelegationTarget = { sessionId?: string; projectId?: string | null; assistant?: boolean; linked?: boolean }
/** The delegation call as S15 names it: the tool, the target as the sentence names it, and the words given */
export type DelegationCall = { tool: 'start_agent' | 'create_session' | 'agent_session' | 'send_to_session' | 'ask_project'; target: string; text: string }

/**
 * What the delegation flow reaches of the session manager (#428), typed as the manager declares each member. The
 * manager builds it with getters for its fields, so each is read when used, never kept.
 */
export type DelegationHost = {
  readonly adapters: Map<string, AgentAdapter>
  readonly agentRuns: Map<string, AgentRunWait>
  answerRoutedCard: (callerId: string, sessionId: string, card: string | undefined, text: string) => Promise<ChildRunResult>
  readonly restartPolicy: Pick<RestartPolicy, 'applyDeferredRestart'>
  readonly hostCards: Pick<HostCards, 'askHost' | 'withdrawHostAsk'>
  autoBoundaryOpen: (sessionId: string, boundary?: string) => boolean
  /** The project-trust gate (`ProjectRegistry.trustGate`, #2159): null, or the one refusal */
  trustGate: (callerId: string | null, projectId: string | null, boundary: string, quiet?: boolean) => string | null
  /** Whether the project is trusted, read now (`ProjectRegistry.projectTrusted`): for a read, not a crossing (`trustGate`) */
  projectTrusted: (projectId: string | null) => boolean
  builderRefOf: (m: Pick<SessionInfo, "id" | "appId" | "projectId">) => AppRef | null
  /** Whether a send reaches the session as a turn it starts now; otherwise it goes as mail (`MailSessionsView.takesSendNow`) */
  takesSendNow: (sessionId: string) => boolean
  /** A send to a session that cannot take it now, as a mail task (`MailSessionsView.mailTask`) */
  mailTask: (callerId: string, target: SessionInfo, origin: SendOrigin, text: string) => Extract<BusyAnswer, { state: 'mailed' }> | { error: string }
  /** The caller's tasks to the session not delivered yet, withdrawn (`MailSessionsView.withdrawTasks`); how many */
  withdrawTasks: (callerId: string, sessionId: string) => number
  readonly children: ChildOwnership
  readonly worktrees: Pick<WorktreeSessions, 'cleanUpWorktreeChild'>
  createSession: (params: Omit<CreateSessionParams, "projectId" | "tool"> & { projectId: string | null; tool: ToolName | null; kind?: Exclude<SessionInfo["kind"], "coordinator">; roleAppend?: string; appId?: string | null; builderOf?: AppRef; appAgent?: { outputSchema?: Record<string, unknown>; }; askedBy?: string; forkedFrom?: string; lsp?: boolean; onSetupProblems?: (problems: string[]) => void; onWorktreeBase?: (note: string) => void; }) => Promise<SessionInfo>
  cwdFor: (m: SessionInfo) => string
  /** A session as Centralu's word names it to another: as read_session lists it, or its id once it is gone */
  nameOf: (sessionId: string) => string
  /** Tells a session something in its conversation, never while the host leaves, never throwing (`ChildReports.tellSession`, #428) */
  tellSession: (sessionId: string, text: string, from: { sessionId: string; name: string }, relayed: boolean, forModel?: string, opts?: { keep?: boolean; onDelivered?: () => void }) => Promise<boolean>
  /** The seat a session's tools are, which decides the form an answer names a call in (`namedCall`, tool-seats.ts) */
  toolProfileOf: (sessionId: string) => ToolProfile | null
  deliver: (sessionId: string, text: string, attachments: Attachment[] | undefined, from: { sessionId: string; name: string } | undefined, relayed: boolean, fromApp?: undefined, fromAppVia?: 'inline', sendInput?: (handle: SessionHandle, text: string, inputId?: string) => void, stillAllowed?: () => string | null, relayedText?: string) => Promise<void>
  readonly disposing: boolean
  readonly emit: (e: NormalizedEvent) => void
  ensureProjectAccess: (callerSessionId: string, toProjectId: string, access: ProjectConsentKind, what: { text: string; app?: { appId: string; name: string; }; session?: { id: string; name: string; }; }, signal?: AbortSignal) => Promise<{ ok: true; } | { ok: false; error: string; }>
  firstTool: (preferred?: ToolName | null) => ToolName | null
  gitTrust: (projectId: string | null) => { trusted: boolean; }
  /** The host is quitting (`disposing`) */
  readonly closing: boolean
  readonly handles: Map<string, SessionHandle>
  readonly linkedReader: LinkedSessions | null
  /** A child on a linked machine is gone with notes held for it (#2114): the stop notice tells its caller they were not given (`MailSessionsView.linkedChildGone`) */
  linkedChildGone: (childId: string, callerId: string, notes: readonly string[]) => void
  readonly memoryGate: MemoryGate | null
  readonly meta: Map<string, SessionInfo>
  modelsWithin: (tool: ToolName, ms: number, fresh?: boolean) => Promise<{ models: ModelOption[]; cached: boolean; } | null>
  onEvent: (raw: NormalizedEvent, from?: SessionHandle | null) => void
  ownTasksRunning: (sessionId: string) => BackgroundTask[]
  pauseReport: (sessionId: string, running: readonly BackgroundTask[]) => void
  pausedTasksNow: (sessionId: string) => BackgroundTask[]
  readonly readGrants: Map<string, Set<string>>
  rename: (sessionId: string, name: string) => void
  reportBackIfAwaited: (sessionId: string, ending: NormalizedEvent, answer?: string, settled?: readonly BackgroundTask[]) => Promise<string | undefined>
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
  /** A project's `origin` remote (#1038); null with no repository or no origin */
  readonly files: Pick<ProjectFiles, 'projectOrigin'>
  /** A linked machine's session's own background work running there, as the hub last heard it (`LinkedReports`, #723) */
  readonly linkedReports: Pick<LinkedReports, 'ownTasksRunning' | 'tasksOf'>
  /** A linked session's turn end the hub missed while the link was down: settled as its `turn_complete` would be (#1038) */
  settleLinkedTurn: (sessionId: string) => void
  /**
   * §7.4: asked before a delegation creates, starts or delivers anything. S15, the whole refusal the tool answers, when
   * the mailbox refuses it (it has written the record S16 is built from); null when it may go, or with no mailbox
   */
  refusesDelegation: (callerId: string, target: DelegationTarget, call: DelegationCall) => string | null
}
