import { repairWorktreeRecoveryRemovals } from '../dev-services/worktree-recovery.js'
import { randomUUID } from 'node:crypto'
import { orchestratorHome, orchestratorRole } from './orchestrator-home.js'
import { windowAround } from './snippet.js'
import { notAToolText, profileAllows, runOrchestratorTool } from './orchestrator-tools.js'
import type { ToolProfile } from '../apps/contract.js'
import { orchestratorToolsFor, type OrchestratorSeatHost } from './orchestrator-seat.js'
import { hubAskDepthKey } from './agent-depth.js'
import { QueuedRequests, type QueuedRequestsHost } from './queued-requests.js'
import { RoutedCards, type RoutedCardsHost } from './routed-cards.js'
import { HandoffChildren, movedChildrenNote, type HandoffChildrenHost } from './handoff-children.js'
import { ChildReports, type ChildReportsHost } from './child-reports.js'
import { InterruptionWatch, type InterruptionWatchHost } from './interruption-watch.js'
import { LaunchRecords, type LaunchRecordsHost } from './launch-records.js'
import { MergeChecks, type MergeChecksHost } from './merge-checks.js'
import { ProjectCreation, type ProjectCreationHost } from './project-creation.js'
import { UpdatesAsked, type UpdatesAskedHost } from './updates-asked.js'
import { ProjectConsents, type ProjectConsentsHost } from './project-consents.js'
import { UiPreferenceStore, type UiPreferenceStoreHost } from './ui-preferences.js'
import { SessionAppWiring, type SessionAppWiringHost } from './session-app-wiring.js'
import { SessionTools, type SessionToolsHost } from './session-tools.js'
import { HandoffNotes, type HandoffNotesHost } from './handoff-notes.js'
import { ChildOwnership, PAUSED_REPORT_SETTLE_MS } from './child-ownership.js'
import { LinkedReports, type LinkedEvent, type LinkedReportsHost } from './linked-reports.js'
import { OrchestratorProposals, type ProposalOutcome } from './orchestrator-proposals.js'
import type { AppRef } from '../apps/external/runtime.js'
import { AgentRunWait } from './app-agents.js'
import { CacheLedger } from './cache-ledger.js'
import { underGrant } from './ask-project.js'
import { orchestratorMemory } from './transcript-view.js'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import type {
  RebuildCause,
  BackgroundTask,
  ApprovalDecision,
  Attachment,
  ApprovalScope,
  CreateSessionParams,
  GridPanel,
  NormalizedEvent,
  PermissionPreset,
  QuestionAnswer,
  ProjectInfo,
  SavedCommand,
  SessionInfo,
  SessionState,
  Interruption,
  ToolName,
  SettingsApplied,
  FsResolvePurpose,
} from '@cc/protocol'
import {
  applyBackgroundTasks,
  applySessionState,
  nextStateFor,
  sessionOnlyAlways,
  DATA_DIR,
  oneLineText,
  sessionLiveDefaults,
  withoutToolRecord,
  appKeyOf,
  alwaysAllowKey,
} from '@cc/protocol'
import type { AgentAdapter, AgentProcess, AgentSpawnSpec, CreateSessionOpts, EventSink, LinkedSessions, OrchestratedSession, OrchestratorTools, ProcessSource, RecallHit, SessionApps, SessionHandle } from '../adapters/contract.js'
import { registeredTool } from '../adapters/registry.js'
import { codeIntelligenceKey, codeIntelligenceOff } from './tool-profiles.js'
import type { MemoryGate } from './memory-gate.js'

/**
 * Where agent processes live when not with this host (#280 step 2 — the keeper). `spawn` starts a
 * session's tool there; the manager hands it to the adapter as a `ProcessSource`.
 */
export type AgentProcessHost = {
  /** `version`: the CLI version the process is started from, written on its keeper tag so the next host knows it (#297) */
  spawn(sessionId: string, tool: ToolName, spec: AgentSpawnSpec, version?: string): AgentProcess
}

/**
 * A tool process a previous host left running for this session, to be re-attached at startup. `version` is the CLI
 * version it was started from, when its tag says (#297): an adopted process does not announce it again.
 */
export type KeptAgent = { sessionId: string; tool: ToolName; process: AgentProcess; version?: string }
import { Store } from '../dev-services/store.js'
import type { UpdateService } from '../updates.js'
import type { UpdateApplyBroker } from '../update-apply.js'
import { inTurn, sessionIdle, type SessionIdle } from '../idle.js'
import { appSettingRests, CardRests } from './card-rest.js'
import { rpcError, sessionNotFound } from '../rpc-error.js'
import {
  gitSummary,
  gitStatusFiles,
  gitDiff,
  gitHeadSha,
  gitBranchPr,
  gitBranchDelete,
  type BranchPr,
  gitLog,
  gitCommitDetail,
  gitBranches,
  gitIgnoredEntries,
  gitCheckout,
  gitStage,
  gitCommit,
  gitPush,
  gitValidBranchName,
  type Worktree,
  gitWorktreeDirty,
  gitWorktreeRemove,
} from '../dev-services/git.js'
import {
  importFile,
  listDir,
  moveEntry,
  readTextFile,
  resolveEntry,
  resolveProjectFolder,
  resolveTarget,
} from '../dev-services/fs.js'
import { DirWatchers } from '../dev-services/watch.js'
import { invalidateFileIndex } from '../dev-services/file-search.js'
import { writeHandoffNoteSync } from '../dev-services/handoff-notes.js'
import { attachCommitSessions, looksLikeGitCommit, parseCommitSha } from '../dev-services/git-attrib.js'
import { AskProjectFlow, type AskProjectHost } from './ask-project-flow.js'
import { HandoffFlow, type HandoffFlowHost, type HandoffTimings } from './handoff-flow.js'
import { DelegationFlow, type DelegationHost, ASK_THE_PERSON, HUB_SENDER, agentStartPersonText } from './delegation-flow.js'
import type { AgentStartFlow } from './start-agent-flow.js'
import { RestartPolicy, type RestartHost } from './restart-policy.js'
import { WorktreeSessions, type WorktreeHost } from './worktree-sessions.js'
import { canonicalPath, isInside, pathParts } from '../dev-services/path-guard.js'
import { HostCards, type HostCardsHost } from './host-cards.js'
import { ExternalConversations, type ExternalConversationsHost, truncate } from './external-conversations.js'
import { SessionRecord, type SessionRecordHost } from './session-record.js'
import { ToolQueries, type ToolQueriesHost } from './tool-queries.js'
import { withTimeout } from './with-timeout.js'
import { AppSessions, type AppSessionsHost } from './app-sessions.js'
import { appMessageFrame, type AppMessageSource, type AppMessageVia, type AppViewPlace } from './app-messages.js'
import { SessionTrash, type SessionTrashHost } from './session-trash.js'
export { appMessageFrame } from './app-messages.js'
export type { AppMessageSource, AppMessageVia, AppViewPlace } from './app-messages.js'
export { START_AGENT_CALL_MS, START_AGENT_MODEL_CHECK_MS, START_AGENT_SETUP_MS } from './delegation-flow.js'

/** What the modules moved out of the manager reach of it (`SessionManager.parts`): every module's host type at once */
type ManagerParts = HandoffFlowHost & HostCardsHost & WorktreeHost & RestartHost & SessionTrashHost & AppSessionsHost & ToolQueriesHost &
  SessionRecordHost & ExternalConversationsHost & AskProjectHost & LinkedReportsHost & DelegationHost & QueuedRequestsHost & RoutedCardsHost & HandoffChildrenHost & ChildReportsHost & InterruptionWatchHost & LaunchRecordsHost & MergeChecksHost & ProjectCreationHost & UpdatesAskedHost & ProjectConsentsHost & UiPreferenceStoreHost & SessionAppWiringHost & SessionToolsHost & HandoffNotesHost

/**
 * Where the marker "conversation up to here belongs to the old tool" is stored.
 *
 * Why this does not get its own column on the session row: it is not a property of the session
 * but **an event that happened on this install**, and it loses its meaning the moment the new
 * tool says its first word (from then on, externalId has the answer). app_settings is where a
 * value like that lives.
 */
const freshStartKey = (sessionId: string) => `fresh_start:${sessionId}`

function untrustedSourceSessionNotification(sourceSessionId: string): string {
  return (
    '[Centralu] intersession message available.\n' +
    `sourceSessionId: ${sourceSessionId}\n` +
    'Use read_session(sourceSessionId) if you need the untrusted session transcript.'
  )
}

// Lives with the paused reports it times (child-ownership.ts), here and for a linked machine's (#723)
export { PAUSED_REPORT_SETTLE_MS }
/**
 * The most a hub's orchestrator reads of this host in one call (`hostReader`, #82 phase 4): lines of one conversation
 * and hits of one search. Five times the tools' defaults (40 and 12), so no read a model makes is cut, while one call
 * cannot ask for a whole store over the link
 */
const HOST_READ_MAX_LINES = 200
const HOST_RECALL_MAX_HITS = 50

/*
 * What the value means: **everything in the external transcript up to this moment is something I
 * already know.** Two hands write it — catch-up, after it reads (the `updatedAt` the tool gave),
 * and whichever tool holds the writer lock, when its handle is released (our own clock). Since it
 * is the same machine, the two clocks are comparable.
 */

/**
 * Session lifecycle plus persistence. Adapters hold no state (docs/agent-host.md §2), so all state
 * tracking and storage happens here.
 */
export class SessionManager {
  private handles = new Map<string, SessionHandle>()
  private meta = new Map<string, SessionInfo>()
  /**
   * **The configuration the currently running process actually holds.**
   *
   * This can differ from meta (the value shown on screen). Permissions and model are fixed when the
   * tool is launched, so a mismatch can arise where the screen changes to "auto" but the process
   * keeps running with the old configuration. In that state, picking "auto" again does nothing,
   * because compared against meta nothing changed (dogfooding: "it shows auto selected but keeps
   * asking anyway"). So the comparison baseline is always this map, not meta.
   */
  private running = new Map<
    string,
    { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null; permissionPreset: PermissionPreset }
  >()
  /**
   * Watcher for the file tree (#34). Only watches expanded directories — the UI sends the set via
   * fs.watch. Changes go out as an fs_changed event (it is a project-level event, so it has no
   * sessionId).
   */
  private watchers = new DirWatchers((projectId, dirs) => this.emit({ type: 'fs_changed', projectId, dirs }))
  /** Every model request's cache figures over the last day, per tool (docs/agent-host.md §6.1); read by `usageFor` */
  private readonly cacheLedger = new CacheLedger()
  /**
   * `detachAll` is handing the sessions to the next host (#280): the waits it fails are not the end of their turns,
   * so no report goes out and the marks stay in the store for the host that sees those turns end (#646).
   */
  private handingOver = false
  /** Who owns a child session's work (#428): reports, turns, queued requests, delegations, start requests, handoffs */
  private readonly children: ChildOwnership
  /** The work one session gives another: ask_project, start_agent, agent_session (delegation-flow.ts) */
  private readonly delegationFlow: DelegationFlow
  /** The orchestrator's handoff_session (#694): who may hand off what, and the handoff itself */
  private readonly handoffFlow: HandoffFlow
  /** Requests for a session busy with another's turn: the choices, the queue and its delivery (queued-requests.ts) */
  private readonly queue: QueuedRequests
  /** The cards of a delegated turn, as the session that gave it reads and answers them (routed-cards.ts) */
  private readonly cards: RoutedCards
  /** A handoff's move of the original's children to the session that took over (handoff-children.ts) */
  private readonly handoffChildren: HandoffChildren
  /** What a session is told of work it gave: reports, paused reports, stops nobody was owed (child-reports.ts) */
  private readonly reports: ChildReports
  /** A session's `interruption` kept with its events, the reconnect clocks, and a quit's stop (interruption-watch.ts) */
  private readonly interruptions: InterruptionWatch
  /** What a session's process was started with, kept for the next host, and the restart a change needs (launch-records.ts) */
  private readonly launches: LaunchRecords
  /** Whether worktree branches have landed on their trunk, by git or by their PR (merge-checks.ts) */
  private readonly merges: MergeChecks
  /** A project added or made here, and the orchestrator's create_project (project-creation.ts) */
  private readonly projectCreation: ProjectCreation
  /** An agent's update_centralu: check, install and apply, behind its preset and the person's card (updates-asked.ts) */
  private readonly updatesAsked: UpdatesAsked
  /** Whether a session of one project may reach another, and the consents remembered for it (project-consents.ts) */
  private readonly consents: ProjectConsents
  /** The screen's preferences and workspace layout (ui-preferences.ts) */
  private readonly prefs: UiPreferenceStore
  /** The external app runtime as the sessions meet it: attached apps, on-demand access, the broker (session-app-wiring.ts) */
  private readonly apps: SessionAppWiring
  /** The tools a session receives: its profile, its bundle, the reader's set (session-tools.ts) */
  private readonly tools: SessionTools
  /** A handoff's note: written, read by a successor, swept when nobody owns it (handoff-notes.ts) */
  private readonly handoffNotes: HandoffNotes
  /** ask_project, here or on a linked machine (ask-project-flow.ts) */
  private readonly askProjectFlow: AskProjectFlow
  /** The conversations a tool keeps on its own side: listing, holders, import and catch-up (external-conversations.ts) */
  private readonly externals: ExternalConversations
  /** What a session's events leave in the store: streamed messages, rows, images (session-record.ts) */
  private readonly record: SessionRecord
  /** What the host asks a tool outside a turn: commands, usage, models (tool-queries.ts) */
  private readonly toolQueries: ToolQueries
  /** The sessions an external app owns: its builder and the agents it asks for (app-sessions.ts) */
  private readonly appSessions: AppSessions
  /** A session's way to the trash and back: delete, list, restore, purge (session-trash.ts) */
  private readonly trash: SessionTrash
  /** When a session's process is replaced, and the background work a restart waits for (restart-policy.ts) */
  private readonly restartPolicy: RestartPolicy
  /** A worktree session's worktree: made for a new session, taken apart on cleanup (worktree-sessions.ts) */
  private readonly worktrees: WorktreeSessions
  /** The cards the host raises in a session's approval slot, and the screen's capability questions (host-cards.ts) */
  private readonly hostCards: HostCards
  /** The orchestrator's reports from linked machines' sessions, and the work they pause on (linked-reports.ts) */
  private readonly linkedReports: LinkedReports
  /**
   * Session currently being resumed -> its promise.
   *
   * If send() arrives twice at once, both see "no process" and each starts its own resume — two
   * processes come up, whichever lands in the handle map later wins, and the one that came up first
   * is orphaned forever without a dispose. So only one resume runs per session, and the rest wait on
   * its promise.
   */
  private resuming = new Map<
    string,
    Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }>
  >()
  /** Session whose process is being ended to put it to sleep (#568) -> that ending; a resume waits for it */
  private sleeping = new Map<string, Promise<void>>()
  /**
   * Session waiting for a wake to finish so it can be deleted or have its tool switched -> the reason
   * (#163). That wake steps back without placing a handle — the waiting request came first. A send
   * that had joined the wake and was waiting is also not sent.
   */
  private leaving = new Map<string, string>()
  /** The orchestrator's MCP-server and skill proposals and its approved skills (#71, M4 A-7) */
  private readonly proposals: OrchestratorProposals
  /**
   * The installed version of a tool as last read (#297, agent-versions.ts), or null. A process started now runs it,
   * so a session carries it as its `agentVersion` until the process reports its own; it is also what the keeper's
   * tag records, because a process the next host adopts does not report again.
   */
  private versionHint: ((tool: ToolName) => string | null) | null = null
  /**
   * Agent sessions launched at an app's request that are **still waiting for an answer** (M4 D-1) —
   * session id -> the wait. Removed once the turn ends, fails or is canceled. After it finishes the
   * session stays in the list like any ordinary session (the archive feature was dropped — see the
   * comment on `runAppAgent`).
   */
  private agentRuns = new Map<string, AgentRunWait>()
  /** Temporary readers of a person's turn; they never own work or pin the calling session awake. */
  private turnObservers = new Map<string, Set<AgentRunWait>>()
  /** Turns a quit cut, and who to tell, waiting for the start to finish (#698, `tellQuitNotices`) */
  private quitNotices: { sessionId: string; requester: string }[] = []
  /** `disposeAll` has begun (#673): a card it withdraws is not the person's answer, and its request stays stored */
  private disposing = false
  /**
   * What a session may read beyond its folder because another project handed it back (#371 part B) — session id ->
   * resolved paths (files, or output folders). Live only: the grant lasts while this host serves the session, and a
   * restart asks again (the caller's agent then raises its own card for a read outside its folder).
   */
  private readGrants = new Map<string, Set<string>>()

  constructor(
    private store: Store,
    private adapters: Map<ToolName, AgentAdapter>,
    private emit: (e: NormalizedEvent) => void,
    /**
     * The host's own address, and the credential for one session's bridge. The port is only decided
     * after listen(), so this is received as a **function to ask**, not a value. The bridge for
     * adapters that cannot attach to the tool in-process (Codex) comes back through this address.
     * The credential opens only that session's bridge calls (`transport/bridge-token.ts`, #382).
     */
    private endpoint?: (sessionId: string) => { url: string; token: string } | null,
    /**
     * Root under which worktrees are created. **Placed next to the data folder** — that way dev and
     * the packaged app naturally separate (`~/.centralu-dev` vs `~/.centralu`), and tests supply a
     * temporary directory so they never touch the user's real home.
     */
    private worktreeRoot = join(homedir(), DATA_DIR, 'worktrees'),
    private keeperOpts: {
      /** Spawns agents outside this host (the keeper). Absent: adapters spawn their tools as our children */
      processes?: AgentProcessHost
      /** Sessions whose tool process a previous host left running — their live state is not reset (see below) */
      keptSessions?: ReadonlySet<string>
      /** How handoff_session waits for an agent's note (#694); tests shorten it */
      handoffTimings?: HandoffTimings
    } = {},
  ) {
    this.children = new ChildOwnership(store)
    this.handoffNotes = new HandoffNotes(this.parts())
    this.tools = new SessionTools(this.parts())
    this.apps = new SessionAppWiring(this.parts())
    this.prefs = new UiPreferenceStore(this.parts())
    this.consents = new ProjectConsents(this.parts())
    this.updatesAsked = new UpdatesAsked(this.parts())
    this.projectCreation = new ProjectCreation(this.parts())
    this.merges = new MergeChecks(this.parts())
    this.launches = new LaunchRecords(this.parts())
    this.interruptions = new InterruptionWatch(this.parts())
    this.reports = new ChildReports(this.parts())
    this.handoffChildren = new HandoffChildren(this.parts())
    this.cards = new RoutedCards(this.parts())
    this.queue = new QueuedRequests(this.parts())
    this.cardRests = new CardRests(appSettingRests(store))
    this.delegationFlow = new DelegationFlow(this.parts())
    this.handoffFlow = new HandoffFlow(this.parts(), keeperOpts.handoffTimings)
    this.askProjectFlow = new AskProjectFlow(this.parts())
    this.externals = new ExternalConversations(this.parts())
    this.record = new SessionRecord(this.parts())
    this.toolQueries = new ToolQueries(this.parts())
    this.appSessions = new AppSessions(this.parts())
    this.trash = new SessionTrash(this.parts())
    this.restartPolicy = new RestartPolicy(this.parts())
    this.worktrees = new WorktreeSessions(this.parts())
    this.hostCards = new HostCards(this.parts())
    this.linkedReports = new LinkedReports(this.parts())
    this.proposals = new OrchestratorProposals(
      this.store,
      () => this.apps.appsHub?.rt,
      // `this.emit` is wrapped just below; the callback looks it up when a list changes, not now
      () => this.emit({ type: 'orchestrator_proposals_changed' }),
    )
    const rawEmit = this.emit
    this.emit = (full) => {
      /*
       * Every event leaves the host here, and a tool's whole record does not leave with it (#221): the store keeps a
       * call's `input` and a result's `output`, and the UI and the apps get the card. One `cat` of a large file would
       * otherwise go to every window and sit in the reconnect log (transport/event-log.ts).
       */
      rawEmit(withoutToolRecord(full))
    }
    /*
     * On startup, state is **not simply restored as-is.**
     *
     * When the host dies, the session's process dies with it. But the DB still holds the last
     * state as-is, so on restart no process exists at all while the screen still says `working`.
     * The person thinks it is running and waits, and nothing ever happens (dogfooding: "stuck on
     * working for over 40 minutes". The workaround people found at the time was archiving and then
     * restoring it, which worked only because archive reset state to idle — archiving has since
     * been dropped, and this fixes it here so that workaround is no longer needed).
     *
     * A live state (working, waiting for approval) is **only true when a process exists**.
     * At startup no session has a process, so every one of them is corrected to idle. It wakes
     * again once something addresses it — that is better than showing a state that is not true.
     */
    const LIVE_ONLY: SessionState[] = ['working', 'waiting_approval']
    /** Sessions this start found mid-turn with no process (#698): whoever gave them the turn is told once */
    const stoppedByQuit: SessionInfo[] = []
    for (const s of store.listSessions()) {
      /*
       * Except where the process **does** still exist (#280 step 2): the keeper kept it through the
       * restart and `adoptKept` re-attaches it. That state is true; if the adoption fails, it is reset
       * there.
       */
      const stale = LIVE_ONLY.includes(s.state) && !keeperOpts.keptSessions?.has(s.id)
      const fixed = stale ? { ...s, state: 'idle' as const, waitingSince: null } : s
      // Old cross-project ownership (#614) is cleared by store step v55, no longer here (#844)
      this.meta.set(s.id, fixed)
      if (stale) {
        console.error(`[agent-host] stale state reset: ${s.id.slice(0, 8)} ${s.state} -> idle`)
        // No window is attached yet: the marker and the interruption are read with the conversation and the list
        this.interruptions.markStoppedByQuit(fixed, false)
        store.upsertSession(fixed)
        stoppedByQuit.push(fixed)
      }
    }
    /*
     * Who to tell of a turn a quit cut (#698): the session owed its report, else the one that gave the running turn
     * (an ask_project or a send), else the one that started it; the first of them that still exists. Read before the
     * loops below clear those rows. An asker that delegated without waiting was at rest, not cut, and would otherwise
     * never hear: its mark used to be dropped.
     *
     * A requester the same quit cut is skipped when the notice is given (`tellAskerOfInterruption`, its `quit`).
     */
    const marks = new Map(store.listReportMarks().map((r) => [r.sessionId, r.callerSessionId]))
    const turnGivers = new Map(store.listDelegatedTurns().map((r) => [r.sessionId, r.callerSessionId]))
    for (const s of stoppedByQuit) {
      const requester = [marks.get(s.id), turnGivers.get(s.id), s.askedBy].find((id): id is string => !!id && id !== s.id && this.meta.has(id))
      if (requester) this.quitNotices.push({ sessionId: s.id, requester })
    }
    // A card the previous host left standing over a kept process closes back into its rest here too (#428)
    this.cardRests.restore((id) => !!keeperOpts.keptSessions?.has(id) && this.meta.get(id)?.state === 'waiting_approval')
    this.children.restoreReports(this.meta, keeperOpts.keptSessions)
    this.delegationFlow.starts.restoreAgentStarts()
    this.children.restoreTurns(this.meta, keeperOpts.keptSessions)
    this.children.restoreQueued(this.meta, (r) => r.via === 'ask_project' && !this.queue.pairConsented(r.callerSessionId, this.meta.get(r.sessionId)!))
    if (this.children.queued.size) {
      setTimeout(() => {
        for (const id of this.children.queued.keys()) if (!keeperOpts.keptSessions?.has(id)) this.queue.scheduleDrain(id)
      }, 0)
    }
    // A requester the keeper kept is told once it is adopted (`adoptKept`), so the note does not start a second process
    if (this.quitNotices.length) setTimeout(() => this.tellQuitNotices((id) => !keeperOpts.keptSessions?.has(id)), 0)
    /*
     * Sweeps orphaned handoff notes (#106). **Why startup is a safe moment for this**: no handoff is
     * in progress right now — a note being read mid-flight cannot be cleaned up out from under
     * someone. A failure here is no reason to block session restore, so it is not awaited.
     */
    void this.handoffNotes.sweepOrphanHandoffNotes().catch(() => {})
    // Recovery folders a purge moved aside and never finished with (#647): back for an entry still in the trash, gone otherwise
    // Not awaited here; a purge or restore waits for it, so neither reads the folder while it is still aside
    this.recoveryRepair = repairWorktreeRecoveryRemovals((id) => store.isTrashed(id)).catch((e) => console.error(`[trash] recovery folders left by an interrupted purge were not repaired: ${(e as Error).message}`))
    this.nameUnnamedWorktrees()
    // "Always allow" rules ending in `*` (#838): since #908 none allows anything, and an older build read them as prefixes
    const wildcards = store.dropWildcardApprovalRules()
    if (wildcards > 0) console.error(`[permissions] removed ${wildcards} "always allow" rule(s) ending in * (#838): their commands are asked again`)
    /*
     * Merge detection also runs once at startup (#69) — a merge could have happened in a terminal
     * while the app was off. A failure here is no reason to block session restore, so it is not
     * awaited.
     */
    for (const pid of new Set(
      [...this.meta.values()].filter((s) => s.worktree && s.projectId).map((s) => s.projectId as string),
    )) {
      this.merges.checkMergedInBackground(pid)
    }
  }

  /**
   * **Seats the branch name** on a worktree session that has not received a name yet (runs once at
   * startup).
   *
   * 'New session' is not a name, it is a blank. A worktree session has a branch from the moment it
   * is born, so something to fill that blank with is already in hand — filling it in lets sessions
   * that have not been addressed yet still be told apart in the sidebar (dogfooding, 2026-09-07).
   *
   * **Only when the name is auto-generated.** autoNamed=false means the person set the name, and
   * that is not ours to touch. The autoNamed flag is left as-is, so a meaningful name still
   * overwrites it once the first message arrives.
   */
  private nameUnnamedWorktrees(): void {
    for (const s of [...this.meta.values()]) {
      if (!s.worktree || !s.autoNamed || s.name !== 'New session') continue
      const renamed = { ...s, name: s.worktree.branch }
      this.meta.set(s.id, renamed)
      this.store.upsertSession(renamed)
    }
  }

  /**
   * `projects.createWorktreeManager` (#76), kept in the protocol for an older window: the worktree manager was folded
   * into ordinary sessions (#561 part 3), so there is no slot to make. A session starts worktree agents itself
   * (start_agent), and the person makes a worktree session from the new-session window.
   */
  async createWorktreeManager(_projectId: string, _baseBranch: string): Promise<SessionInfo> {
    throw rpcError('The worktree manager is gone: make a worktree session from New session, or have a session start one with start_agent')
  }

  /** `ProjectCreation.addProject` (project-creation.ts), kept on the manager for its callers */
  addProject(...a: Parameters<ProjectCreation['addProject']>): ReturnType<ProjectCreation['addProject']> {
    return this.projectCreation.addProject(...a)
  }

  /** `ProjectCreation.useProjectsHome` (project-creation.ts), kept on the manager for its callers */
  useProjectsHome(...a: Parameters<ProjectCreation['useProjectsHome']>): ReturnType<ProjectCreation['useProjectsHome']> {
    return this.projectCreation.useProjectsHome(...a)
  }

  /** `ProjectCreation.projectCreatePreview` (project-creation.ts), kept on the manager for its callers */
  projectCreatePreview(...a: Parameters<ProjectCreation['projectCreatePreview']>): ReturnType<ProjectCreation['projectCreatePreview']> {
    return this.projectCreation.projectCreatePreview(...a)
  }

  /** `ProjectCreation.createProject` (project-creation.ts), kept on the manager for its callers */
  createProject(...a: Parameters<ProjectCreation['createProject']>): ReturnType<ProjectCreation['createProject']> {
    return this.projectCreation.createProject(...a)
  }

  /**
   * The start gate for new agent sessions (#686, `memory-gate.ts`): wired by main.ts, and by the tests that are about
   * it. Without one every start goes ahead, so a test machine short of memory does not queue unrelated tests' children.
   */
  private memoryGate: MemoryGate | null = null
  useMemoryGate(gate: MemoryGate | null): void {
    this.memoryGate = gate
  }

  /**
   * Deletes a project (this is a **delete**, not an unregister).
   *
   * Files are left untouched — removing a folder only ever happens through the OS trash, and that
   * is the shell's (Rust's) job, which the caller finishes **before** this command. Why the order
   * runs that direction: the only place the path is known is this DB row, so deleting the row first
   * would leave nowhere to ask what to discard. Conversely, if the trash step fails, this ends
   * having deleted nothing.
   *
   * Sessions go straight through `trashSession` — **its sessions go to the trash (#204), not with the
   * project.** The
   * owner's rule is that a conversation leaves the store only from Settings, and deleting a project destroyed every
   * one of its conversations at once — the largest loss one click could cause. The process is stopped and
   * `session_deleted` is sent on the way, as for one session; writing that again here would drift one day.
   * Nothing is marked for removal with them: the tool's conversation files and the worktrees stay even when the
   * trash is emptied, because nobody was asked about them (a worktree also holds work not merged yet — the same
   * call the session dialog makes by leaving it by default). Restoring one of them registers the folder again.
   *
   * Trying to delete a manager that still has children first would be blocked by #69's protection.
   * So deletion goes **leaves first**.
   */
  async deleteProject(projectId: string): Promise<void> {
    // Cards and queued asks that reach into it or out of it end first, before any wait: none outlives the project
    this.queue.withdrawReaches(
      (ask) => ask.detail.kind === 'project_access'
        ? ask.detail.from.id === projectId || ask.detail.to.id === projectId
        : ask.detail.kind === 'agent_start' && ask.detail.project.id === projectId,
      (_r, from, to) => from === projectId || to === projectId,
      'The project was removed from Centralu.',
      false,
    )
    const mine = [...this.meta.values()].filter((s) => s.projectId === projectId)
    const leavesFirst = [...mine].sort(
      (a, b) => Number(!!b.parentSessionId) - Number(!!a.parentSessionId),
    )
    for (const s of leavesFirst) await this.trashSession(s.id).catch(() => {})
    const root = this.projectRow(projectId)?.path
    this.store.deleteProject(projectId)
    // What was held for the project's folder goes with it (#392): its watchers and its `@` file index
    this.watchers.drop(projectId)
    if (root) invalidateFileIndex(root)
  }

  /** How many of a project's directories are watched (tests) */
  watchedDirCount(projectId: string): number {
    return this.watchers.watchedCount(projectId)
  }

  /**
   * Project trust (M4 A-2, plan decision 3). The app runtime reads it fresh from the store every
   * time, so telling it to rescan is the RPC layer's job (this layer does not know about the runtime).
   *
   * Trust decides which setting files a session reads (Claude `settingSources`, Codex `repoFilesConfig`), and a
   * live process keeps the ones it started with (#663). The flag is part of the launch-settings fingerprint, so a
   * change goes through the same safety restart as any other launch-settings change (#656): an idle session of the
   * project restarts now, one in a turn at the end of the turn, background work or not, and the conversation says
   * why. The flag is written before this returns; the promise settles when the idle restarts are done.
   */
  setProjectTrusted(projectId: string, trusted: boolean): Promise<void> {
    const was = this.projectRow(projectId)?.trusted
    if (!this.store.setProjectTrusted(projectId, trusted)) {
      throw rpcError(`Project not found: ${projectId}`)
    }
    // Every window re-reads the project: the trust mark, the ⋯ menu and the project's apps follow the host (#719)
    if (was !== trusted) this.emit({ type: 'projects_changed' })
    // A start_agent card standing in that project rests on the trust just taken away (#673 review): withdrawn, and told
    if (!trusted) {
      for (const rec of [...this.children.agentStarts.values()]) {
        if (rec.ended || rec.req.projectId !== projectId) continue
        this.delegationFlow.starts.withdrawAgentStart(
          rec.req.requestId,
          `The person stopped trusting this session's project, so no agent was started. ${ASK_THE_PERSON}`,
          agentStartPersonText(rec.req, 'untrusted'),
        )
      }
      // So do its sessions' cards to reach another project, a fork's card for a session in it, and its queued asks
      this.queue.withdrawReaches(
        (ask) => ask.detail.kind === 'project_access' ? ask.detail.from.id === projectId : ask.detail.kind === 'agent_start' && ask.detail.project.id === projectId,
        (_r, from) => from === projectId,
        "The person stopped trusting the asking session's project.",
        true,
      )
    }
    return this.launches.refreshLaunchSettings(projectId, true)
  }

  /**
   * Is this project trusted (decision 3, #92) — passed to the adapter when launching a session. False
   * if the project does not exist.
   *
   * Read fresh from the store on every call, the same as the app runtime — holding a cached copy
   * would keep answering "yes" even after trust was turned off.
   */
  private projectTrusted(projectId: string | null): boolean {
    if (!projectId) return false
    return this.store.projectRoots().some((p) => p.id === projectId && p.trusted)
  }

  /**
   * The settings files reachable from this session (M4 decision 3, #92, #152) — decided by **what
   * the session is**. Both creating and waking a session go through this one place.
   *
   *   Orchestrator / coordinator session          No files at all — it has no project, and that
   *                                                folder (orchestratorHome) is one a worker can
   *                                                write to. An instruction arriving through a file
   *                                                is exactly a privilege-escalation path.
   *   Builder session of a user-folder app         Trusted — that folder belongs to the user
   *                                                themselves (decision 3: a user-folder app is trusted)
   *   Agent the user-folder app asked for (D-1)   Only the person's own settings — see the comment below
   *   Builder session of a worker, manager or     Follows that project's trust as-is (same as a
   *   project app; agent the project app          worker under #152)
   *   asked for (D-1)
   *
   * **This is not split by whether the session has orchestrator tools.** It used to be: the adapter
   * split "if it has orchestrator tools, no files at all", but the worktree manager (#69) and
   * builder sessions (C-3) also receive those tools. That meant a builder session of a trusted
   * project could read neither CLAUDE.md nor the user's own ~/.claude (global bypass), so it kept
   * raising an approval card the person had already turned off everywhere else.
   *
   * Whether a session is a builder session is checked via the directory (builderRefOf) — the same
   * check that decides the tool bundle (`builder`). If apps imported from outside ever exist (they
   * do not yet), such an app is not trusted until verified (decision 3) — that is where the split
   * would happen.
   */
  private settingFilesFor(
    m: Pick<SessionInfo, 'id' | 'kind' | 'projectId' | 'appId'>,
  ): Pick<CreateSessionOpts, 'projectTrusted' | 'noSettingFiles'> {
    if (m.kind === 'orchestrator' || m.kind === 'coordinator') return { projectTrusted: false, noSettingFiles: true }
    if (m.projectId === null && this.appSessions.builderRefOf(m)) return { projectTrusted: true }
    /*
     * Agent a user-folder app asked for (M4 D-1) — receives only the person's own settings
     * (~/.claude, ~/.codex), not files from the folder.
     *
     * That session's text was written by the app, not the person. Its slot, like a coordinator
     * session, is the orchestrator's empty folder (orchestratorHome), which a worker can write to —
     * if it received the CLAUDE.md and settings placed there, an agent running on the app's text
     * would take instructions someone else wrote as if they carried authority. The reason a builder
     * session is trusted (that folder belongs to the person building the app) does not apply here:
     * this session's folder belongs to neither the app nor the person. But giving it no files at all
     * (as with a coordinator session) would mean the person's own rules for every agent (approvals,
     * deny lists) are missing only for agents the app asked for — the one place it would get looser
     * without the person knowing. A project app's version follows that project's trust like a worker
     * (below): that session runs inside the project, and whether it gets the project's settings was
     * already decided by the person through trust.
     */
    if (m.projectId === null && this.apps.isAppAgentSession(m)) return { projectTrusted: false }
    return { projectTrusted: this.projectTrusted(m.projectId) }
  }

  private async projectInfo(id: string, path: string): Promise<ProjectInfo> {
    /*
     * **Reads the stored value.** 'claude' used to be hardcoded here, which meant the DB's
     * default_tool column was never read anywhere — and since nothing wrote to it either, nobody
     * noticed (2026-08-27, caught by a test while adding the remember-tool feature).
     */
    const row = this.projectRow(id)
    const git = await gitSummary(path, { trusted: row?.trusted ?? false })
    const stored = row?.defaultTool
    return {
      id, path, name: basename(path), defaultTool: this.firstTool(stored),
      // Trust (M4, decision 3) — reads the same column as the app runtime. The trust toggle on screen shows
      // this value
      trusted: row?.trusted ?? false,
      // Default model/effort per tool (#107) — read separately since it is JSON, like commands and
      // worktreeSetup
      defaultModels: this.store.projectToolDefaults(id),
      // Saved shell commands ride along with the project so the Run menu never has a
      // "loading" state to distinguish from an empty one (issue #44)
      commands: this.store.projectCommands(id),
      // Worktree provisioning (#69) rides along too — a new session window prefills it without a separate
      // fetch
      worktreeSetup: this.store.worktreeSetup(id),
      // Manager slot and trunk (#76). Treated as absent if the pointed-to session does not exist or
      // is archived — so the screen never navigates to a ghost slot, this side (which knows about
      // sessions) does the check
      /*
       * The trunk, in the shape the window has read since #76. The session is the former manager's, or empty: the
       * manager was folded into ordinary sessions (#561 part 3), and the window reads only `baseBranch`
       */
      worktreeManager: (() => {
        const trunk = this.store.worktreeTrunk(id)
        return trunk ? { sessionId: this.store.worktreeManager(id)?.sessionId ?? '', baseBranch: trunk } : null
      })(),
      git: git.isRepo ? git : null,
    }
  }

  /**
   * Replace this project's saved shell commands (issue #44).
   *
   * Blank entries are dropped here rather than trusted to the caller: a row that runs
   * nothing when clicked is worse than no row, and this is the one place every edit —
   * from any client — has to pass through.
   *
   * Nothing else is inspected. These are the user's own commands and go to their own
   * shell; the approval machinery exists for what an agent proposes, and running these
   * through it would put a permission prompt in front of what the person just typed.
   */
  setProjectCommands(projectId: string, commands: readonly SavedCommand[]): SavedCommand[] {
    this.requireProject(projectId)
    // Drop empty commands, and turn an empty alias into no alias — the label is display-only, so all it needs
    // is normalizing
    const clean = commands.flatMap((c): SavedCommand[] => {
      const command = c.command.trim()
      if (!command) return []
      const label = c.label?.trim()
      return [{ command, ...(label ? { label } : {}) }]
    })
    const was = JSON.stringify(this.store.projectCommands(projectId))
    this.store.setProjectCommands(projectId, clean)
    // The Run menu of every other window reads the project's commands (#719)
    if (was !== JSON.stringify(clean)) this.emit({ type: 'projects_changed' })
    return clean
  }

  /** Worktree provisioning settings (#69) — saved by the new session window's worktree section */
  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): void {
    this.requireProject(projectId)
    const clean = setup
      ? { command: setup.command.trim(), copyFiles: setup.copyFiles.map((f) => f.trim()).filter(Boolean) }
      : null
    const saved = clean && (clean.command || clean.copyFiles.length) ? clean : null
    const was = JSON.stringify(this.store.worktreeSetup(projectId))
    this.store.setWorktreeSetup(projectId, saved)
    if (was !== JSON.stringify(this.store.worktreeSetup(projectId))) this.emit({ type: 'projects_changed' })
  }

  /**
   * Sidebar order (the person sets it by dragging).
   *
   * Anything missing from the received list is **left at the end, as-is** — something that was off
   * screen should never jump to the front just because an order was saved once.
   */
  async reorderProjects(orderedIds: readonly string[]): Promise<ProjectInfo[]> {
    const known = this.store.listProjects().map((p) => p.id)
    const rest = known.filter((id) => !orderedIds.includes(id))
    this.store.setProjectOrder([...orderedIds.filter((id) => known.includes(id)), ...rest])
    return this.listProjects()
  }

  reorderSessions(projectId: string, orderedIds: readonly string[]): SessionInfo[] {
    /*
     * The order is **a single global one** (sidebar_order). Renumbering just this project's own
     * from 0 would collide with other projects' values, so sorting one project would scramble the
     * whole list. So only **the slots this project occupied** in the global order are swapped in
     * with the new order, and every other session is left exactly where it was.
     */
    const all = this.listSessions()
    const mine = new Set(all.filter((s) => s.projectId === projectId).map((s) => s.id))
    const rest = [...mine].filter((id) => !orderedIds.includes(id))
    const replacement = [...orderedIds.filter((id) => mine.has(id)), ...rest]
    let k = 0
    const globalOrder = all.map((s) => (mine.has(s.id) ? replacement[k++]! : s.id))
    this.store.setSessionOrder(globalOrder)
    // Reorder the in-memory copy too — saving alone leaves it out of sync with the screen until the next
    // launch
    const rank = new Map(globalOrder.map((id, i) => [id, i]))
    const sorted = [...this.meta.entries()].sort((a, b) => (rank.get(a[0]) ?? 0) - (rank.get(b[0]) ?? 0))
    this.meta = new Map(sorted)
    return this.listSessions()
  }

  /** Grid layout — sessions and apps, in order (#288) */
  grid(): GridPanel[] {
    return this.store.listGridView()
  }

  /**
   * Saves the layout.
   *
   * **Unknown sessions are filtered out.** If a deleted session's id stays in the layout and comes
   * back, the screen tries to draw something that no longer exists — filtering once at save time
   * means nobody has to worry about it afterward. An app panel is kept while its project is
   * registered (a user-folder app has none). Whether the app itself exists is the screen's
   * question: the app list is read from folders and can lag behind, and a panel dropped here for
   * that reason would not come back once the list caught up.
   */
  setGridView(panels: readonly GridPanel[]): GridPanel[] {
    const known = new Set(this.meta.keys())
    const projects = new Set(this.store.listProjects().map((p) => p.id))
    // A linked machine's session (#82) is kept while the hub's mirror knows it (links/links.ts)
    const remote = (id: string) => !known.has(id) && this.linkedSession(id)
    /*
     * Another machine's app (#82, remote-hub.md §11.8) is kept while that machine is linked and, for a project app,
     * while the hub's mirror knows its project: the machine of a user-folder app is named by `machine`, a project
     * app's by its qualified project. A `machine` on a panel of this host's own app is dropped: it would name nothing.
     */
    const appMachine = (p: Extract<GridPanel, { kind: 'app' }>): string | null =>
      p.projectId === null ? (p.machine && this.linkedApps.linked(p.machine) ? p.machine : null) : this.linkedApps.projectMachine(p.projectId)
    const seen = new Set<string>()
    const clean: GridPanel[] = []
    for (const p of panels) {
      if (p.kind === 'session') {
        const key = `session:${p.sessionId}`
        if (seen.has(key) || !(known.has(p.sessionId) || remote(p.sessionId))) continue
        seen.add(key)
        clean.push(p)
        continue
      }
      const { machine: _machine, ...own } = p
      const elsewhere = projects.has(p.projectId ?? '') ? null : appMachine(p)
      // A panel naming a machine this host does not link is nobody's app here
      if (!elsewhere && (p.machine || (p.projectId !== null && !projects.has(p.projectId)))) continue
      const panel: GridPanel = elsewhere && p.projectId === null ? { ...own, machine: elsewhere } : own
      const key = `app:${appKeyOf(p.projectId, p.appId, elsewhere)}`
      if (seen.has(key)) continue
      seen.add(key)
      clean.push(panel)
    }
    this.store.setGridView(clean, remote, (p) => (projects.has(p.projectId ?? '') ? null : appMachine(p)))
    return clean
  }

  /** Whether a machine-qualified id names a session of a linked machine the hub knows (#82). None without links */
  private linkedSession: (sessionId: string) => boolean = () => false

  useLinkedSessions(known: (sessionId: string) => boolean): void {
    this.linkedSession = known
  }

  /** The linked machines, for grid panels of their apps (#82). None without links */
  private linkedApps: { linked(machine: string): boolean; projectMachine(projectId: string): string | null } = {
    linked: () => false,
    projectMachine: () => null,
  }

  useLinkedApps(lookup: { linked(machine: string): boolean; projectMachine(projectId: string): string | null }): void {
    this.linkedApps = lookup
  }

  /** The linked machines' sessions, for the central orchestrator's and a trusted reader's reading tools (#82 phase 4, #984). None without links */
  private linkedReader: LinkedSessions | null = null

  useLinkedReader(reader: LinkedSessions): void {
    this.linkedReader = reader
  }

  /**
   * A linked machine's event, as the hub relays it to its windows (qualified, links.ts). An ask_project task's turn
   * there ends as `observeLinkedAsk` judges it; the end of a turn the orchestrator is waiting on becomes its report, as
   * `reportBackIfAwaited` does for this host's sessions, with the same pause over the session's own background work
   * (#723, `LinkedReports`).
   */
  observeLinked(e: LinkedEvent): void {
    if (e.type === 'machine_status') this.askProjectFlow.observeLinkLoss(e.machine)
    else if (typeof e.sessionId === 'string') {
      const ask = this.askProjectFlow.linkedAsks.get(e.sessionId)
      if (ask) this.askProjectFlow.observeLinkedAsk(ask, e)
    }
    this.linkedReports.observe(e)
  }

  /**
   * What this host answers a hub's orchestrator about its own sessions (`host.sessions`, `host.readSession`,
   * `host.recall`; docs/plans/remote-hub.md §12). The orchestrator's own code, over the view a hub's window has of this
   * host: no calling session, and this host's orchestrator and coordinators left out (§3.4), so the hub's orchestrator
   * reads what the hub shows and no more. Bounded per call, since the caller is another machine.
   */
  /**
   * A hub's orchestrator's instruction to one of this host's sessions (`host.send`, #82 phase 4 step 2). Delivered as
   * `send_to_session` delivers one here, recorded as sent by `fromName`, to a session a hub is shown and no other.
   *
   * It stays an instruction, not someone else's words (#120): the hub holds this host's token, so it could send the
   * same text as the person; marking it as a relay would only hide the words from a manager it was meant for.
   */
  async sendFromHub(sessionId: string, text: string, fromName: string, ask?: { depth: number }): Promise<void> {
    const target = this.meta.get(sessionId)
    if (!target || target.kind === 'orchestrator' || target.kind === 'coordinator') {
      throw rpcError(`Not a session this machine shares: ${sessionId}`, 'session_not_found')
    }
    const name = oneLineText(fromName, 120) || 'Orchestrator on a linked computer'
    /*
     * An ask_project task from the hub (#838 item 12): the session works on it at the depth the hub counts, until the
     * turn that consumes it is recorded (`hubAskDepthKey`), so its start_agent and ask_project read the same depth as a
     * session asked here. Marked before the send, as the turn may end before it returns; taken back if the send fails.
     * The input is tracked where the adapter can (`sendTracked`), so the mark goes with that turn and not with another
     * turn that happens to end first; without tracking (or after a host swap) the next turn end takes it.
     */
    if (!ask) return this.send(sessionId, text, undefined, { sessionId: HUB_SENDER, name })
    const key = hubAskDepthKey(sessionId)
    this.store.setAppSetting(key, String(ask.depth))
    const done = () => {
      this.hubAskTurns.delete(sessionId)
      this.store.deleteAppSetting(key)
    }
    try {
      await this.deliver(sessionId, text, undefined, { sessionId: HUB_SENDER, name }, false, undefined, 'inline', (h, t) => {
        if (!h.sendTracked) return h.send(t)
        this.hubAskTurns.add(sessionId)
        void h.sendTracked(t, { complete: done, fail: done }).catch(() => {})
      })
    } catch (e) {
      done()
      throw e
    }
  }

  /** Sessions whose hub task's input is tracked (`sendFromHub`): its own turn takes the depth mark down, no other */
  private readonly hubAskTurns = new Set<string>()

  hostReader(): {
    sessions(): Promise<OrchestratedSession[]>
    read(sessionId: string, limit?: number, opts?: { around?: number; tools?: boolean }): Promise<{ state: string; lines: string[] }>
    recall(query: string, limit?: number): Promise<RecallHit[]>
  } {
    const view = this.orchestratorToolsFor('', undefined, undefined, true)
    return {
      sessions: () => view.listSessions(),
      read: async (sessionId, limit, opts) => {
        const r = await view.readSession(sessionId, Math.min(limit ?? 40, HOST_READ_MAX_LINES), opts)
        if (!r.ok) throw rpcError(r.error ?? 'Could not read it')
        return { state: r.state ?? 'idle', lines: r.lines ?? [] }
      },
      recall: async (query, limit) => (await view.recall(query, Math.min(limit ?? 12, HOST_RECALL_MAX_HITS))).hits,
    }
  }

  async listProjects(): Promise<ProjectInfo[]> {
    return Promise.all(this.store.listProjects().map((p) => this.projectInfo(p.id, p.path)))
  }

  /**
   * One project, re-measured (issue #41).
   *
   * The caller is a refresh loop — the sidebar count is re-read every time a turn ends —
   * so this has to cost **one** `git status`. Answering it by calling `listProjects` and
   * discarding all but one row would run a status per registered project on every turn,
   * which is exactly the quiet cost that keeps this out of the hot path.
   */
  async projectGitStatus(projectId: string): Promise<ProjectInfo> {
    const p = this.requireProject(projectId)
    /*
     * Merge detection (#69) piggybacks here — the UI's call is debounced to fire whenever a turn
     * ends, which happens to be the same rhythm as "something just moved". A merge done in a
     * terminal is caught on the next refresh too. It does not block the response: the badge flows
     * separately as an event.
     */
    this.merges.checkMergedInBackground(projectId)
    return this.projectInfo(p.id, p.path)
  }

  listSessions(): SessionInfo[] {
    return [...this.meta.values()].map((s) => {
      const live = this.handles.has(s.id)
      // The CLI version belongs to the process (#297): without one there is no version to compare
      return { ...s, live, agentVersion: live ? (s.agentVersion ?? null) : null }
    })
  }

  /** Active sessions running in the same directory (the basis for FR-2's concurrent-session warning) */
  activeSessionsIn(projectId: string): SessionInfo[] {
    return this.listSessions().filter((s) => s.projectId === projectId)
  }

  /** `ExternalConversations.listExternalSessions` (external-conversations.ts), kept on the manager for its callers */
  listExternalSessions(...a: Parameters<ExternalConversations['listExternalSessions']>): ReturnType<ExternalConversations['listExternalSessions']> {
    return this.externals.listExternalSessions(...a)
  }

  /**
   * Creates a session.
   *
   * Why projectId is `string | null`: the orchestrator does not belong to a project. The RPC
   * contract (CreateSessionParams) still requires a project, so outside callers can never send
   * null — the only place that can create a session with no project is `orchestrator()` below.
   */
  async createSession(
    params: Omit<CreateSessionParams, 'projectId' | 'tool'> & {
      projectId: string | null
      /** Internal default resolution can find no tool; reject that only when creating a session. */
      tool: ToolName | null
      /**
       * Role (#13). Not in the RPC contract — an outside caller can never "create" an orchestrator
       * (orchestrator() is the only path), and this field exists so orchestrator() has something to
       * fill when creating its own session.
       */
      kind?: Exclude<SessionInfo['kind'], 'coordinator'>
      /**
       * Who sent `initialPrompt`, when it is not the person (#694: the orchestrator's handoff_session). Not in the RPC
       * contract: a window's first message is the person's. Stored and broadcast as that sender's, as `send`'s `from`.
       */
      initialFrom?: { sessionId: string; name: string }
      /**
       * Role text pinned on the row and reapplied on every wake — filled only by `createAppBuilder`. A coordinator's
       * role rode here too; nothing creates a coordinator since the control app went (#372), and one already in a
       * store wakes through `resumeSession` with its own row.
       */
      roleAppend?: string
      /** The app that created this session (#81). Filled by the host's own paths for an app (builder, `run_agent`),
       * never by the app itself */
      appId?: string | null
      /**
       * This session is that app's **builder session** (M4 C-2) — filled only by `createAppBuilder`.
       * Written **before** the adapter is launched: the app to attach and the tool bundle (C-3) see
       * this relationship the moment they launch it.
       */
      builderOf?: AppRef
      /**
       * This is an agent session an app asked for (M4 D-1) — filled only by `runAppAgent`. Loads the
       * answer schema into the adapter (`outputSchema`) and does not change the project's default
       * tool: the tool the app picked is not the person's choice.
       */
      appAgent?: { outputSchema?: Record<string, unknown> }
      /** The same-project session that started this agent (#561). */
      askedBy?: string
      /** The session whose conversation this one is a copy of (#677, a fork of a busy session) */
      forkedFrom?: string
      /** start_agent's choice of code intelligence for its child (#686); absent: a child starts without it */
      lsp?: boolean
    },
  ): Promise<SessionInfo> {
    if (params.askedBy && this.meta.get(params.askedBy)?.projectId !== params.projectId) {
      throw new Error('A session cannot create a session in another project')
    }
    if (!params.tool) {
      throw rpcError('No agent adapter is available. Install and configure an agent CLI before creating a session.', 'tool_not_installed')
    }
    const adapter = this.adapters.get(params.tool)
    if (!adapter) throw rpcError(`Unknown tool: ${params.tool}`, 'tool_not_installed')

    if (params.resumeExternalId) {
      const holder = this.externals.holderOf(params.resumeExternalId)
      if (holder) {
        throw rpcError(`This conversation is already open in the "${holder.name}" session — continue there`)
      }
    }

    const id = randomUUID()

    /*
     * Worktree session (FR-2 option). Created **before the adapter is launched** — it has to be
     * passed in as cwd.
     *
     * If it fails, session creation stops entirely. Quietly falling back to the original directory
     * would make the person think they are isolated while both sessions actually touch the same
     * files — the exact thing this feature exists to prevent.
     */
    let worktree: Worktree | null = null
    if (params.worktree && params.projectId) {
      worktree = await this.worktrees.createWorktree({ ...params, projectId: params.projectId }, id)
    }

    /*
     * Session name = branch name (#69). Conductor assigns each workspace a "unique city name",
     * which says nothing at all about what the branch does — the branch name is the only
     * meaning-carrying identifier for the person to read.
     *
     * If the person set the branch, that name is **fixed permanently** (autoNamed=false — an
     * auto-name never overwrites it). If they did not, the name **starts out** as the auto-generated
     * branch (`centralu/…`) but keeps its auto-name eligibility: this slot used to just say 'New
     * session', and with several sessions in the worktree panel there was no way to tell from the
     * screen which was which branch (dogfooding, 2026-09-07). Once the first message arrives, a
     * meaningful name takes that slot's place.
     */
    const namedByBranch = worktree && params.worktreeBranch ? worktree.branch : null
    const info: SessionInfo = {
      id, projectId: params.projectId, kind: params.kind ?? 'worker', tool: params.tool, externalId: null,
      scopeSessionIds: null, roleAppend: params.roleAppend ?? null,
      appId: params.appId ?? null,
      ...(params.askedBy ? { askedBy: params.askedBy } : {}),
      name:
        namedByBranch ??
        (params.initialPrompt ? truncate(params.initialPrompt) : (worktree?.branch ?? 'New session')),
      autoNamed: !namedByBranch, state: 'idle', lastReadSeq: 0, lastSeq: 0,
      createdAt: Date.now(), waitingSince: null, live: true,
      model: params.model ?? null, effort: params.effort ?? null,
      verbosity: params.verbosity ?? null,
      serviceTier: params.serviceTier ?? null,
      permissionPreset: params.permissionPreset,
      importedFrom: params.importHistory ? (params.resumeExternalId ?? null) : null,
      worktree,
      /*
       * A worktree session hangs in the sidebar under the session that started it with start_agent (#561); one the
       * person makes stands on its own. It used to hang under the project's worktree manager, made for it if there
       * was none (#69); that role was folded into ordinary sessions (#561 part 3).
       */
      parentSessionId: worktree && params.askedBy ? params.askedBy : null,
      ...(params.forkedFrom ? { forkedFrom: params.forkedFrom } : {}),
      ...sessionLiveDefaults(),
      // Started from what is installed now, until the process says (#297)
      agentVersion: this.versionHint?.(params.tool) ?? null,
    }
    /*
     * The directory this session starts in. Remembered below, not derived again later —
     * the tool files the conversation under this exact path, so this is the only path that
     * can ever find it again (issue #28).
     */
    const cwd = worktree?.path ?? params.cwd

    // **Saved only after the adapter succeeds.** Saving first would leave a "ghost session" in the
    // DB when the adapter fails — visible in the list but impossible to address (confirmed with a
    // measurement).
    let handle: SessionHandle
    if (params.builderOf) this.appSessions.setBuilder(params.builderOf, id)
    // External apps (M4 A-5) — a worker gets these too. If the handle never comes up, the catch below closes
    // it
    const apps = this.apps.appsFor(info)
    // The same rule runs again on every wake (toolProfileOf). The builder slot was just written (setBuilder), so the
    // flag says what the row's slot already says
    const { profile, tools } = this.tools.toolChoice(info, !!params.builderOf)
    // Code intelligence (#686): decided once, here, from what the session is, and recorded below for every wake
    const noCodeIntelligence = codeIntelligenceOff({
      kind: info.kind,
      appId: info.appId ?? null,
      builder: !!params.builderOf,
      askedBy: info.askedBy ?? null,
      forkedFrom: info.forkedFrom ?? null,
      ...(params.lsp !== undefined ? { lsp: params.lsp } : {}),
    })
    const from = this.handleSink()
    this.record.unborn.set(id, [])
    try {
      handle = await adapter.createSession(
        this.launchOptions(info, {
          tool: params.tool, cwd, model: params.model, effort: params.effort,
          verbosity: params.verbosity,
          serviceTier: params.serviceTier,
          permissionPreset: params.permissionPreset, resumeExternalId: params.resumeExternalId,
          noCodeIntelligence,
          inheritsHandoff: !!params.handoff?.fromSessionId,
          choice: { profile, tools },
          apps,
          memory: false,
          // The answer schema an app supplied when it asked for this (M4 D-1) — Claude gets it on this
          // session's query, Codex gets it on every turn of this session
          ...(params.appAgent?.outputSchema ? { outputSchema: params.appAgent.outputSchema } : {}),
        }),
        from.sink,
      )
      from.own(handle)
      // The host began leaving while it came up (#839): its handles are let go of, so this one is stopped here
      if (this.lettingGo()) {
        await handle.dispose().catch(() => {})
        throw new Error('Centralu is restarting or quitting')
      }
    } catch (err) {
      this.record.unborn.delete(id)
      apps?.close()
      // A session that never came up is not a builder session — clear the slot the app points at
      if (params.builderOf) this.appSessions.setBuilder(params.builderOf, null, id)
      // If the adapter fails, nobody will ever use the worktree just created — do not leave an
      // orphaned directory behind. (A session that fails here is never even saved, so there is no
      // way to recover it later if it is not cleaned up now.)
      if (worktree) {
        await gitWorktreeRemove(params.cwd, worktree.path, true).catch(() => {})
        /*
         * The branch is deleted along with it (#167). It was created together with the worktree via
         * `-b`, so deleting only the directory would block re-creating one under the same name with
         * "already exists", and if no name was ever set, a fresh `centralu/…` piled up on every
         * failure. Since `-b` fails if the name already exists, any branch that got this far was just
         * created by this call, and has not a single commit on it.
         */
        await gitBranchDelete(params.cwd, worktree.branch, this.gitTrust(params.projectId)).catch(() => {})
      }
      const msg = (err as Error).message
      throw rpcError(`Could not start ${params.tool} session: ${msg}`)
    }

    this.meta.set(id, info)
    this.store.upsertSession(info)
    if (noCodeIntelligence) this.store.setAppSetting(codeIntelligenceKey(id), 'off')
    this.launches.rememberToolPrefix(id)
    this.launches.rememberLaunchSettings(info, cwd)
    this.store.setSessionCwd(id, cwd)
    /*
     * Lets the UI learn about this session **through an event too** (#69).
     *
     * Whichever side created it via RPC already knows from the response, but for a session the host
     * itself creates (the orchestrator's create_session, a manager created by worktree adoption),
     * this event is the only notification. Before this existed, that kind of session's event sat in
     * the pendingEvents holding area waiting for something to register it, and there was never
     * anything to register it — it only ever surfaced through listSessions after a reconnect. The
     * receiving side discards it (idempotently) if the session is already known.
     */
    this.emit({ type: 'session_created', sessionId: id, session: info })
    /*
     * **The tool picked most recently becomes this project's default.**
     *
     * default_tool was hardcoded to 'claude' at project creation and had no place that ever updated
     * it — someone using codex had to click the picker again for every single new session, forever.
     * Why this lives here instead of a settings screen: "what to use as the default" is **already
     * told to us by the act of creating a session.** So the UI and the orchestrator's create_session
     * both go through this same rule.
     */
    // The tool of an agent an app asked for (M4 D-1) is the app's choice — it never moves the person's
    // default
    if (params.projectId && !params.appAgent) {
      const owner = this.projectRow(params.projectId)
      if (owner && owner.defaultTool !== params.tool) {
        this.store.setProjectDefaultTool(params.projectId, params.tool)
        this.emit({ type: 'projects_changed' })
      }
    }
    this.handles.set(id, handle)
    // A new process holds no background work yet (#648)
    this.launches.rememberBackgroundTasks(info)
    // The cache's first request (§6.1): a new conversation, or one taken over from outside in a new process
    this.cacheLedger.note(id, params.resumeExternalId ? 'new_process' : 'cold_start')
    this.running.set(id, {
      model: info.model,
      effort: info.effort,
      verbosity: info.verbosity,
      serviceTier: info.serviceTier,
      permissionPreset: info.permissionPreset,
    })
    handle.applyRules?.(this.rulesFor(id, params.projectId))
    // What the tool said while it was starting, now that the session exists to record it (see `unborn`)
    const early = this.record.unborn.get(id) ?? []
    this.record.unborn.delete(id)
    for (const e of early) this.onEvent(e)

    // Restores past conversation. Done **after the adapter comes up** — a session with history but
    // no way to address it is just as bad as a ghost session.
    if (params.importHistory && params.resumeExternalId) {
      await this.externals.importHistory(info, adapter, params.resumeExternalId, params.cwd)
    }

    // The resume identifier is saved **immediately on creation.** Waiting for an event would mean
    // that if the host died before the first response, the session could never be resumed again (FR-10).
    if (handle.externalId) {
      info.externalId = handle.externalId
      this.store.upsertSession(info)
    }

    // Fetches skills ahead of time while the session is still alive.
    // Once it sleeps later there is no process to ask — this is prepared now for that moment.
    void this.listCommands(id).catch(() => {})

    /*
     * The first prompt is also **recorded under the same rule as send().**
     *
     * Just sending it to the adapter leaves the store without a first question — restarting would
     * produce a transcript that starts with an answer and nothing before it. The UI reconciles its
     * optimistic render against a user_message's seq, so this event is raised the same way send() does.
     */
    /*
     * A predecessor's note is **stamped as a marker** (#102).
     *
     * Back when the first message carried the note's full text, that text stayed in the conversation
     * on its own. Now that the first message only carries a path, leaving it at that would mean the
     * only original of what the agent wrote — unrecoverable once the predecessor is gone — exists in
     * a single file and nowhere else. It is stamped in the same slot, the same way, as a compaction
     * marker. The note itself does not ride along in the broadcast: what the screen draws is one
     * line, and the note is megabytes.
     */
    if (params.handoff) {
      const { from, fromSessionId } = params.handoff
      let { note } = params.handoff
      /*
       * The original's live children become this session's (#693), before its first turn reads the note: the note
       * opens with them, in the file the opening message points at and in the marker that keeps the note's original.
       * Nothing here awaits until the first message is sent, so a moved child's report cannot reach this session first.
       * When the window removes the original next (#738), every child moves, settled ones too, and the note lists them.
       */
      const moved = fromSessionId ? this.handoffChildren.moveChildren(fromSessionId, id, params.handoff.removesOriginal ? 'all' : 'live') : []
      if (moved.length) {
        note = movedChildrenNote(moved) + note
        try {
          if (fromSessionId && params.projectId) writeHandoffNoteSync(params.projectId, fromSessionId, note)
        } catch (e) {
          console.error(`[agent-host] handoff note not rewritten with the moved children: ${(e as Error).message}`)
        }
      }
      const seq = this.store.nextSeq(id)
      this.store.appendMessages([
        {
          sessionId: id,
          seq,
          role: 'system',
          kind: 'marker',
          // fromSessionId rides along too (#106) — it names the note file this session inherited,
          // and is the only way cleanup knows "this still has an owner"
          payload: { type: 'handoff', sessionId: id, seq, from, note, fromSessionId },
          ts: Date.now(),
        },
      ])
      info.lastSeq = seq
      this.emit({ type: 'handoff', sessionId: id, seq, from })
    }
    if (params.initialPrompt) {
      const seq = this.store.nextSeq(id)
      const from = params.initialFrom
      this.store.appendMessages([
        { sessionId: id, seq, role: 'user', kind: 'text', payload: { text: params.initialPrompt, ...(from ? { from } : {}) }, ts: Date.now() },
      ])
      info.lastSeq = seq
      info.lastReadSeq = seq // Something we sent counts as read
      this.store.upsertSession(info)
      this.emit({ type: 'user_message', sessionId: id, seq, text: params.initialPrompt, ...(from ? { from } : {}) })
      this.cardRests.turnAsked(id)
      handle.send(params.initialPrompt)
    }
    return info
  }

  /**
   * Resumes an existing session (FR-10). The path for continuing a conversation after the host is
   * turned off and back on.
   *
   * The process is gone, but external_id and the conversation record remain in the store. If the
   * adapter's resume succeeds, the same conversation continues; if it fails, it does **not die
   * quietly** — it is reported with `resumable: false`, so the UI can offer "view history + new
   * session".
   */
  /**
   * `lockedElsewhere` is **a signal, not a sentence.**
   *
   * If the reason were only given as a sentence, the UI would have to pattern-match that sentence
   * back with a regex — a contract that silently breaks the moment the wording changes. The fact
   * that another side holds this conversation is raised as its own flag, so the screen can decide
   * whether to offer "fork and continue" independent of the exact wording.
   */
  async resumeSession(
    sessionId: string,
    adopt?: AgentProcess,
  ): Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }> {
    // If it is already being resumed, wait on that same promise — if each caller started its own, two
    // processes would come up
    // A session going to sleep right now (#568) is resumed once its process is gone, never beside it
    const going = this.sleeping.get(sessionId)
    if (going) await going
    const inflight = this.resuming.get(sessionId)
    if (inflight) {
      // A kept process with a wake already under way would run beside the one it brings up (#839): stopped, unused
      if (adopt) {
        console.error(`[agent-host] kept process for ${sessionId.slice(0, 8)} met a wake already under way; stopping it`)
        adopt.kill('SIGTERM')
      }
      return inflight
    }
    const p = this.doResumeSession(sessionId, adopt).finally(() => this.resuming.delete(sessionId))
    this.resuming.set(sessionId, p)
    return p
  }

  /**
   * The options a session's process starts with (#428), the same for a new session (`createSession`) and a wake
   * (`doResumeSession`): what differs between the two is passed in, and the rest is read here, in the order both
   * used to read it. `memory`: the orchestrator's memory handoff rides along (a genuinely new process on a wake).
   */
  private launchOptions(
    m: SessionInfo,
    o: Pick<CreateSessionOpts, 'model' | 'effort' | 'verbosity' | 'serviceTier' | 'permissionPreset' | 'resumeExternalId' | 'knownGoal' | 'outputSchema'> & {
      tool: ToolName
      cwd: string
      adopt?: AgentProcess
      kept?: readonly BackgroundTask[] | null
      noCodeIntelligence: boolean
      inheritsHandoff: boolean
      choice: { profile: ToolProfile | null; tools: () => OrchestratorTools | undefined }
      apps: SessionApps | undefined
      memory: boolean
    },
  ): CreateSessionOpts {
    const { profile, tools } = o.choice
    return {
      sessionId: m.id,
      cwd: o.cwd,
      ...this.processSourceFor(m.id, o.tool, o.adopt, m.agentVersion, o.kept),
      model: o.model,
      effort: o.effort,
      verbosity: o.verbosity,
      serviceTier: o.serviceTier,
      permissionPreset: o.permissionPreset,
      resumeExternalId: o.resumeExternalId,
      ...(o.knownGoal ? { knownGoal: o.knownGoal } : {}),
      // Which settings files reach this session (decision 3, #92, #152) — what the session is,
      // and the trust at this exact moment of launch. If this is a builder session, the
      // directory above already points at this session (setBuilder)
      /*
       * Trust is **re-read every time it wakes** (decision 3, #92). Even if trust is changed
       * while a session is running, the tool process already read its files and stays as it was
       * — it picks up the changed value the next time it comes up (restart, resume). What it
       * trusts is decided by the same check used at creation (settingFilesFor) — a session waking
       * as a manager and a builder session both get the same answer here.
       */
      ...this.settingFilesFor(m),
      ...(o.noCodeIntelligence ? { noCodeIntelligence: true } : {}),
      // Reads an inherited note without asking (#142). No marker exists yet — it is stamped once this
      // session comes up
      // An inherited note must still be readable after waking up (#142) — the first message still points
      // at that path
      ...this.handoffNotes.handoffReadDirs(m.projectId, o.inheritsHandoff),
      // Paths another project handed back to this session (#371), asked on every read
      mayRead: (path: string) => this.mayRead(m.id, path, o.cwd),
      // An orchestrator gets all of them, a builder session (M4 C-3) just its own app's check (the bundle blocks
      // the rest), an ordinary session its own project, read-only (#320, #561)
      /*
       * **Tool and role must carry over on resume too.**
       *
       * Attaching them only at creation would mean a freshly woken orchestrator becomes an
       * ordinary session with neither tools nor a role — sitting in an empty folder able to do
       * nothing, while looking perfectly fine on the outside, which is the worst possible state.
       *
       * And this is exactly **where a manager becomes real** (#69): a session whose first child
       * has just been attached passes this check the next time it wakes and receives the
       * child-only tools and role.
       */
      orchestratorTools: tools(),
      toolProfile: profile ?? undefined,
      /*
       * This is **where memory is handed over.** Switching tools breaks externalId, which routes
       * things down this path (a new process), and that is when the past conversation rides along
       * with it. A session that came in through resume already has the tool holding its context,
       * so the same text is never inserted twice.
       */
      systemPromptAppend:
        m.kind === 'orchestrator'
          ? // Skills (#71) always ride along; the memory handoff only for a genuinely new process
            // (unchanged rule)
            orchestratorRole() + this.skillsPrompt() + (o.memory ? this.orchestratorMemory(m.id) : '')
          : // A builder session's (M4 C-2) role is entirely the roleAppend fixed at creation
            // Reapplying the fixed role text — for a coordinator session an older build left (#372), and
            // for a builder session (C-2) even if the app is broken
            (m.roleAppend ?? undefined),
      // The path back to the host — used by the orchestrator tools' bridge and an external app's bridge
      // (M4 A-5)
      orchestratorBridge: profile || o.apps ? (this.endpoint?.(m.id) ?? undefined) : undefined,
      // An MCP server the person approved is loaded here as a user-folder app (M4 A-7, decision 4)
      // An approved MCP server is a user-folder app — an orchestrator receives those apps right here (M4
      // A-7)
      apps: o.apps,
      ...(o.outputSchema ? { outputSchema: o.outputSchema } : {}),
    }
  }

  /**
   * The keeper as a `ProcessSource` for one session, when this host runs under one (#280 step 2). `version` is the CLI
   * version a process spawned now is started from, written on its keeper tag (#297).
   */
  private processSourceFor(
    sessionId: string,
    tool: ToolName,
    adopt?: AgentProcess,
    version?: string | null,
    /** The background tasks the previous host last saw running in the adopted process (#648), if it kept a list */
    kept?: readonly BackgroundTask[] | null,
  ): { processSource?: ProcessSource } {
    const host = this.keeperOpts.processes
    if (!host) return {}
    return {
      processSource: {
        spawn: (spec) => host.spawn(sessionId, tool, spec, version ?? undefined),
        ...(adopt ? { adopt: { process: adopt, openCalls: this.openToolCalls(sessionId), backgroundTasks: kept ?? [] } } : {}),
      },
    }
  }

  /** Says in the conversation that the restart in progress applies a change of the project's trust (#663) */
  private noticeTrustRestart(sessionId: string): void {
    if (!this.restartPolicy.trustRestartNotice.delete(sessionId)) return
    const m = this.meta.get(sessionId)
    if (!m || !this.handles.has(sessionId)) return
    const text = this.projectTrusted(m.projectId)
      ? "Restarted the agent to apply this project's new trust: it now reads the project's own settings and instruction files (CLAUDE.md, AGENTS.md)."
      : "Restarted the agent to apply this project's removed trust: it now reads only your own settings, not the project's files."
    this.onEvent({ type: 'notice', sessionId, level: 'info', from: 'Centralu', label: 'restart', text })
  }

  /** Tool calls the store holds for this session with no result after them (the newest 200 rows) */
  private openToolCalls(sessionId: string): { callId: string; tool: string }[] {
    const open = new Map<string, string>()
    for (const r of this.store.loadMessages(sessionId, 200)) {
      const p = r.payload as { callId?: unknown; summary?: { tool?: unknown } }
      if (typeof p?.callId !== 'string') continue
      if (r.kind === 'tool_call' && typeof p.summary?.tool === 'string') open.set(p.callId, p.summary.tool)
      else if (r.kind === 'tool_result') open.delete(p.callId)
    }
    return [...open].map(([callId, tool]) => ({ callId, tool }))
  }

  /**
   * Re-attaches the tool processes a previous host left running in the keeper (#280 step 2), so
   * those sessions come back live — mid-turn, with a waiting approval re-delivered by the tool —
   * instead of interrupted. Runs through `resumeSession`, so a screen asking to wake the same session
   * meanwhile joins this instead of starting a second process. A process with no session to go to
   * (deleted in between, or switched tool) is stopped: nobody could ever address it.
   */
  async adoptKept(kept: readonly KeptAgent[]): Promise<void> {
    await Promise.all(
      kept.map(async (k) => {
        const m = this.meta.get(k.sessionId)
        if (!m || m.tool !== k.tool) {
          console.error(`[agent-host] kept ${k.tool} process for ${k.sessionId.slice(0, 8)} has no session to go to; stopping it`)
          k.process.kill('SIGTERM')
          return
        }
        // An adopted process does not announce its CLI version again; its tag says what it was started from (#297)
        m.agentVersion = k.version ?? null
        const r = await this.resumeSession(k.sessionId, k.process).catch((err: Error) => ({ resumed: false, reason: err.message }))
        // A request queued for it under the old host goes in now if its turn ended during the swap (#677)
        if (this.children.queued.has(k.sessionId)) this.queue.scheduleDrain(k.sessionId)
        if (!r.resumed) {
          console.error(`[agent-host] could not re-attach ${k.sessionId.slice(0, 8)}: ${r.reason ?? 'unknown'}`)
          if (inTurn(m.state)) {
            // The same statement the window gets, through the same rules (#428)
            const change = { type: 'state_change' as const, sessionId: m.id, state: 'idle' as const, reason: 'reattach_failed' }
            this.applyStateHint(change, m)
            this.interruptions.markStoppedByQuit(m, true)
            this.store.upsertSession(m)
            this.emit(change)
            // Its turn is over: the report it owed says so now, rather than naming a later turn (#698)
            if (this.children.awaitingReport.has(m.id)) void this.reports.reportBackIfAwaited(m.id, { type: 'state_change', sessionId: m.id, state: 'idle' })
            else void this.reports.tellAskerOfInterruption(m.id, this.children.turnOwners.get(m.id)?.callerId)
          } else if (this.children.pausedReports.has(m.id)) {
            // The background work its report waited on went with the process (#721): the work stopped
            void this.reports.reportBackIfAwaited(m.id, { type: 'state_change', sessionId: m.id, state: 'idle' })
          }
        } else if (this.children.pausedReports.has(m.id)) {
          // Its background work may have ended during the swap with no turn following (#721)
          this.reports.settlePausedReport(m.id)
        }
      }),
    )
    this.tellQuitNotices(() => true)
  }

  /** Tells each requester of a turn a quit cut, once (#698); `ready` holds back one the keeper still has to hand over */
  private tellQuitNotices(ready: (requester: string) => boolean): void {
    // A host stopping before its first moment tells nobody; the next start does not repeat it either (the reset is done)
    if (this.disposing || this.handingOver) return
    const now = this.quitNotices.filter((n) => ready(n.requester))
    this.quitNotices = this.quitNotices.filter((n) => !ready(n.requester))
    for (const n of now) void this.reports.tellAskerOfInterruption(n.sessionId, n.requester)
  }

  private async doResumeSession(
    sessionId: string,
    adopt?: AgentProcess,
  ): Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }> {
    const m = this.openSession(sessionId)

    // If it is already alive, use it as-is (never create a duplicate process); a kept process offered too is stopped (#839)
    if (this.handles.has(sessionId)) {
      adopt?.kill('SIGTERM')
      return { session: m, resumed: true }
    }

    const tool = m.tool
    const adapter = this.adapters.get(tool)
    if (!adapter) return { session: m, resumed: false, reason: `No adapter for ${m.tool}` }
    if (!adapter.capabilities.resume) return { session: m, resumed: false, reason: `${m.tool} does not support resume` }
    /*
     * Picks the identifier to resume from.
     *
     * **If there is no externalId, the resumed-from original (importedFrom) is used.**
     * Claude gives the external id asynchronously through system/init, so a session that only ever
     * loaded a conversation and was never actually addressed never gets that value filled in. But by
     * definition such a session **does have an original id** — and that is exactly what it should
     * resume from. (Measured: sessions existed with ext=null but from=c1a50932 and 95 messages.)
     */
    const resumeId = m.externalId ?? m.importedFrom

    // An adopted process is the conversation itself, whatever ids the store has for it
    if (!resumeId && !adopt) {
      /*
       * **Tells apart what was actually lost from what was deliberately left behind.**
       *
       * This guard treats "there is history but no resume id" as an accident and blocks it — and it
       * should. But switching tools produces exactly the same shape **on purpose** (a new tool
       * cannot resume an old conversation). So the boundary is recorded at that moment, and if
       * nothing has been exchanged since, launching a new one is judged to lose nothing.
       * (If messages were exchanged after the boundary, that is the new tool's conversation, and it
       * does have an externalId.)
       */
      const boundary = Number(this.store.appSetting(freshStartKey(m.id)) ?? '-1')
      const newest = this.store.loadMessages(m.id, 1)[0]
      if (newest && newest.seq > boundary) {
        return {
          session: m,
          resumed: false,
          reason: 'Lost this session\'s resume id — the history is still readable, and you can continue in a new session',
        }
      }
      // No messages were exchanged = launching a new one loses nothing
    }

    /*
     * **An orchestrator has no project.**
     *
     * Requiring a project here meant an orchestrator died forever every time the app was restarted
     * ("Could not resume the conversation: Project not found" — measured). It was, in effect, a
     * session that could only be created but never resumed.
     */
    const project = m.projectId === null ? null : this.projectRow(m.projectId)
    if (m.projectId !== null && !project) return { session: m, resumed: false, reason: 'Project not found' }
    const cwd = this.cwdFor(m)

    /*
     * Checks first whether this conversation was deleted on the tool's side.
     *
     * Just trying to resume it anyway brings the process up, but the first turn dies with
     * error_during_execution (measured). That message tells the person nothing about the cause.
     * Knowing in advance that it is gone lets us say what happened and what can be done about it.
     */
    // If two sessions try to hold the same conversation, the tool refuses — block it first and report who
    // holds it
    if (resumeId && !adopt) {
      const holder = this.externals.holderOf(resumeId, sessionId)
      if (holder) {
        return {
          session: m,
          resumed: false,
          reason: `The "${holder.name}" session already has this conversation open (two sessions cannot share one conversation)`,
          lockedElsewhere: true,
        }
      }
    }

    /*
     * Times each stage — **so a resume that succeeds but is slow still leaves a trace.**
     *
     * A timeout message only ever attaches to a failure. A resume that takes 9 seconds and succeeds
     * leaves nothing in the log at all, so when someone reported "waking up feels slow", the only
     * way to answer which stage ate the time was writing a fresh measurement script from scratch
     * (which is literally what happened during dogfooding). The single line below stays in host.log:
     * check (listing), start (process + resume), catch-up.
     */
    const t0 = Date.now()
    // A running process is proof enough that its conversation exists (and asking codex would start another app-server)
    const gone = adopt ? false : await this.externals.externalGone(m, cwd)
    const tCheck = Date.now() - t0
    if (gone) {
      return { session: m, resumed: false, reason: externalMissingReason(this.toolLabel(m.tool), cwd) }
    }

    // External apps (M4 A-5) — decision 4 is re-checked **right now** even on resume (an app could have come
    // or gone in between)
    const apps = this.apps.appsFor(m)
    // If this is a builder session, it gets its own app's check (C-3) — the directory is re-checked right now
    // (a different session could have taken over in between)
    const builds = this.appSessions.builderRefOf(m) !== null
    const { profile, tools } = this.tools.toolChoice(m, builds)
    const from = this.handleSink()
    /*
     * **The configuration the process will receive is read here, exactly once** (#162). If the
     * person changes settings while the process is being awaited below, `m` changes — if `running`
     * were filled by re-reading `m` after the wait, it would record the changed value instead of what
     * the process actually received, and updateSettings' comparison would never be able to detect the
     * mismatch (someone picks "safe" and it keeps running as "auto").
     */
    const launched = {
      model: m.model,
      effort: m.effort,
      verbosity: m.verbosity,
      serviceTier: m.serviceTier,
      permissionPreset: m.permissionPreset,
    }
    /*
     * The CLI version this process runs, until it says (#297): a new process starts from what is installed now. An
     * adopted one keeps the version its keeper tag gave (adoptKept) — it was started long before.
     */
    if (!adopt) m.agentVersion = this.versionHint?.(tool) ?? null
    // What the previous host saw running in the process this one adopts (#648); null when it kept no list
    const kept = adopt ? this.launches.keptBackgroundTasks(sessionId) : null
    try {
      const creating = adapter.createSession(
        this.launchOptions(m, {
          tool,
          cwd,
          adopt,
          kept,
          model: launched.model ?? undefined,
          effort: launched.effort ?? undefined,
          verbosity: launched.verbosity ?? undefined,
          serviceTier: launched.serviceTier ?? undefined,
          permissionPreset: launched.permissionPreset,
          resumeExternalId: resumeId ?? undefined,
          // The goal survives in the tool's conversation, not in a new one (see CreateSessionOpts.knownGoal)
          ...(resumeId && m.goal ? { knownGoal: m.goal } : {}),
          noCodeIntelligence: this.launches.codeIntelligenceOffFor(sessionId),
          inheritsHandoff: this.store.inheritsHandoff(sessionId),
          choice: { profile, tools },
          apps,
          memory: !resumeId,
        }),
        from.sink,
      )
      /*
       * **This used to be an unbounded wait** — and that wait was holding this function's only
       * in-progress (resuming) promise. If the tool got stuck coming up, the outer RPC gave up at 30
       * seconds, but this promise never resolved, and because of dedup, Retry would **rejoin that
       * same stuck promise**. To the person it looked like "Retry does not work" (measured on an MGH
       * session).
       *
       * Why 150 seconds: it needs to stay inside resume-family RPCs' 180-second limit (LONG_CALLS in
       * rpc-client), so the screen gets a reason named for this stage instead of an unnamed RPC
       * timeout, and `resuming` also gets released at that point so Retry becomes a real retry. (It
       * used to be 25/30 seconds, and was raised after confirming that codex's thread/resume scales
       * with rollout size — measured at roughly 550MB in 13.5 seconds. A "resource upload" session was
       * hitting the 25-second wall and could never wake up.)
       *
       * Even if the timeout wins, the tool process can still be up somewhere — if it arrives later, it
       * is reclaimed. Failing to reclaim it would leave an app-server quietly holding a locked thread.
       */
      const tStartFrom = Date.now()
      const handle = await withTimeout(creating, 150_000, `Starting ${m.tool}`).catch((err) => {
        void creating.then((h) => (from.own(h), h.dispose())).catch(() => {})
        // This attaches a handle that never came up in time — a handle arriving late is disposed above and
        // closed here too
        apps?.close()
        throw err
      })
      const tStart = Date.now() - tStartFrom
      from.own(handle)
      /*
       * **If the session was deleted or its tool was switched while this wait was in flight, this
       * handle has nowhere to go** (#163). It used to be inserted without this check, and the row
       * rewritten — a deleted session would come back to life in the store and reappear in the list
       * on the next startup, with its process running until the host itself was shut off (holding the
       * thread's write lock the whole time, if it was Codex). For a session that switched tools, the
       * old tool's process survived and kept receiving messages, and the old tool's conversation id
       * got written into the new tool's slot.
       */
      const leaving =
        this.leaving.get(sessionId) ??
        (!this.meta.has(sessionId) ? 'The session was deleted while waking'
        : m.tool !== tool ? 'The session switched tools while waking'
        // The host is leaving (#839): its handles are let go of, so one registered now would be nobody's
        : this.lettingGo() ? 'Centralu is restarting or quitting'
        : null)
      if (leaving) {
        // Waits for it to close — whichever side is deleting it goes on to delete the tool-side conversation
        // too (Codex holds its lock the whole time it runs)
        await handle.dispose().catch(() => {})
        return { session: m, resumed: false, reason: leaving }
      }
      this.handles.set(sessionId, handle)
      if (!adopt) {
        this.launches.rememberToolPrefix(sessionId)
        this.launches.rememberLaunchSettings(m, cwd)
        // A new process holds no background work yet (#648); whatever an earlier adopted one left unknown is over
        this.restartPolicy.backgroundUnknown.delete(sessionId)
        this.launches.rememberBackgroundTasks(m)
      }
      // Every window learns it is awake, not only the one that asked (#568)
      this.emit({ type: 'session_live', sessionId, live: true })
      // Why the process came up again, if a restart said so; a wake, a revive or a manual restart otherwise (§6.1)
      this.cacheLedger.note(sessionId, this.restartPolicy.restartReasons.get(sessionId) ?? 'new_process')
      this.restartPolicy.restartReasons.delete(sessionId)
      this.running.set(sessionId, launched)
      handle.applyRules?.(this.rulesFor(sessionId, m.projectId))
      // The identifier may only now be available — record it for the next resume
      if (handle.externalId && handle.externalId !== m.externalId) m.externalId = handle.externalId
      if (adopt) {
        /*
         * A re-attached process keeps the state it had (#280 step 2): a running turn is still
         * running, and a waiting approval has been, or is about to be, re-delivered by the tool —
         * which sets the state itself. Forcing `idle` here would tear down that fresh card.
         */
        this.store.upsertSession(m)
        this.emit({ type: 'state_change', sessionId, state: m.state, reason: 'reattached' })
        /*
         * And it keeps its background work (#648): the shells the previous host saw running still run in it, and the
         * tool will not list them again until something changes. They are listed from the kept record, as the tool's
         * own level would be; with no record (the previous host predates it), the session is held as unknown until
         * the tool first speaks, rather than read as idle and put to sleep over a running dev server.
         */
        if (kept === null) this.restartPolicy.backgroundUnknown.set(sessionId, Date.now())
        // Listed through onEvent, which also keeps the record for the host after this one
        else if (kept.length > 0) this.onEvent({ type: 'background_tasks', sessionId, live: kept })
      } else {
        this.settleState(m, { type: 'state_change', sessionId, state: 'idle', reason: 'resumed' })
      }
      void this.listCommands(sessionId).catch(() => {})

      // Catches up on conversation continued outside (in a terminal's tool).
      // An orchestrator is a session the app manages, so there is nothing for it to catch up on
      // outside — since it has no project, this branch never fires for it in the first place
      // (an orchestrator with a project no longer exists).
      // Not for a re-attached process: what it said meanwhile arrives from the keeper's buffer, and
      // reading it from the transcript too would record it twice.
      let tCatchup = 0
      let added = 0
      if (project && !adopt) {
        // Even if catch-up stalls, the session is already alive — do not block on it, leave it for next time
        const tCatchupFrom = Date.now()
        const catchingUp = this.externals.syncImportedHistory(m, adapter)
        added = await withTimeout(catchingUp, 10_000, 'History catch-up').catch(() => {
          // Past the bound it goes on, and what it adds lands later: the windows are told then (#839)
          void catchingUp.then((late) => {
            if (late > 0 && this.meta.has(sessionId)) this.emit({ type: 'history_synced', sessionId, added: late })
          }, () => {})
          return 0
        })
        tCatchup = Date.now() - tCatchupFrom
        if (added > 0) this.emit({ type: 'history_synced', sessionId, added })
      }
      // If catchup is under a few hundred ms, it was skipped (nothing changed, so the full transcript was
      // never read)
      console.error(
        `[agent-host] ${adopt ? 're-attached' : 'resumed'} ${sessionId.slice(0, 8)} tool=${m.tool} ` +
          `check=${tCheck}ms start=${tStart}ms catchup=${tCatchup}ms added=${added} total=${Date.now() - t0}ms`,
      )
      return { session: m, resumed: true }
    } catch (err) {
      /*
       * Only digs into why it failed **after** it has already failed.
       *
       * Used to query the tool's list before every resume, but codex spins up an app-server every
       * time that happens, so every session pick paid a few extra seconds (a dogfooding finding). An
       * expensive check only runs when something has actually gone wrong — the happy path has to stay fast.
       */
      // A cap applies to this after-the-fact check too — the worst outcome would be holding the real
      // failure reason (err) but losing it because the check itself hung. The same rule as elsewhere:
      // if it cannot be determined, it does not block (false).
      // A kept process that could not be re-attached has nobody left to address it
      if (adopt) {
        adopt.kill('SIGTERM')
        return { session: m, resumed: false, reason: (err as Error).message }
      }
      const gone = await withTimeout(this.externals.externalGone(m, cwd), 8_000, 'Checking the tool').catch(() => false)
      if (gone) {
        return { session: m, resumed: false, reason: externalMissingReason(this.toolLabel(m.tool), cwd) }
      }
      /*
       * The adapter tells us with a code that "another side is holding this conversation" (codex's
       * lock). Only that code is read, never a message re-parsed — this is the basis on which the
       * screen offers a fork.
       */
      const locked = (err as { code?: string }).code === 'conversation_locked'
      return { session: m, resumed: false, reason: (err as Error).message, lockedElsewhere: locked || undefined }
    }
  }

  /**
   * **Forks off** from a locked conversation and continues in this session instead.
   *
   * The original is left untouched — a conversation another app was using is never taken away. Only
   * this session's externalId is changed to point at the new copy, and then it is resumed. Someone
   * reaching this point has already seen "already open elsewhere" and chosen this themselves, so it
   * is never asked again.
   *
   * Our store's conversation record is not touched at all. What the person sees on screen stays
   * exactly as it was, and only what happens from here on piles up in the copy.
   */
  async forkConversation(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }> {
    const m = this.openSession(sessionId)

    const source = m.externalId ?? m.importedFrom
    if (!source) {
      return { session: m, resumed: false, reason: 'This session has no conversation to fork from' }
    }

    const adapter = this.adapters.get(m.tool)
    if (!adapter?.forkConversation) {
      // If it cannot do this, say so — quietly doing nothing is far worse
      return { session: m, resumed: false, reason: `${m.tool} cannot fork a conversation` }
    }

    const tool = m.tool
    try {
      const forked = await adapter.forkConversation(source, this.cwdFor(m))
      // Deleted or switched while the tool forked (#839): the copy read before is not written back
      if (this.meta.get(sessionId) !== m || m.tool !== tool) return { session: m, resumed: false, reason: 'The session was deleted or switched tools while its conversation was forked' }
      m.externalId = forked
      this.store.upsertSession(m)
    } catch (err) {
      return { session: m, resumed: false, reason: (err as Error).message }
    }

    return this.resumeSession(sessionId)
  }

  /** Withdraws an in-progress wake and waits for it to finish (leaving) — called first by delete and
   * tool-switch (#163) */
  private async untilWakeWithdrawn(sessionId: string, why: string): Promise<void> {
    const waking = this.resuming.get(sessionId)
    if (!waking) return
    this.leaving.set(sessionId, why)
    try {
      await waking.catch(() => {})
    } finally {
      this.leaving.delete(sessionId)
    }
  }

  /** `SessionTrash.trashSession` (session-trash.ts), kept on the manager for its callers */
  trashSession(...a: Parameters<SessionTrash['trashSession']>): ReturnType<SessionTrash['trashSession']> {
    return this.trash.trashSession(...a)
  }

  /** The startup repair of recovery folders an interrupted purge left aside (#647) */
  private recoveryRepair: Promise<void> = Promise.resolve()

  /** `SessionTrash.listTrash` (session-trash.ts), kept on the manager for its callers */
  listTrash(...a: Parameters<SessionTrash['listTrash']>): ReturnType<SessionTrash['listTrash']> {
    return this.trash.listTrash(...a)
  }

  /** `SessionTrash.readTrashed` (session-trash.ts), kept on the manager for its callers */
  readTrashed(...a: Parameters<SessionTrash['readTrashed']>): ReturnType<SessionTrash['readTrashed']> {
    return this.trash.readTrashed(...a)
  }

  /** `SessionTrash.restoreSession` (session-trash.ts), kept on the manager for its callers */
  restoreSession(...a: Parameters<SessionTrash['restoreSession']>): ReturnType<SessionTrash['restoreSession']> {
    return this.trash.restoreSession(...a)
  }

  /** `SessionTrash.purgeSession` (session-trash.ts), kept on the manager for its callers */
  purgeSession(...a: Parameters<SessionTrash['purgeSession']>): ReturnType<SessionTrash['purgeSession']> {
    return this.trash.purgeSession(...a)
  }

  /** `SessionTrash.emptyTrash` (session-trash.ts), kept on the manager for its callers */
  emptyTrash(...a: Parameters<SessionTrash['emptyTrash']>): ReturnType<SessionTrash['emptyTrash']> {
    return this.trash.emptyTrash(...a)
  }

  async updateSettings(
    sessionId: string,
    s: { model?: string | null; effort?: string | null; verbosity?: string | null; serviceTier?: string | null; permissionPreset?: PermissionPreset },
    by: 'person' | 'orchestrator' = 'person',
  ): Promise<SessionInfo & { applied: SettingsApplied }> {
    const m = this.openSession(sessionId)

    // Another model reads none of this one's cache (§6.1), whether it applies live or through a restart
    if (s.model !== undefined && s.model !== m.model) this.cacheLedger.note(sessionId, 'model_change')
    if (s.model !== undefined) m.model = s.model
    if (s.effort !== undefined) m.effort = s.effort
    if (s.verbosity !== undefined) m.verbosity = s.verbosity
    if (s.serviceTier !== undefined) m.serviceTier = s.serviceTier
    const wasAuto = m.permissionPreset === 'auto'
    if (s.permissionPreset) m.permissionPreset = s.permissionPreset
    this.store.upsertSession(m)
    if (wasAuto && m.permissionPreset !== 'auto') this.queue.dropOpenedByAuto(sessionId)
    /*
     * The model and effort chosen most recently become this project's default (#69, item 5). The
     * same lesson default_tool learned: instead of building a settings screen, the fact is recorded
     * that the act of choosing already told us. This is where the repetition ends for someone using
     * Opus/high who had to click through the same four clicks on every new session.
     *
     * **Recorded under this session's own tool slot** (#107). There used to be only one slot, which
     * had to be guarded with the condition "only record a choice from a session using the project's
     * default tool" — and that condition broke the moment the default tool changed: a single codex
     * session switching the default back to codex would let the next codex choice overwrite the value
     * saved for claude. Now that the tool is part of the key, no condition is needed: any tool's
     * choice lands only in its own slot.
     */
    if ((s.model !== undefined || s.effort !== undefined) && m.projectId) {
      const before = this.store.projectToolDefaults(m.projectId)[m.tool]
      this.store.setProjectToolDefaults(m.projectId, m.tool, { model: m.model, effort: m.effort })
      // Another window starts its next session on what this one chose last (#719)
      if ((before?.model ?? null) !== (m.model || null) || (before?.effort ?? null) !== (m.effort || null)) this.emit({ type: 'projects_changed' })
    }
    /*
     * **Every client hears about a saved change** (#659). The caller gets the answer, but another window, a linked
     * machine, or the person's own window when an agent made the call only learned the new values from a re-list.
     * The permission preset is among them, and it is shown on screen as a safety fact. Sent as soon as the change is
     * saved, with the full snapshot, before the wait below: whether the process takes it now, after the turn or on
     * the next wake does not change what the session is set to.
     */
    this.emit({
      type: 'settings_changed',
      sessionId,
      model: m.model,
      effort: m.effort,
      verbosity: m.verbosity,
      serviceTier: m.serviceTier,
      permissionPreset: m.permissionPreset,
      ...(by === 'person' ? { person: true } : { by }),
    })

    /*
     * **If a wake is in progress, this waits for it before comparing** (#162). While that wait is in
     * flight there is no handle, so the comparison below would do nothing, and the process that comes
     * up would run with the value from before the change — the screen says safe, the process runs
     * auto. A second change arriving mid-restart lands in the same window too (while restartSession is
     * tearing down and re-creating the handle). Since the save already happened above, even if this
     * call is interrupted while waiting, the next time it comes up it comes up with the new value.
     */
    await this.resuming.get(sessionId)?.catch(() => {})

    const handle = this.handles.get(sessionId)
    handle?.updateSettings?.(s)

    // The comparison baseline is not the screen's value (meta) but **the configuration the running process
    // actually has**
    const drifted = this.restartPolicy.settingsDrifted(sessionId)

    /**
     * Permissions and model are **fixed the moment the tool process is launched.**
     * Claude receives permissionMode at the start of query(), and Codex receives approvalPolicy at
     * thread/start. So fixing only the metadata of a living session leaves the screen saying "auto"
     * while it keeps asking for approval anyway — this surfaced during dogfooding as "I changed
     * permissions to auto, so why does it keep asking".
     *
     * If the adapter does not support applying it live, **the process itself is swapped.**
     * The conversation is not interrupted, since resume carries it forward. Better than silently
     * ignoring the change.
     */
    let applied: SettingsApplied = 'saved'
    if (drifted && handle && !handle.updateSettings) {
      /*
       * **A running turn is never interrupted** (#164) — the change is only saved, and the swap
       * happens when the turn ends (completed, error, canceled — in onEvent). This keeps what the
       * person is told ("starting next turn") consistent with what actually happens. The
       * orchestrator's own settings tool goes through this same path too.
       */
      if (inTurn(m.state)) {
        this.restartPolicy.restartAfterTurn.add(sessionId)
        applied = 'after_turn'
      } else {
        applied = (await this.restartSession(sessionId, this.restartPolicy.restartCause(sessionId))).resumed ? 'restarted' : 'saved'
      }
    }

    return { ...m, live: this.handles.has(sessionId), applied }
  }

  /** Whether a session's process is alive (what the UI uses to know if it can be continued) */
  isLive(sessionId: string): boolean {
    return this.handles.has(sessionId)
  }

  /**
   * The event sink handed to an adapter — **it carries which handle sent it** (#157).
   *
   * Every handle used to receive the same callback, so the manager could only look at the session id
   * and read an event as coming from "whichever handle is currently registered". When a settings
   * change swapped the process, a late message from the old handle (text from a turn that was
   * winding down, a late adapter_crashed) would be attributed to the new handle, and a late crash
   * would tear down the freshly launched process. A message that arrives before a handle has been
   * placed (before `own`) has no known owner yet, so it is still received the same way as now.
   */
  private handleSink(): { sink: EventSink; own: (h: SessionHandle) => void } {
    let handle: SessionHandle | null = null
    return {
      sink: (e) => this.onEvent(e, handle),
      own: (h) => {
        handle = h
      },
    }
  }

  /** Receive event -> update metadata -> persist message -> broadcast */
  private onEvent(raw: NormalizedEvent, from: SessionHandle | null = null): void {
    const e = raw.type === 'files_touched' ? this.projectRelative(raw) : raw
    /*
     * **A message from a handle that has already been set aside is never accepted** (#157) — anything
     * not from the handle currently registered for that session is dropped. It never enters the crash
     * branch (does not close the new handle), and does not record either the text from the turn that
     * was winding down or its turn_complete.
     *
     * The only exception is a message that closes something showing on screen — the approval and
     * question cards, and the agent card, that a handle releases as it closes. Dropping those too
     * would leave the card stuck forever (see the comment on dispose). The manager calls the dispose
     * that produces that message **before** removing the handle, so a different message issued during
     * close (notice of a message that could not be sent) still arrives as a message from the
     * registered handle.
     */
    if (
      from &&
      e.sessionId &&
      this.handles.get(e.sessionId) !== from &&
      e.type !== 'approval_resolved' &&
      e.type !== 'question_resolved' &&
      e.type !== 'tool_result' &&
      e.type !== 'background_tasks'
    ) {
      return
    }
    /*
     * A set-aside handle's background work (#290) — only its endings are its to say. Its tasks went with its process,
     * and the live set belongs to the handle now registered, which a late empty set from the old one must not wipe.
     */
    if (from && e.type === 'background_tasks' && this.handles.get(e.sessionId) !== from) {
      const m = this.meta.get(e.sessionId)
      if (!m || !e.ended?.length) return
      return this.onEvent({ ...e, live: m.backgroundTasks.filter((t) => t.status === 'running') })
    }
    const unborn = e.sessionId && !this.meta.has(e.sessionId) ? this.record.unborn.get(e.sessionId) : undefined
    if (unborn) {
      unborn.push(e)
      return
    }
    if (e.type === 'subagent_event') {
      this.record.recordSubagentStep(e)
      return
    }
    if (e.type === 'settings_changed' && e.by === 'tool') {
      this.record.recordToolSettings(e)
      return
    }
    // Text the tool repeats on every start (#304): one stored line per session is enough
    if (e.type === 'notice' && e.oncePerSession && e.sessionId && this.store.hasNotice(e.sessionId, e.text)) return
    let seq: number | null = null
    /** This event ended the turn — how it ended (completed, error, canceled, limit) is stated by this event
     * itself */
    let endedTurn = false
    /** The session's interruption before this event (#698); `undefined` when the event belongs to no known session */
    let interruptionBefore: Interruption | null | undefined
    if (e.sessionId) {
      const m = this.meta.get(e.sessionId)
      if (m) {
        const handle = this.handles.get(e.sessionId)
        if (handle?.externalId && m.externalId !== handle.externalId) {
          m.externalId = handle.externalId
        }
        const wasBusy = inTurn(m.state)
        const before = m.state
        this.applyStateHint(e, m)
        this.cardRests.note(e, m.id, before)
        interruptionBefore = m.interruption ?? null
        this.interruptions.trackInterruption(e, m, wasBusy && !inTurn(m.state))
        // Heard from: an unknown background state is bounded by quiet, not by age (#648, `backgroundKnown`)
        if (this.restartPolicy.backgroundUnknown.has(m.id)) this.restartPolicy.backgroundUnknown.set(m.id, Date.now())
        /*
         * A builder session's turn ended (M4 C-4) — this is the moment to relaunch that app from its
         * files. It happens once, right here, rather than every time the app's folder changes: an app
         * mid-turn is code that is only half fixed. The runtime itself decides whether it actually
         * changed or whether a call is still in flight.
         */
        // The queued request being delivered started its turn (#684 review): only now is it off the queue and the store
        if (!wasBusy && inTurn(m.state)) this.children.queuedTurnStarted(m.id)
        /*
         * Or the tool refused it outright (#839): an error or a usage limit, and no turn starts. The request is done with
         * all the same, and this is its turn's end: its requester is told, the turn it owned is released, the next request
         * goes in. Left delivering, the session counted as busy for every requester and its queue never moved again. Only
         * once the input was handed to the process: one the tool reports while the session wakes for it (Codex's account-wide
         * limit, a crash) refuses nothing yet, and the input still goes in or the delivery fails on its own.
         */
        if (!wasBusy && !inTurn(m.state) && (e.type === 'error' || e.type === 'limit_reached') && this.children.delivering.has(m.id) && this.queue.queuedHandedIn.has(m.id)) {
          this.children.queuedTurnStarted(m.id)
          endedTurn = true
        }
        if (wasBusy && !inTurn(m.state)) {
          endedTurn = true
          const ref = this.appSessions.builderRefOf(m)
          if (ref) this.apps.appsHub?.rt.builderTurnEnded(ref)
        }
        seq = this.record.persistMessage(e, m)
        // An image is persisted as a file (#40, part 2) — it is async, so no seq is taken here
        if (e.type === 'message_image') void this.record.persistImage(e, m)
        // Commit attribution (#50) — caught in passing whenever a git commit tool call goes by
        if (e.type === 'tool_call' || e.type === 'tool_result') this.observeCommit(e, m)
        this.store.upsertSession(m)
      }
      /*
       * **A dead process's handle is removed right on the spot.**
       *
       * Raising adapter_crashed while leaving the handle in place means send() would only check
       * handles.has, push onto an already-dead queue, and **the next message would silently
       * disappear** (until an explicit restart). Removing it means send()'s "resume if missing" path
       * becomes automatic recovery on its own.
       */
      // A lock error after a lazy resume handed the handle out (#168, item 5) leaves a handle with no thread — the same as a crash
      if (e.type === 'error' && (e.error.code === 'adapter_crashed' || e.error.code === 'conversation_locked')) {
        const dead = this.handles.get(e.sessionId)
        if (dead) {
          // Closed before it is removed — so a message issued during close (notice of an unsent message)
          // still arrives as a message from the registered handle (#157)
          void dead.dispose().catch(() => {})
          this.handles.delete(e.sessionId)
          this.running.delete(e.sessionId)
          // No process any more, and none coming by itself (#648): the windows stop showing it live
          this.emit({ type: 'session_live', sessionId: e.sessionId, live: false, reason: 'crashed' })
        }
      }
    }
    // An event that gets recorded carries its assigned in-session seq along with it — the basis for the UI's
    // unread tracking
    // Capture the answer before an event subscriber can send more input into this conversation.
    const run = e.sessionId ? this.agentRuns.get(e.sessionId) : undefined
    // A wait still reading this turn is owed its end (#698); one that settled earlier is left from a turn before
    const runOpen = !!run && !run.finished
    /*
     * A delegation nobody is waiting on now (ask_project or start_agent past its bound) owes its caller nothing until
     * it asks again; that caller is who hears of a stop. A call still waiting reads the stop itself.
     */
    const delegation = runOpen ? [...this.children.delegations.values()].find((d) => d.wait === run) : undefined
    const waited = runOpen && (!delegation || (delegation.waiters ?? 0) > 0)
    run?.onEvent(e)
    if (e.sessionId) for (const observer of this.turnObservers.get(e.sessionId) ?? []) observer.onEvent(e)
    this.emit(seq != null ? ({ ...e, seq } as NormalizedEvent) : e)
    this.closeIntoRest(e)
    // After the event that caused it, so a window reads the error first and the reason for it second (#698)
    const nowInterrupted = e.sessionId ? this.meta.get(e.sessionId)?.interruption ?? null : null
    if (e.sessionId && interruptionBefore !== undefined && nowInterrupted !== interruptionBefore) {
      this.emit({ type: 'interruption', sessionId: e.sessionId, interruption: nowInterrupted })
    }
    // Whether anyone is owed this turn's end: a report mark, or a delegation reading it (#698). Read before the report clears the mark
    const owed = endedTurn && !!e.sessionId && (this.children.awaitingReport.has(e.sessionId) || waited)
    /*
     * Reporting happens **no matter how the turn ends** (#166). It used to only consume the marker on
     * turn_complete, but two adapters do not emit turn_complete for a failed turn (emitting it there
     * too would end the state as "awaiting input" and hide the failure). So a failed run was never
     * reported, the marker stayed set, and a later, unrelated turn ended up reported as "it finished".
     */
    // A wait settled in an earlier turn holds that turn's answer, not this one's
    if (endedTurn && e.sessionId && !run?.tracksInputs) void this.reports.reportBackIfAwaited(e.sessionId, e, runOpen ? run?.completedAnswer : undefined)
    if (endedTurn && e.sessionId && !owed) void this.reports.tellAskerOfInterruption(e.sessionId, delegation?.callerId)
    // A card in a delegated turn goes to the session that gave the turn too (#676); a turn-long link ends with the turn
    if ((e.type === 'question_request' || e.type === 'approval_request') && e.sessionId) this.cards.routeCard(e.sessionId, e.requestId, e.type === 'question_request' ? 'question' : 'approval')
    if (endedTurn && e.sessionId && this.children.turnOwners.get(e.sessionId)?.untilTurnEnd) this.children.releaseTurn(e.sessionId)
    // A hub's ask_project task ends with its turn, and the depth it gave the session with it (#838)
    if (endedTurn && e.sessionId && !this.hubAskTurns.has(e.sessionId) && this.store.appSetting(hubAskDepthKey(e.sessionId)) !== null) this.store.deleteAppSetting(hubAskDepthKey(e.sessionId))
    // The card slot is now empty — if a capability question was waiting, it is raised (D-4). Either the
    // adapter's card just closed, or a card that had been hiding ours just closed
    if (e.type === 'approval_resolved' && e.sessionId) this.hostCards.raiseHostAsks(e.sessionId)
    /*
     * A card still standing when the turn ends is raised again (#673): a start_agent request that answered "pending"
     * outlives the call, and the turn's own events cleared the slot meanwhile. An error is left showing; the card
     * comes back at the next turn's end
     */
    if (endedTurn && e.sessionId && this.meta.get(e.sessionId)?.state !== 'error') this.hostCards.raiseHostAsks(e.sessionId)
    // Applies a setting that changed mid-turn now (#164) — if it was reverted in between there is no drift,
    // so nothing happens
    // A commit call still unanswered when its turn ends never will be: interrupted, or its process gone (#392)
    if (endedTurn && e.sessionId) this.forgetCommits(e.sessionId)
    if (endedTurn && e.sessionId) this.restartPolicy.applyDeferredRestart(e.sessionId)
    // A deferred restart also waits for the session's background work (#648): the moment it ends is a boundary too
    if (e.type === 'background_tasks' && e.sessionId) this.restartPolicy.applyDeferredRestart(e.sessionId)
    // A paused report's work may just have ended (#721)
    if (e.type === 'background_tasks' && e.sessionId && this.children.pausedReports.has(e.sessionId)) this.reports.settlePausedReport(e.sessionId)
  }

  /** A queued note not yet taken, on the delegation's wait or an observer's own reader (#646): the session is not between turns */
  private inputsHeld(sessionId: string): boolean {
    if (this.agentRuns.get(sessionId)?.waitingForInputs) return true
    for (const observer of this.turnObservers.get(sessionId) ?? []) if (observer.waitingForInputs) return true
    return false
  }

  /** A state hint, for storage: the core reducer's rules on the host's copy (`applySessionState`, protocol session-state.ts) */
  private applyStateHint(e: NormalizedEvent, m: SessionInfo): void {
    const from = m.state
    // An illegal transition is ignored and logged, as the window does (docs/state-management.md §2)
    if (applySessionState(m, e, Date.now()).illegal) console.warn(`[agent-host] ignored ${e.type} for ${m.id.slice(0, 8)}: ${from} cannot go to ${nextStateFor(e)}`)
    this.trackLiveFacts(e, m)
  }

  /** The rest an adapter's card raised between turns was raised in (`CardRests`, card-rest.ts), written to the store */
  private cardRests: CardRests

  /**
   * An adapter's card raised between turns closes back into that rest once answered (#428), as the host's own cards do
   * (`restAfterCard`, host-cards.ts): without `onEvent`, since no turn ended (no report, no deferred restart).
   */
  private closeIntoRest(e: NormalizedEvent): void {
    const m = e.sessionId ? this.meta.get(e.sessionId) : undefined
    const rest = m ? this.cardRests.restAfter(e, m) : null
    if (!m || rest === null) return
    this.settleState(m, { type: 'state_change', sessionId: m.id, state: rest })
  }

  /**
   * A state the host itself states (a resume, a tool change, a card's rest): through the same rules as an event, so the
   * stored copy is what the window makes of the same `state_change` (#428), then stored and broadcast. Not `onEvent`:
   * no turn ended.
   */
  private settleState(m: SessionInfo, change: Extract<NormalizedEvent, { type: 'state_change' }>): void {
    // The host has said what the state is: no card rest or asked-for turn of before stands over it
    this.cardRests.forget(m.id)
    this.applyStateHint(change, m)
    this.store.upsertSession(m)
    this.emit(change)
    // At rest by a statement, not a turn's end that `onEvent` would see: a request queued for it goes in now (#677)
    if (!inTurn(m.state) && this.children.queued.has(m.id)) this.queue.scheduleDrain(m.id)
  }

  /**
   * Records the **live facts** in metadata that a reconnected UI needs to pick back up.
   *
   * While SessionInfo had none of these fields, a UI that disconnected and came back received only
   * state=waiting_approval, and **had no payload to draw the approval card with** — with no requestId
   * either, it could not even respond. These are never put in the DB (upsert does not know these
   * fields) — if the host restarts, they really are gone. The cards, the activity and the limit are set with the
   * state they belong to (`applySessionState`, protocol session-state.ts); these are the rest.
   */
  private trackLiveFacts(e: NormalizedEvent, m: SessionInfo): void {
    switch (e.type) {
      case 'usage_update':
        m.usage = e.tokens
        if (e.request) this.cacheLedger.record(m.tool, m.id, e.request)
        break
      case 'context_update':
        m.context = { used: e.used, window: e.window, exactness: e.exactness }
        break
      case 'conversation_reset':
        // The old conversation's reading no longer describes anything (#304); the tool reports the new one when the turn ends
        m.context = null
        this.cacheLedger.note(m.id, 'compaction')
        break
      case 'compaction':
        // The conversation the next request sends begins with a summary the cache has never seen (§6.1)
        this.cacheLedger.note(m.id, 'compaction')
        break
      case 'goal':
        // The goal (2026-09-07) is a live field too — after a restart, the tool tells us again (codex fetches
        // it on resume)
        m.goal = e.goal
        break
      case 'background_tasks':
        // The same merge the UI's reducer and the mock run (#290), so a reconnect reads back what the screen showed
        m.backgroundTasks = applyBackgroundTasks(m.backgroundTasks, e)
        /*
         * Kept for the host that may adopt this process (#648). Only the tool's own full list settles what an adopted
         * process holds: a level built from an ending or a `/loop` timer says nothing of a shell this host never saw,
         * and recording it would hand the next host a list it takes as complete.
         */
        if (e.snapshot) this.restartPolicy.backgroundUnknown.delete(m.id)
        if (!this.restartPolicy.backgroundUnknown.has(m.id)) this.launches.rememberBackgroundTasks(m)
        break
      case 'agent_version':
        // What the process says it runs (#297) replaces what was assumed when it started
        m.agentVersion = e.version
        break
    }
  }

  /** `SessionRecord.saveAttachment` (session-record.ts), kept on the manager for its callers */
  saveAttachment(...a: Parameters<SessionRecord['saveAttachment']>): ReturnType<SessionRecord['saveAttachment']> {
    return this.record.saveAttachment(...a)
  }

  /** A tool_call's callId -> the session that call's `git commit` belonged to (#50) */
  private pendingCommits = new Map<string, string>()

  private forgetCommits(sessionId: string): void {
    for (const [callId, sid] of this.pendingCommits) if (sid === sessionId) this.pendingCommits.delete(callId)
  }

  /**
   * Commit attribution with no hooks involved (#50). An agent's commit happens through a tool call,
   * and its output already sits in this stream — the hash is picked up from the `[branch abc1234]`
   * line, and if the output got truncated, the current HEAD is that commit. Nothing is written to the
   * repository itself (decided 2026-08-23).
   */
  private observeCommit(e: Extract<NormalizedEvent, { type: 'tool_call' | 'tool_result' }>, m: SessionInfo): void {
    if (e.type === 'tool_call') {
      if (looksLikeGitCommit(e.summary.title)) this.pendingCommits.set(e.callId, m.id)
      return
    }
    const sid = this.pendingCommits.get(e.callId)
    if (!sid) return
    this.pendingCommits.delete(e.callId)
    const projectId = m.projectId
    if (!e.ok || !projectId) return
    const sha = parseCommitSha(e.summary)
    if (sha) {
      this.store.recordCommit(projectId, sha, sid)
      return
    }
    void gitHeadSha(this.cwdOf(projectId))
      .then((head) => head && this.store.recordCommit(projectId, head, sid))
      .catch(() => {})
  }

  /**
   * Sends a message.
   *
   * If there is no process, it is **resumed first and then sent.** It used to reply with "this
   * session is not running", which just pushes a machine-side problem onto the person — all the
   * person wants is to keep talking, and the means to continue (external_id) is already ours to use.
   */
  async send(
    sessionId: string,
    text: string,
    attachments?: Attachment[],
    /*
     * Who sent this (FR-11). Empty when the person sent it — that is the default, so no migration was
     * needed. Only the orchestrator's send_to_session and a reportBack reply ever fill this in. The
     * screen uses it to draw "what the person said" and "what another session instructed" differently.
     */
    from?: { sessionId: string; name: string },
  ): Promise<void> {
    return this.deliver(sessionId, text, attachments, from, false)
  }

  /**
   * An inline app view's `ui/message` (M4 B-1, B-4) — this is only reached after the person has
   * confirmed it (once RPC `apps.viewMessage` narrows the app and session down to an instance). It is
   * recorded in the conversation as a message the app sent, and reaches the agent wrapped as the app's text.
   */
  async sendFromApp(sessionId: string, text: string, app: AppMessageSource, place: AppViewPlace = 'inline'): Promise<void> {
    return this.deliver(sessionId, text, undefined, undefined, false, app, place)
  }

  /**
   * The body of send() — takes one more flag for **whether this is an instruction or a relay** (#120).
   *
   * While the gate only looked at the sender's profile, a report from a manager or coordinator just
   * passed straight through. That is because what a profile answers is "can this message be trusted
   * as an instruction", not "is this someone else's words". A report **is someone else's words no
   * matter who relays it**, so it is flagged right where the relaying happens. This flag is never
   * exposed on send(), which anything else can call — a boundary that can be flipped on by accident
   * is not a boundary.
   */
  private async deliver(
    sessionId: string,
    text: string,
    attachments: Attachment[] | undefined,
    from: { sessionId: string; name: string } | undefined,
    /** Is this a body carrying over someone else's conversation (the report path)? An instruction is false —
     * it must be the original text */
    relayed: boolean,
    /** If this message came from an inline app view, that app (M4 B-1). Reaches the agent wrapped as the
     * app's text */
    fromApp?: AppMessageSource,
    /**
     * Which route the app's text came through — an inline view's message (B-1), a pinned view's
     * message (it came from outside the conversation, B-4), or work the app asked for (D-1) each get
     * a different header (`appMessageFrame`)
     */
    fromAppVia: AppMessageVia = 'inline',
    sendInput?: (handle: SessionHandle, text: string) => void,
  ): Promise<void> {
    const restarting = this.restartPolicy.deferredRestarts.get(sessionId)
    if (restarting) await restarting
    const m = this.openSession(sessionId)

    /*
     * A wake in progress is waited out, through the same call as the send that woke it (#839): its process is registered
     * before the catch-up, and the message that woke it goes in only after that. Going straight to the process, a second
     * send overtook it.
     */
    if (this.resuming.has(sessionId) && this.handles.has(sessionId)) await this.resumeSession(sessionId)
    if (!this.handles.has(sessionId)) {
      const r = await this.resumeSession(sessionId)
      if (!r.resumed) {
        throw rpcError(`Could not resume the conversation: ${r.reason ?? 'unknown reason'}`, 'session_not_found')
      }
    }

    this.notBeingRemoved(sessionId)
    const h = this.requireHandle(sessionId)
    // A message from the person is always a message boundary — continuing after an interrupt means everything
    // before it is one chunk (#66)
    this.record.closeStream(sessionId)
    const seq = this.store.nextSeq(sessionId)
    this.store.appendMessages([
      {
        sessionId,
        seq,
        role: 'user',
        kind: 'text',
        // An attachment is part of the message too — only its path is kept (D-1), and loadMessages loads the
        // image bytes back in
        payload: { text, ...(from ? { from } : {}), ...(fromApp ? { fromApp } : {}), ...(attachments?.length ? { attachments } : {}) },
        ts: Date.now(),
      },
    ])
    m.lastSeq = seq
    m.lastReadSeq = seq // Something we sent counts as read
    // A session's name is never coined from a message an app or another session sent (ask_project's task, a
    // parent's note, an orchestrator's instruction, #646) — the name always comes from the person's own words
    if (m.autoNamed && m.name === 'New session' && !fromApp && !from) {
      m.name = truncate(text)
      this.emit({ type: 'session_title', sessionId, title: m.name, auto: true })
    }
    this.store.upsertSession(m)
    /*
     * **Announces that a message was added.**
     *
     * This never used to be announced. The UI was the only place that ever produced a user message,
     * so the UI drawing its own was enough. That assumption broke once the orchestrator became a
     * second producer — an injected message was saved, but it never showed up on screen at all.
     */
    this.emit({
      type: 'user_message',
      sessionId,
      seq,
      text,
      ...(from ? { from } : {}),
      ...(fromApp ? { fromApp } : {}),
      // A message the host injected (an app's composer, C-5) only ever surfaces on screen through this event
      // — attachments have to ride along too, or the bubble is incomplete
      ...(attachments?.length ? { attachments } : {}),
    })
    /*
     * The one place that swaps a vendor adapter's input for a sourceSessionId wake — there are two branches.
     *  - A relayed body: someone else's words no matter who sent them. Swapped unconditionally.
     *  - A lower-privilege instruction with a known source: swapped only when it is going to a target
     *    that has tools. An instruction between tool profiles, and an ordinary worker instruction, must
     *    stay the original text (#90).
     * Raw provenance stays in the store/UI, and the relayed body is only ever read as observation data via
     * read_session.
     */
    const adapterText =
      fromApp ? appMessageFrame(fromApp, text, fromAppVia)
      // A hub's orchestrator directs as this host's own does (`sendFromHub`)
      : from && (relayed || (this.tools.directs(sessionId) && !this.tools.directs(from.sessionId) && from.sessionId !== HUB_SENDER))
        ? untrustedSourceSessionNotification(from.sessionId)
        : attachments?.length
          ? `${text}\n\n${attachments.map((a) => `@${a.path}`).join('\n')}`
          : text
    // A turn is asked for now, whether or not the tool announces it before its first card (`CardRests`)
    this.cardRests.turnAsked(sessionId)
    if (sendInput) sendInput(h, adapterText)
    else h.send(adapterText)
  }

  /**
   * Switches a session's agent (claude <-> codex).
   *
   * **Context does not carry over.** externalId is the tool's own conversation id (Claude's
   * session_id, Codex's threadId). Switching only the tool and carrying that id over would hand codex
   * Claude's UUID — so it is **cut off right here.**
   *
   * All that is lost is 'the thread to resume from' — the conversation record itself stays exactly as
   * it is in our own store. The old tool's conversation also stays inside that tool, reachable again
   * through '+ -> Past conversations'.
   *
   * A session is a slot, and the agent is a tool — the slot (name, order, history, grid panel) is left
   * untouched, and only the tool underneath it is swapped.
   */
  async switchTool(sessionId: string, tool: ToolName): Promise<SessionInfo> {
    this.notBeingRemoved(sessionId)
    this.refuseWhileLettingGo()
    const m = this.sessionOf(sessionId)
    if (m.tool === tool) return { ...m, live: this.handles.has(sessionId) }

    const adapter = this.adapters.get(tool)
    if (!adapter) throw rpcError(`Unknown tool: ${tool}`, 'tool_not_installed')

    /*
     * Checks whether the new tool is usable before switching to it.
     * Swapping without checking first would leave the old process already dead while the new one
     * fails to come up — a spot with no way back and no idea why.
     */
    const d = await adapter.detect()
    if (!d.installed || !d.loggedIn) {
      throw rpcError(`Cannot use ${tool}: ${d.detail}`, 'tool_not_installed')
    }
    /*
     * Read again after each wait (#839): a session deleted meanwhile is not written back from the copy read before it
     * (its row in the trash took the new tool), nor one another switch moved first
     */
    const from = m.tool
    const stillHere = () => {
      if (this.meta.get(sessionId) !== m) throw sessionNotFound(sessionId)
      if (m.tool !== from) throw rpcError(`The session switched to ${m.tool} meanwhile`)
    }
    stillHere()

    const old = this.handles.get(sessionId)
    if (old) {
      await old.dispose().catch(() => {})
      stillHere()
      this.handles.delete(sessionId)
      this.running.delete(sessionId)
      // The message in progress ends here — kept and indexed (#66), but only once the old process is gone, so its
      // last deltas grow the open row instead of opening a second one (#213, restartSession's comment)
      this.record.closeStream(sessionId)
      this.endTurnWithProcess(sessionId)
    }

    m.tool = tool
    // The new tool knows nothing about the old conversation. Carrying the thread over would attach the wrong
    // conversation
    m.externalId = null
    m.importedFrom = null
    /*
     * **The model and its dependent settings are also let go together.**
     *
     * Measured (smoke-switch-tool): switching a session that had sonnet picked on claude over to
     * codex brings the process up, but the first turn dies with a 400 —
     *   "The 'sonnet' model is not supported when using Codex with a ChatGPT account."
     * Clearing the model and doing the same thing works fine. In other words, this is not a feature
     * that does not work — a value with meaning only to one tool was being carried across to another.
     *
     * A model id is a tool's own vocabulary — 'sonnet' and 'gpt-5.6-terra' are not two names for the
     * same slot, they are words that do not exist in each other's dictionary. effort also has
     * different ranges (claude goes up to max, codex up to high), and verbosity/serviceTier are
     * codex-only entirely. So these are not values to carry over but **values to pick fresh**, and
     * null means "that tool's default".
     *
     * The permission preset is kept: safe/normal/auto is a policy the person sets, not the tool, and
     * both adapters implement it with the same meaning.
     */
    m.model = null
    m.effort = null
    m.verbosity = null
    m.serviceTier = null
    /*
     * Everything up to here is the old tool's conversation — the boundary is recorded (the guard in
     * doResumeSession reads it). Without recording it, "there is history but no id to resume from"
     * would look like an accident, and the session just switched would refuse to wake on the next
     * startup, saying it "lost its resume id".
     */
    // The boundary is recorded as **the store's last seq**, not the in-memory lastSeq, which can lag
    // behind (there is a path where a row that came in as an event never passes through meta) — even
    // one row of drift would make the guard read it as "lost", and the session just switched would
    // fail to wake
    this.store.setAppSetting(freshStartKey(m.id), String(this.store.loadMessages(m.id, 1)[0]?.seq ?? 0))
    /*
     * The broadcast state is also written into meta (#163). It used to only broadcast idle while
     * saving meta as working, so a screen that reconnected and the orchestrator's list_sessions both
     * saw an interrupted turn as "still working" (the settings tool refused that session outright).
     */
    this.settleState(m, { type: 'state_change', sessionId, state: 'idle', reason: 'tool_changed' })

    // The new process only comes up once it is addressed (the same rule as resumeSession — launching it here
    // would run a tool that might never even be used)
    return { ...m, live: false }
  }

  respondApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    matcher?: string,
  ): void {
    const m = this.meta.get(sessionId)

    // A card the host raised (M4 D-4, #371) — the adapter has never heard of this card, so it is resolved right here.
    // For a capability question "always allow" is treated as allow (the answer gets remembered regardless); a
    // cross-project consent keeps all three (always is the pair remembered)
    const ask = this.hostCards.hostAsks.get(requestId)
    if (ask && ask.sessionId === sessionId) {
      // A new project (#515) has nothing to remember either: "always" makes this one, as allow does. An update, an apply
      // and a handoff (#694) keep theirs for the asking session
      const keepsAlways = ask.detail.kind === 'project_access' || ask.detail.kind === 'agent_start' || sessionOnlyAlways(ask.detail)
      const answer = !keepsAlways && decision === 'always' ? 'allow' : decision
      // Starting agents (#561) has two always: this session (the card's default) or the whole project (⌥)
      this.hostCards.closeAsk(ask, answer, ask.detail.kind === 'agent_start' && answer === 'always' && scope === 'project' ? 'always_project' : answer)
      // The agent is still inside that tool call — if there are no other pending questions, it is working
      // again
      const after = this.meta.get(sessionId)
      if (after?.state === 'waiting_approval' && !after.pendingApproval && after.pendingQuestions.length === 0) {
        this.onEvent({ type: 'state_change', sessionId, state: 'working' })
      }
      return
    }

    /*
     * **Checks whether it actually landed, first.** If it did not land, no rule is recorded either —
     * remembering a command that was never even run as 'always allow' would let it pass silently the next
     * time.
     */
    /*
     * What "always" remembers is the host's own key for the card it answers (#838 review), not what the window sent: a
     * window from before #838 (during a swap) sends a command ending in `*`, or a flagged one, as its matcher, and the
     * adapter and the store would keep it. A matcher that is not the card's key remembers nothing; the call is allowed once.
     */
    const pending = m?.pendingApproval
    const key = pending?.requestId === requestId ? alwaysAllowKey(pending.detail) : ''
    const remembered = decision === 'always' && matcher !== undefined && key !== '' && matcher === key ? matcher : undefined
    const landed = this.requireHandle(sessionId).respondApproval(requestId, decision, scope, remembered)

    // This is a second response to a request that has already been answered — since the first response
    // already landed, this never broadcasts a denial or reports a failure (#158)
    if (!landed && this.hostCards.answeredApprovals.get(requestId) === sessionId) return
    if (landed) {
      this.hostCards.answeredApprovals.set(requestId, sessionId)
      if (this.hostCards.answeredApprovals.size > 256) this.hostCards.answeredApprovals.delete(this.hostCards.answeredApprovals.keys().next().value!)
    }

    if (!landed) {
      /*
       * No such request exists. Usually this means the process got swapped in the meantime (changing
       * the permission preset does this). The card on screen is already unanswerable, so it is
       * **removed first**, and only then is the error reported. Without removing it, an unresponsive
       * card that does nothing when clicked would just stay there.
       */
      this.emit({ type: 'approval_resolved', sessionId, requestId, decision: 'deny' })
      throw rpcError('That approval request is already gone (the agent restarted). The command was not run.', 'approval_gone')
    }

    // Persisting the rule — the adapter only keeps it in memory, so this is needed for it to survive a
    // restart (C-2)
    // Only the card's own key (`remembered` above): an edit with no path has none (#428), so "(no path)" is never a rule
    if (decision === 'always' && m && remembered) {
      this.store.addApprovalRule({
        scope: scope ?? 'session',
        sessionId: scope === 'project' ? undefined : sessionId,
        projectId: scope === 'project' ? (m.projectId ?? undefined) : undefined,
        matcher: remembered,
        decision: 'allow',
      })
    }
  }

  /**
   * Answers a set of choices (AskUserQuestion).
   *
   * Keeps exactly what was learned from approvals — **if it did not land, it is never quietly treated
   * as a success.** Leaving an unanswerable card on screen recreates the same "clicking it does nothing"
   * state.
   */
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): void {
    const handle = this.requireHandle(sessionId)
    const landed = handle.answerQuestion?.(requestId, answers) ?? false
    if (!landed) {
      this.emit({ type: 'question_resolved', sessionId, requestId })
      throw rpcError('That question is already gone (the agent restarted). The answer was not delivered.', 'question_gone')
    }
  }

  /** `ToolQueries.listCommands` (tool-queries.ts), kept on the manager for its callers */
  listCommands(...a: Parameters<ToolQueries['listCommands']>): ReturnType<ToolQueries['listCommands']> {
    return this.toolQueries.listCommands(...a)
  }

  /** `ToolQueries.usageFor` (tool-queries.ts), kept on the manager for its callers */
  usageFor(...a: Parameters<ToolQueries['usageFor']>): ReturnType<ToolQueries['usageFor']> {
    return this.toolQueries.usageFor(...a)
  }

  /** Which account `tool` is logged in to here, as the hub compares it with a linked machine's (#726) */
  async accountFor(tool: ToolName): Promise<{ loggedIn: boolean | null; fingerprint: string | null }> {
    const adapter = this.adapters.get(tool)
    if (!adapter?.account) return { loggedIn: null, fingerprint: null }
    return adapter.account().catch(() => ({ loggedIn: null, fingerprint: null }))
  }

  /** `ToolQueries.listModels` (tool-queries.ts), kept on the manager for its callers */
  listModels(...a: Parameters<ToolQueries['listModels']>): ReturnType<ToolQueries['listModels']> {
    return this.toolQueries.listModels(...a)
  }

  /** A project's working directory. Used by the terminal to decide its own key (cwd) */
  cwdOfProject(projectId: string): string {
    return this.cwdOf(projectId)
  }

  // ── Git (B-1) — only path resolution happens here; the actual work is delegated to dev-services ──
  /**
   * A project's working directory. **The orchestrator (projectId=null) uses a neutral location.**
   *
   * Placing it inside a project would have it touching the same files as that project's sessions —
   * creating with our own hands exactly the concurrent-session conflict FR-2 warns about. The
   * orchestrator has no hands of its own: sessions do the work, and the orchestrator instructs and reads.
   */
  /**
   * Where this session actually runs. **The stored path beats the recomputed one** (issue #28).
   *
   * Recomputing this on every start is what orphaned the orchestrator. The data directory was
   * renamed, `orchestratorHome()` dutifully answered with the new path, and Claude Code — which
   * files conversations **by working directory** — went looking somewhere this session's history
   * had never been written. The tool said "not found"; the app called it a deletion. A session's
   * history lives where the session started, so that is the path we read back, not one we
   * re-derive from things that can move underneath it.
   *
   * A worktree session was the first case of this rule: reverting to the project path on resume
   * would silently break isolation while the person still believed it was isolated. Now a worktree's
   * path is also just this same single value, stamped once at creation — not a special case, part of
   * the rule itself.
   *
   * Rows written before v14 have no stored path — the migration deliberately leaves the
   * orchestrator NULL rather than touching the user's home (see step 14 in store/migrations/v13-v27.ts). Derive
   * theirs once, here, and write it down; from then on the next rename cannot move them either.
   */
  private cwdFor(m: SessionInfo): string {
    const stored = this.store.sessionCwd(m.id)
    if (stored) return stored
    const derived = m.worktree?.path ?? this.cwdOf(m.projectId)
    this.store.setSessionCwd(m.id, derived)
    return derived
  }

  /**
   * "Our own folders" — the search scope used when hunting for stray processes (strays.ts).
   *
   * Project directories plus the worktree root. Why the worktree root is included separately:
   * everything under it is **a folder the app itself created**, so anything running there is by
   * definition our own business, and it can still exist even after the project is removed from the list.
   */
  folderRoots(): string[] {
    return [...this.store.listProjects().map((p) => p.path), this.worktreeRoot]
  }

  /** The material needed to decide whether a worktree can be deleted. null if this is not a worktree session
   */
  async worktreeStatus(
    sessionId: string,
  ): Promise<{ path: string; branch: string; dirty: boolean; changedFiles: number; more?: true; unknown?: true } | null> {
    const m = this.meta.get(sessionId)
    if (!m?.worktree) return null
    // A failed read is not a clean worktree: the delete dialog then warns instead of removing quietly (#850 review)
    const state = await gitWorktreeDirty(m.worktree.path, this.gitTrust(m.projectId)).catch(() => ({
      dirty: true,
      changedFiles: 0,
      unknown: true as const,
    }))
    return { ...m.worktree, ...state }
  }

  /** `HandoffNotes.exportHandoffRecord` (handoff-notes.ts), kept on the manager for its callers */
  exportHandoffRecord(...a: Parameters<HandoffNotes['exportHandoffRecord']>): ReturnType<HandoffNotes['exportHandoffRecord']> {
    return this.handoffNotes.exportHandoffRecord(...a)
  }

  /** `HandoffNotes.exportHandoffNote` (handoff-notes.ts), kept on the manager for its callers */
  exportHandoffNote(...a: Parameters<HandoffNotes['exportHandoffNote']>): ReturnType<HandoffNotes['exportHandoffNote']> {
    return this.handoffNotes.exportHandoffNote(...a)
  }

  /**
   * Turns a touched file into a path relative to the project (#185).
   *
   * The tool gives an absolute path (Claude's `file_path`, Codex's `fileChange`). Entries in the file
   * tree use paths relative to the project, so left as-is the "edited by agent" indicator never
   * matched anything at all. Anything that already came as a relative path is read relative to the
   * folder the session runs in. A path outside the project (a worktree session's own files, a
   * settings file in the home directory) is discarded — that file does not exist in the project tree,
   * and marking a different file that happens to share the same relative path would be a lie.
   */
  private projectRelative(e: Extract<NormalizedEvent, { type: 'files_touched' }>): NormalizedEvent {
    const m = this.meta.get(e.sessionId)
    let root: string
    try {
      if (!m?.projectId) return { ...e, paths: [] }
      root = this.cwdOf(m.projectId)
    } catch {
      return { ...e, paths: [] }
    }
    const base = this.cwdFor(m)
    // Both sides canonical (#428): a tool names its files under the real path of a root kept through a link (macOS's
    // `/tmp` is `/private/tmp`), and compared as written they fell outside and were dropped
    const rootReal = canonicalPath(root)
    const paths = new Set<string>()
    for (const p of e.paths) {
      const target = canonicalPath(resolve(base, p))
      const rel = relative(rootReal, target)
      if (!rel || !isInside(rootReal, target)) continue
      // git and the screen both speak in POSIX separators (#47) — so does a tree entry's path
      paths.add(rel.replaceAll(sep, '/'))
    }
    return { ...e, paths: [...paths] }
  }

  private cwdOf(projectId: string | null): string {
    if (projectId === null) return orchestratorHome()
    const p = this.requireProject(projectId)
    return p.path
  }

  /**
   * The project's trust as a git read needs it (#407): before trust, a read runs none of the
   * repository's hooks, filters, textconv or fsmonitor (`git-exec.ts`). Read fresh on every call,
   * like `projectTrusted`.
   */
  gitTrust(projectId: string | null): { trusted: boolean } {
    return { trusted: this.projectTrusted(projectId) }
  }

  gitStatusFiles(projectId: string) {
    return gitStatusFiles(this.cwdOf(projectId), this.gitTrust(projectId))
  }
  gitDiff(projectId: string, path: string, staged?: boolean) {
    return gitDiff(this.cwdOf(projectId), path, { staged, ...this.gitTrust(projectId) })
  }
  async gitLog(projectId: string, limit?: number) {
    const commits = await gitLog(this.cwdOf(projectId), limit)
    // Tags which session created each commit (#50) — passes through untouched wherever there is no record
    // A commit link of a session in the trash is kept (#96, #204) — and says where the session is rather than "deleted"
    const trashed = this.store.trashedIds()
    return attachCommitSessions(commits, this.store.commitSessions(projectId), (sid) =>
      this.meta.get(sid)?.name ?? (trashed.has(sid) ? '(in the trash)' : undefined),
    )
  }
  gitCommitDetail(projectId: string, sha: string) {
    return gitCommitDetail(this.cwdOf(projectId), sha, this.gitTrust(projectId))
  }
  gitBranches(projectId: string) {
    return gitBranches(this.cwdOf(projectId))
  }
  /** Things a fresh worktree will not have (#76) — used to point out candidates to copy */
  gitIgnoredEntries(projectId: string) {
    return gitIgnoredEntries(this.cwdOf(projectId), undefined, this.gitTrust(projectId))
  }
  gitCheckout(projectId: string, branch: string, dryRun?: boolean) {
    return gitCheckout(this.cwdOf(projectId), branch, { dryRun, ...this.gitTrust(projectId) })
  }
  gitStage(projectId: string, paths: string[], unstage?: boolean) {
    return gitStage(this.cwdOf(projectId), paths, unstage)
  }
  gitCommit(projectId: string, message: string) {
    return gitCommit(this.cwdOf(projectId), message)
  }
  gitPush(projectId: string) {
    return gitPush(this.cwdOf(projectId))
  }

  // ── File tree/viewer (C-1) ──
  listDir(projectId: string, path: string) {
    return listDir(this.cwdOf(projectId), path, this.gitTrust(projectId))
  }

  /**
   * Updates the file tree's watch set (#34). When the UI sends the whole set of expanded
   * directories, changes come back as an `fs_changed` event — this lives here because the direction
   * is round-trip: the request arrives via RPC, but the answer (a change) goes out through the same
   * broadcast path as a session event.
   */
  watchDirs(projectId: string, paths: readonly string[]): number {
    return this.watchers.setWatched(projectId, this.cwdOf(projectId), paths)
  }
  readTextFile(projectId: string, path: string) {
    return readTextFile(this.cwdOf(projectId), path)
  }

  // ── File operations (#19) — only path resolution happens here; validation and execution are delegated to
  // dev-services ──
  moveEntry(projectId: string, from: string, toDir: string) {
    return moveEntry(this.cwdOf(projectId), from, toDir)
  }
  importFile(projectId: string, toDir: string, name: string, dataBase64: string) {
    return importFile(this.cwdOf(projectId), toDir, name, Buffer.from(dataBase64, 'base64'))
  }
  /** The absolute path handed to the OS by the desktop shell (trash, file manager, IDE). Built by the side that
   * knows the project: for the trash the entry itself, a link included; otherwise what it is, a link followed inside the
   * project; never the project folder (#838) */
  resolveFile(projectId: string, path: string, purpose?: FsResolvePurpose) {
    const root = this.cwdOf(projectId)
    // The project folder for its delete dialog only (#838); an older window's dialog sends the literal root and no purpose
    if (purpose === 'project' || (purpose === undefined && pathParts(root, path).length === 0)) return resolveProjectFolder(root)
    return purpose === 'trash' ? resolveEntry(root, path) : resolveTarget(root, path)
  }

  /** `UiPreferenceStore.saveWorkspace` (ui-preferences.ts), kept on the manager for its callers */
  saveWorkspace(...a: Parameters<UiPreferenceStore['saveWorkspace']>): ReturnType<UiPreferenceStore['saveWorkspace']> {
    return this.prefs.saveWorkspace(...a)
  }

  /** `UiPreferenceStore.loadWorkspace` (ui-preferences.ts), kept on the manager for its callers */
  loadWorkspace(...a: Parameters<UiPreferenceStore['loadWorkspace']>): ReturnType<UiPreferenceStore['loadWorkspace']> {
    return this.prefs.loadWorkspace(...a)
  }

  /** `UiPreferenceStore.uiPreferences` (ui-preferences.ts), kept on the manager for its callers */
  uiPreferences(...a: Parameters<UiPreferenceStore['uiPreferences']>): ReturnType<UiPreferenceStore['uiPreferences']> {
    return this.prefs.uiPreferences(...a)
  }

  /** `UiPreferenceStore.setUiPreferences` (ui-preferences.ts), kept on the manager for its callers */
  setUiPreferences(...a: Parameters<UiPreferenceStore['setUiPreferences']>): ReturnType<UiPreferenceStore['setUiPreferences']> {
    return this.prefs.setUiPreferences(...a)
  }

  /** The settings screen must be able to see and delete rules (FR-3: make the outcome visible) */
  listApprovalRules(): {
    id: number
    scope: 'session' | 'project'
    matcher: string
    decision: string
    createdAt: number
    projectId: string | null
    sessionId: string | null
  }[] {
    return this.store
      .listApprovalRules()
      .filter((r) => r.matcher)
      .map((r) => ({
        id: r.id,
        scope: r.scope as 'session' | 'project',
        matcher: r.matcher,
        decision: r.decision,
        createdAt: r.createdAt,
        // Included so the settings screen can say which project or session this rule belongs to (#183)
        projectId: r.projectId,
        sessionId: r.sessionId,
      }))
  }

  deleteApprovalRule(id: number): void {
    this.store.deleteApprovalRule(id)
  }

  /**
   * Search for the command palette. The store now returns the whole body, so **it is cut down to one
   * line right here** (the palette only ever shows one line). The orchestrator's recall cuts a much
   * wider window from that same body — how much is needed is up to whoever is using it.
   */
  searchMessages(query: string, limit?: number) {
    return this.store
      .searchMessages(query, limit)
      .map((h) => ({ sessionId: h.sessionId, seq: h.seq, snippet: windowAround(h.body, query, 60) }))
  }

  /** Saved rules that apply to this session (session-scoped plus project-scoped) */
  private rulesFor(sessionId: string, projectId: string | null): string[] {
    return this.store
      .listApprovalRules()
      .filter((r) => (r.sessionId ? r.sessionId === sessionId : r.projectId === projectId))
      .map((r) => r.matcher)
      .filter(Boolean)
  }

  /**
   * Stops one of the session's background tasks (#290). Only a task the adapter listed as running and stoppable is
   * asked for — an id from an old list, or a task the tool cannot stop alone, is refused with a reason instead of
   * being sent. The ending arrives as the session's next `background_tasks` event.
   */
  async stopBackgroundTask(sessionId: string, taskId: string): Promise<void> {
    const handle = this.requireHandle(sessionId)
    const task = this.meta.get(sessionId)?.backgroundTasks.find((t) => t.id === taskId && t.status === 'running')
    if (!task) throw rpcError('That background task is no longer running')
    if (!task.stoppable || !handle.stopBackgroundTask) {
      throw rpcError('This task cannot be stopped on its own')
    }
    await handle.stopBackgroundTask(taskId)
  }

  /** Takes the ended tasks off the session's list (#290); the running ones stay. */
  clearBackgroundTasks(sessionId: string): void {
    const m = this.sessionOf(sessionId)
    const e: NormalizedEvent = { type: 'background_tasks', sessionId, live: m.backgroundTasks.filter((t) => t.status === 'running'), clearEnded: true }
    m.backgroundTasks = applyBackgroundTasks(m.backgroundTasks, e)
    this.emit(e)
  }

  /**
   * Whether the session is fully idle (#290, #297): its process can be swapped without losing work. The rule is
   * `sessionIdle` in idle.ts; this adds what only the manager knows, whether a process runs and whether its tool
   * reports background work.
   */
  sessionIdle(sessionId: string): SessionIdle {
    if (this.worktrees.worktreeCleanupBlocks(sessionId)) return { idle: false, reason: 'turn' }
    const m = this.sessionOf(sessionId)
    if (this.inputsHeld(sessionId)) return { idle: false, reason: 'turn' }
    return sessionIdle(m, {
      running: this.handles.has(sessionId),
      // An adopted process whose work the previous host did not record is as silent as a tool that cannot report (#648)
      reportsBackground: !!this.adapters.get(m.tool)?.capabilities.backgroundTasks && this.restartPolicy.backgroundKnown(sessionId),
    })
  }

  /**
   * The sessions whose running work this one waits on (#568, the sleep rule in sleep.ts): a child it started with
   * `start_agent`, or a session handling its ask_project task, while the turn it gave them runs, and a session that owes
   * it a report (`reportBack`, `awaitingReport`). Their answer is about to come back to it. A report held over the
   * child's own background work (#721) counts only while the child is in a turn: that work may run for minutes or
   * for good (a dev server), and the report wakes the caller when it comes.
   */
  waitsOn(sessionId: string): string[] {
    const ids = new Set<string>()
    for (const d of this.children.delegations.values()) if (d.callerId === sessionId && !d.settled) ids.add(d.sessionId)
    for (const [child, caller] of this.children.awaitingReport) {
      // A child paused on its own background work (#721) does not hold its caller awake: its report wakes it
      const at = this.meta.get(child)
      if (caller === sessionId && at && (!this.children.pausedReports.has(child) || inTurn(at.state))) ids.add(child)
    }
    /*
     * A session it owns (#561 part 3): a child it started, or a worktree session a former worktree manager held (store
     * v48), while a turn runs there. A former manager sent its work with send_to_session, so no delegation stands for
     * it; it is still the parent's work, about to be read back through agent_session
     */
    for (const s of this.meta.values()) {
      if (s.askedBy === sessionId && s.projectId === this.meta.get(sessionId)?.projectId && inTurn(s.state)) ids.add(s.id)
    }
    return [...ids]
  }

  /**
   * Puts an idle session to sleep (#568): its process ends, the session stays, and the next message, or a screen
   * waking it, resumes the conversation through `resumeSession`. The policy (when) is sleep.ts; this is only the act,
   * refused unless the session is still fully idle at this moment. The handle leaves the map first, so a message
   * arriving meanwhile starts a resume, and that resume waits for this process to be gone (`sleeping`).
   */
  async sleepSession(sessionId: string): Promise<boolean> {
    const h = this.handles.get(sessionId)
    if (!h || this.resuming.has(sessionId) || this.restartPolicy.deferredRestarts.has(sessionId) || this.sleeping.has(sessionId) || this.leaving.has(sessionId)) return false
    if (!this.sessionIdle(sessionId).idle || this.waitsOn(sessionId).length > 0) return false
    this.handles.delete(sessionId)
    this.running.delete(sessionId)
    this.emit({ type: 'session_live', sessionId, live: false, reason: 'asleep' })
    const going = (async () => {
      await h.dispose().catch(() => {})
      // As a restart does: what the process wrote is ours, and its open row closes (restartSession)
      this.externals.stampExternalSynced(sessionId)
      this.record.closeStream(sessionId)
    })()
    this.sleeping.set(sessionId, going)
    try {
      await going
    } finally {
      this.sleeping.delete(sessionId)
    }
    return true
  }

  interrupt(sessionId: string): void {
    const handle = this.requireHandle(sessionId)
    // Receipt failures and ending events may be emitted synchronously by interrupt.
    const run = this.agentRuns.get(sessionId)
    if (run) run.stoppedByPerson = true
    for (const observer of this.turnObservers.get(sessionId) ?? []) observer.stoppedByPerson = true
    handle.interrupt()
    // Stop reaches delegated work only while the caller waits. A note that joined the person's turn
    // only ends that caller's wait; work left running past the bound has its own Stop.
    for (const d of this.children.delegations.values()) {
      if (d.callerId === sessionId && (d.waiters ?? 0) > 0) d.stop('the person stopped the session that asked')
    }
  }

  /**
   * Restarts only the agent (an extension of FR-10).
   * Creating a new session when a tool has become unresponsive breaks the conversation — this swaps only the
   * process.
   */
  async restartSession(
    sessionId: string,
    /** What made the restart, for the cache's rebuild cause (§6.1); a plain new process when absent */
    cause?: RebuildCause,
  ): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }> {
    this.notBeingRemoved(sessionId)
    this.refuseWhileLettingGo()
    if (cause) {
      this.restartPolicy.restartReasons.set(sessionId, cause)
      if (cause === 'launch_settings') console.error(`[sessions] restarting ${sessionId}: launch settings changed or previously unrecorded`)
    }
    // Applying a deferred settings change (#164) is also done by this same restart, and so is an app set's (#371)
    this.restartPolicy.restartAfterTurn.delete(sessionId)
    this.restartPolicy.appsRestartAfterTurn.delete(sessionId)
    this.restartPolicy.definitionsRestartAfterTurn.delete(sessionId)
    this.restartPolicy.launchSettingsRestartAfterTurn.delete(sessionId)
    this.noticeTrustRestart(sessionId)
    // A restart for any reason ends a wait for background work: whatever it was holding is applied now (#648)
    this.restartPolicy.clearBackgroundHold(sessionId)
    const h = this.handles.get(sessionId)
    if (h) {
      this.restartPolicy.noticeBackgroundStopped(sessionId, cause)
      await h.dispose().catch(() => {})
      // Stamped **after** dispose finishes — so even the outgoing process's last flush falls inside the
      // marker
      this.externals.stampExternalSynced(sessionId)
      this.handles.delete(sessionId)
      this.running.delete(sessionId)
      /*
       * The dying process's last words are kept (#66), and the message closes only now (#213). Closed before the
       * dispose, the handle was still registered while it went down, so its last deltas opened a second row: one
       * reply stored as two, cut mid-word. While it goes down its deltas grow the open row; once it is unregistered,
       * anything later is dropped (#157). No await between here and the new handle, so the new process starts its own row.
       */
      this.record.closeStream(sessionId)
      this.endTurnWithProcess(sessionId)
    }
    /*
     * A process was dropped and no new one took its place (#648): every window is told, as a sleep tells it. Before
     * this, a restart the host itself started (a definitions or launch-settings refresh, a CLI move) that failed left
     * the windows showing the session live, so the screen's wake stepped back and the person learnt only when a send
     * failed. The answer below still names the reason to whoever asked.
     */
    const dropped = (reason: string) => {
      if (!h || this.handles.has(sessionId)) return
      console.error(`[sessions] restart of ${sessionId.slice(0, 8)} did not bring a process up: ${reason}`)
      this.emit({ type: 'session_live', sessionId, live: false, reason: 'restart_failed' })
    }
    const r = await this.resumeSession(sessionId).catch((err: Error) => {
      dropped(err.message)
      throw err
    })
    if (!r.resumed) dropped(r.reason ?? 'unknown')
    return r
  }

  /**
   * A turn its process took with it (#839): a restart or a tool switch disposed the process mid-turn. Claude's dispose
   * says nothing of the turn, and the new process is stated `idle` by the host (`settleState`), which no wait reads as
   * a turn's end. So the turn ends here as a Stop ends it, through `onEvent`: a delegation on it settles as stopped and
   * frees its place under the agent limit, its caller is told, the turn's owner and the queue are released. Called
   * once the old handle is gone, so a turn end the old process did send is not repeated.
   */
  private endTurnWithProcess(sessionId: string): void {
    const m = this.meta.get(sessionId)
    if (m && inTurn(m.state)) this.onEvent({ type: 'state_change', sessionId, state: 'waiting_input', reason: 'interrupted' })
  }

  /**
   * A keeper keeps a process's tool definitions over a host swap: `LaunchRecords.refreshToolDefinitions`
   * (launch-records.ts), kept on the manager for its callers
   */
  refreshToolDefinitions(): Promise<void> {
    return this.launches.refreshToolDefinitions()
  }

  private partsHost: ManagerParts | undefined
  /**
   * What the modules moved out of this manager reach of it (#428), one object for all of them, made once on first use.
   * Each module's own host type (`HandoffFlowHost`, `HostCardsHost`, `DelegationHost`, …) picks what it may use; this
   * is the one place that says how each name reaches the manager. Its fields are getters, read when used and never
   * kept: `reorderSessions` replaces `meta`, and a kept map would leave a module on the old one (#757 review). Each
   * module used to get an object of its own, twelve of them repeating the same getters.
   */
  private parts(): ManagerParts {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getters below read this manager's fields when used
    const self = this
    return (this.partsHost ??= {
      get adapters() {
        return self.adapters
      },
      agentSession: (...a) => self.agentSession(...a),
      listAgents: (...a) => self.delegationFlow.listAgents(...a),
      get agentRuns() {
        return self.agentRuns
      },
      answerRoutedCard: (...a) => self.cards.answerRoutedCard(...a),
      appHostData: (...a) => self.appSessions.appHostData(...a),
      answerQuestion: (...a) => self.answerQuestion(...a),
      applyDeferredRestart: (...a) => self.restartPolicy.applyDeferredRestart(...a),
      applyStateHint: (...a) => self.applyStateHint(...a),
      askGateError: (...a) => self.askProjectFlow.askGateError(...a),
      askProject: (...a) => self.askProject(...a),
      askCapability: (...a) => self.hostCards.askCapability(...a),
      askHost: (...a) => self.hostCards.askHost(...a),
      get appAccess() {
        return self.apps.appAccess
      },
      get appsHub() {
        return self.apps.appsHub
      },
      autoBoundaryOpen: (...a) => self.autoBoundaryOpen(...a),
      awaitTurn: (...a) => self.delegationFlow.awaitTurn(...a),
      backgroundTasksKey: (...a) => self.launches.backgroundTasksKey(...a),
      builderRefOf: (...a) => self.appSessions.builderRefOf(...a),
      busyAnswer: (...a) => self.queue.busyAnswer(...a),
      busyChoices: (...a) => self.queue.busyChoices(...a),
      busyForCaller: (...a) => self.queue.busyForCaller(...a),
      get cacheLedger() {
        return self.cacheLedger
      },
      get children() {
        return self.children
      },
      cleanUpWorktreeChild: (...a) => self.worktrees.cleanUpWorktreeChild(...a),
      get lettingGo() {
        return self.lettingGo()
      },
      get closing() {
        return self.disposing || self.handingOver
      },
      createSession: (...a) => self.createSession(...a),
      cwdFor: (...a) => self.cwdFor(...a),
      cwdOf: (...a) => self.cwdOf(...a),
      defaultToolFor: (...a) => self.defaultToolFor(...a),
      get delegationFlow() {
        return self.delegationFlow
      },
      deliver: (...a) => self.deliver(...a),
      deliverReport: (...a) => self.reports.deliverReport(...a),
      dropOpenedByAuto: (...a) => self.queue.dropOpenedByAuto(...a),
      get disposing() {
        return self.disposing
      },
      get emit() {
        return self.emit
      },
      enqueue: (...a) => self.queue.enqueue(...a),
      ensureProjectAccess: (...a) => self.ensureProjectAccess(...a),
      exportHandoffNote: (...a) => self.exportHandoffNote(...a),
      exportHandoffRecord: (...a) => self.exportHandoffRecord(...a),
      firstTool: (...a) => self.firstTool(...a),
      forgetCardRest: (id) => self.cardRests.forget(id),
      forgetCommits: (...a) => self.forgetCommits(...a),
      gitTrust: (...a) => self.gitTrust(...a),
      grantReads: (...a) => self.delegationFlow.grantReads(...a),
      handedOverReply: (...a) => self.delegationFlow.handedOverReply(...a),
      get handingOver() {
        return self.handingOver
      },
      get handles() {
        return self.handles
      },
      handoffHeir: (...a) => self.handoffNotes.handoffHeir(...a),
      hasSession: (id) => self.meta.has(id),
      get hostCards() {
        return self.hostCards
      },
      inputsHeld: (...a) => self.inputsHeld(...a),
      isAppAgentSession: (...a) => self.apps.isAppAgentSession(...a),
      get linkedReader() {
        return self.linkedReader
      },
      listSessions: (...a) => self.listSessions(...a),
      loadMessages: (...a) => self.loadMessages(...a),
      migrateApprovedMcpServers: (...a) => self.proposals.migrateApprovedMcpServers(...a),
      get memoryGate() {
        return self.memoryGate
      },
      get meta() {
        return self.meta
      },
      modelsWithin: (...a) => self.toolQueries.modelsWithin(...a),
      moveChildren: (...a) => self.handoffChildren.moveChildren(...a),
      observeCommit: (...a) => self.observeCommit(...a),
      orchestratorToolsFor: (...a) => self.orchestratorToolsFor(...a),
      onEvent: (e: NormalizedEvent, from?: SessionHandle | null) => self.onEvent(e, from),
      ownTasksRunning: (...a) => self.reports.ownTasksRunning(...a),
      pauseReport: (...a) => self.reports.pauseReport(...a),
      pausedTasksNow: (...a) => self.reports.pausedTasksNow(...a),
      get prLookup() {
        return self.prLookup
      },
      get prPollMs() {
        return self.prPollMs
      },
      get prCheckedAt() {
        return self.merges.prCheckedAt
      },
      projectInfo: (...a) => self.projectInfo(...a),
      projectRow: (...a) => self.projectRow(...a),
      projectTrusted: (...a) => self.projectTrusted(...a),
      queuedOf: (...a) => self.queue.queuedOf(...a),
      get quitNotices() {
        return self.quitNotices
      },
      set quitNotices(notices) {
        self.quitNotices = notices
      },
      get readGrants() {
        return self.readGrants
      },
      get record() {
        return self.record
      },
      get recoveryRepair() {
        return self.recoveryRepair
      },
      rememberBackgroundTasks: (...a) => self.launches.rememberBackgroundTasks(...a),
      rename: (...a) => self.rename(...a),
      requireAppAccess: (...a) => self.apps.requireAppAccess(...a),
      respondApproval: (...a) => self.respondApproval(...a),
      runAppAgent: (...a) => self.runAppAgent(...a),
      reportBackIfAwaited: (...a) => self.reports.reportBackIfAwaited(...a),
      get restartPolicy() {
        return self.restartPolicy
      },
      restartSession: (...a) => self.restartSession(...a),
      get resuming() {
        return self.resuming
      },
      routedCards: (...a) => self.cards.routedCards(...a),
      get running() {
        return self.running
      },
      scheduleDrain: (...a) => self.queue.scheduleDrain(...a),
      send: (...a) => self.send(...a),
      sessionsInside: (...a) => self.sessionsInside(...a),
      sessionOf: (...a) => self.sessionOf(...a),
      settingFilesFor: (...a) => self.settingFilesFor(...a),
      settleState: (...a) => self.settleState(...a),
      sleepSession: (...a) => self.sleepSession(...a),
      startAgent: (...a) => self.startAgent(...a),
      startDelegation: (...a) => self.delegationFlow.startDelegation(...a),
      stopBackgroundTask: (...a) => self.stopBackgroundTask(...a),
      stopWatchingReconnect: (...a) => self.interruptions.stopWatchingReconnect(...a),
      get store() {
        return self.store
      },
      sweepOrphanHandoffNotes: (...a) => self.handoffNotes.sweepOrphanHandoffNotes(...a),
      tellSession: (...a) => self.reports.tellSession(...a),
      toolProfileOf: (...a) => self.toolProfileOf(...a),
      nameOf: (...a) => self.reports.nameOf(...a),
      toolProblem: async (tool) => {
        const adapter = self.adapters.get(tool)
        if (!adapter) return `${JSON.stringify(tool)} is not a tool Centralu runs here`
        const d = await adapter.detect().catch((e: Error) => ({ installed: false, loggedIn: false, detail: e.message }))
        return d.installed && d.loggedIn ? null : `${tool} cannot start a session here: ${d.detail}`
      },
      trashSession: (...a) => self.trashSession(...a),
      get trashing() {
        return self.trash.trashing
      },
      trunkOf: (...a) => self.trunkOf(...a),
      turnRunning: (...a) => self.turnRunning(...a),
      get turnObservers() {
        return self.turnObservers
      },
      uiPreferences: (...a) => self.uiPreferences(...a),
      untilCard: (...a) => self.cards.untilCard(...a),
      updateCentraluAsked: (...a) => self.updatesAsked.updateCentraluAsked(...a),
      untilHandedOver: (...a) => self.delegationFlow.untilHandedOver(...a),
      untilWakeWithdrawn: (...a) => self.untilWakeWithdrawn(...a),
      get updateApplyConsents() {
        return self.updatesAsked.updateApplyConsents
      },
      get updateConsents() {
        return self.updatesAsked.updateConsents
      },
      withdrawHostAsk: (...a) => self.hostCards.withdrawHostAsk(...a),
      withdrawReaches: (...a) => self.queue.withdrawReaches(...a),
      get worktreeRoot() {
        return self.worktreeRoot
      },
      get worktrees() {
        return self.worktrees
      },
    })
  }

  private seatHost: OrchestratorSeatHost | undefined
  /**
   * What the orchestrator tools reach of this manager (#428), made once on first use. Its fields are read when a tool
   * runs, never kept: `reorderSessions` replaces `meta`, and a kept map would leave the tools on the old one (#757 review).
   */
  private seat(): OrchestratorSeatHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getters below read this manager's fields when used
    const self = this
    return (this.seatHost ??= {
      get store() {
        return self.store
      },
      get meta() {
        return self.meta
      },
      get children() {
        return self.children
      },
      get proposals() {
        return self.proposals
      },
      linkedReader: () => this.linkedReader,
      linkedReportRestored: (sessionId) => this.linkedReports.restored(sessionId),
      emit: (e) => this.emit(e),
      updateCentraluAsked: (sessionId, action, signal) => this.updatesAsked.updateCentraluAsked(sessionId, action, signal),
      updateSettings: (sessionId, settings, by) => this.updateSettings(sessionId, settings, by),
      createSession: (params) => this.createSession(params),
      firstTool: (preferred) => this.firstTool(preferred),
      rename: (sessionId, name) => this.rename(sessionId, name),
      send: (sessionId, text, attachments, from) => this.send(sessionId, text, attachments, from),
      routedCards: (sessionId, callerId) => this.cards.routedCards(sessionId, callerId),
      answerRoutedCard: (callerId, sessionId, card, text) => this.cards.answerRoutedCard(callerId, sessionId, card, text),
      busyForCaller: (callerId, sessionId) => this.queue.busyForCaller(callerId, sessionId),
      busyAnswer: (callerId, target, from) => this.queue.busyAnswer(callerId, target, from),
      busyChoices: (callerId, target, from) => this.queue.busyChoices(callerId, target, from),
      enqueue: (callerId, target, via, text) => this.queue.enqueue(callerId, target, via, text),
      forkFor: (callerId, target, text, readOnly, via, signal) => this.delegationFlow.forkFor(callerId, target, text, readOnly, via, signal),
      autoBoundaryOpen: (sessionId, boundary) => this.autoBoundaryOpen(sessionId, boundary),
      createProjectAsked: (sessionId, spec, signal) => this.projectCreation.createProjectAsked(sessionId, spec, signal),
      createProjectOnMachine: (sessionId, reader, machine, spec, signal) => this.projectCreation.createProjectOnMachine(sessionId, reader, machine, spec, signal),
      handoff: (callerId, target, opts, signal) => this.handoffFlow.handoff(callerId, target, opts, signal),
      handoffWait: (callerId, handle, signal) => this.handoffFlow.wait(callerId, handle, signal),
      builderRefOf: (m) => this.appSessions.builderRefOf(m),
      checkApp: (ref) => this.checkApp(ref),
      createApp: (params) => this.createApp(params),
    })
  }

  /** `SessionTools.toolProfileOf` (session-tools.ts), kept on the manager for its callers */
  toolProfileOf(...a: Parameters<SessionTools['toolProfileOf']>): ReturnType<SessionTools['toolProfileOf']> {
    return this.tools.toolProfileOf(...a)
  }

  /** The tools given to an orchestrator (FR-11), built over this manager (`orchestrator-seat.ts`) */
  private orchestratorToolsFor(orchestratorId: string, scopeIds?: string[], ownProject?: boolean, hubView?: boolean): OrchestratorTools {
    return orchestratorToolsFor(this.seat(), orchestratorId, scopeIds, ownProject, hubView)
  }

  /** `AppSessions.createApp` (app-sessions.ts), kept on the manager for its callers */
  createApp(...a: Parameters<AppSessions['createApp']>): ReturnType<AppSessions['createApp']> {
    return this.appSessions.createApp(...a)
  }

  /** `AppSessions.builderOf` (app-sessions.ts), kept on the manager for its callers */
  builderOf(...a: Parameters<AppSessions['builderOf']>): ReturnType<AppSessions['builderOf']> {
    return this.appSessions.builderOf(...a)
  }

  /** `AppSessions.createAppBuilder` (app-sessions.ts), kept on the manager for its callers */
  createAppBuilder(...a: Parameters<AppSessions['createAppBuilder']>): ReturnType<AppSessions['createAppBuilder']> {
    return this.appSessions.createAppBuilder(...a)
  }

  /** `AppSessions.builderBusy` (app-sessions.ts), kept on the manager for its callers */
  builderBusy(...a: Parameters<AppSessions['builderBusy']>): ReturnType<AppSessions['builderBusy']> {
    return this.appSessions.builderBusy(...a)
  }

  /** `AppSessions.checkApp` (app-sessions.ts), kept on the manager for its callers */
  checkApp(...a: Parameters<AppSessions['checkApp']>): ReturnType<AppSessions['checkApp']> {
    return this.appSessions.checkApp(...a)
  }

  /**
   * The default agent tool for this scope — a project's default tool if it has one, or the
   * orchestrator's own tool if there is no project (a user-folder app). A builder session (C-2) and an
   * agent an app asked for (D-1) both use this same rule.
   */
  private defaultToolFor(projectId: string | null): ToolName | null {
    if (projectId !== null) {
      const project = this.projectRow(projectId)
      return this.firstTool(project?.defaultTool)
    }
    return this.firstTool(this.store.appSetting('orchestrator_tool'))
  }

  /** `ProjectConsents.ensureProjectAccess` (project-consents.ts), kept on the manager for its callers */
  ensureProjectAccess(...a: Parameters<ProjectConsents['ensureProjectAccess']>): ReturnType<ProjectConsents['ensureProjectAccess']> {
    return this.consents.ensureProjectAccess(...a)
  }

  /** `ProjectConsents.projectConsents` (project-consents.ts), kept on the manager for its callers */
  projectConsents(...a: Parameters<ProjectConsents['projectConsents']>): ReturnType<ProjectConsents['projectConsents']> {
    return this.consents.projectConsents(...a)
  }

  /** `ProjectConsents.revokeProjectConsent` (project-consents.ts), kept on the manager for its callers */
  revokeProjectConsent(...a: Parameters<ProjectConsents['revokeProjectConsent']>): ReturnType<ProjectConsents['revokeProjectConsent']> {
    return this.consents.revokeProjectConsent(...a)
  }

  /** The caller's own preset, read at the boundary, never its project's or parent's preset. */
  private autoBoundaryOpen(sessionId: string, boundary?: string): boolean {
    if (this.meta.get(sessionId)?.permissionPreset !== 'auto') return false
    if (boundary) console.error(`[permissions] auto session ${sessionId}: ${boundary} allowed`)
    return true
  }

  /** Whether a session may read this path because another project handed it back (#371, `CreateSessionOpts.mayRead`) */
  private mayRead(sessionId: string, path: string, cwd: string): boolean {
    const grants = this.readGrants.get(sessionId)
    return !!grants && grants.size > 0 && underGrant(path, grants, cwd)
  }

  /** `AskProjectFlow.askProject` (ask-project-flow.ts), kept on the manager for its callers */
  askProject(...a: Parameters<AskProjectFlow['askProject']>): ReturnType<AskProjectFlow['askProject']> {
    return this.askProjectFlow.askProject(...a)
  }

  /** `AgentStartFlow.startAgent` (start-agent-flow.ts), kept on the manager for its callers */
  startAgent(...a: Parameters<AgentStartFlow['startAgent']>): ReturnType<AgentStartFlow['startAgent']> {
    return this.delegationFlow.starts.startAgent(...a)
  }

  /** `DelegationFlow.agentSession` (delegation-flow.ts), kept on the manager for its callers */
  agentSession(...a: Parameters<DelegationFlow['agentSession']>): ReturnType<DelegationFlow['agentSession']> {
    return this.delegationFlow.agentSession(...a)
  }

  /**
   * The other sessions whose folder is inside this worktree (#647): a helper the child started without a worktree of
   * its own works in the child's. One asleep counts too — after a host swap no session has a process, and a message
   * wakes it right there. Removing the worktree under it would lose what it writes next, so cleanup is refused.
   */
  private sessionsInside(target: SessionInfo): SessionInfo[] {
    const root = target.worktree?.path
    if (!root) return []
    const folder = canonicalPath(root)
    return [...this.meta.values()].filter((s) => {
      if (s.id === target.id) return false
      const cwd = this.store.sessionCwd(s.id) ?? s.worktree?.path
      return !!cwd && isInside(folder, canonicalPath(cwd))
    })
  }

  /** `HostCards.appQuestionList` (host-cards.ts), kept on the manager for its callers */
  appQuestionList(...a: Parameters<HostCards['appQuestionList']>): ReturnType<HostCards['appQuestionList']> {
    return this.hostCards.appQuestionList(...a)
  }

  /** `HostCards.answerAppQuestion` (host-cards.ts), kept on the manager for its callers */
  answerAppQuestion(...a: Parameters<HostCards['answerAppQuestion']>): ReturnType<HostCards['answerAppQuestion']> {
    return this.hostCards.answerAppQuestion(...a)
  }

  /** `AppSessions.runAppAgent` (app-sessions.ts), kept on the manager for its callers */
  runAppAgent(...a: Parameters<AppSessions['runAppAgent']>): ReturnType<AppSessions['runAppAgent']> {
    return this.appSessions.runAppAgent(...a)
  }

  /** MCP server proposals waiting on the person's approval */
  /** The approved skills as a system prompt section (OrchestratorProposals.skillsPrompt) */
  private skillsPrompt(): string {
    return this.proposals.skillsPrompt()
  }

  mcpProposals(): ReturnType<OrchestratorProposals['mcpProposals']> {
    return this.proposals.mcpProposals()
  }

  /** Skill proposals waiting on the person's approval (#71) */
  skillProposals(): ReturnType<OrchestratorProposals['skillProposals']> {
    return this.proposals.skillProposals()
  }

  /** Skills that have been approved and loaded into the orchestrator's role prompt (#71) */
  orchestratorSkills(): ReturnType<OrchestratorProposals['orchestratorSkills']> {
    return this.proposals.orchestratorSkills()
  }

  /** The person's answer to a skill proposal (#71) — if approved, it is saved and the orchestrator is
   * restarted */
  async resolveSkillProposal(name: string, approve: boolean): Promise<{ ok: boolean; error?: string }> {
    return this.afterProposal(this.proposals.resolveSkillProposal(name, approve))
  }

  /** Deletes a skill — the orchestrator is restarted so the deleted skill leaves its prompt */
  async deleteOrchestratorSkill(name: string): Promise<{ ok: boolean; error?: string }> {
    return this.afterProposal(this.proposals.deleteOrchestratorSkill(name))
  }

  /** Restarts the orchestrator if it is alive — the shared path for reflecting a skill or MCP change
   * immediately */
  private async restartOrchestrator(): Promise<void> {
    const orch = [...this.meta.values()].find((m) => m.kind === 'orchestrator')
    if (orch) await this.restartSession(orch.id, 'instructions').catch(() => {})
  }

  /** The person's answer to an MCP server proposal — if approved, it becomes a user-folder app and the
   * orchestrator is restarted (OrchestratorProposals.resolveMcpProposal) */
  async resolveMcpProposal(name: string, approve: boolean): Promise<{ ok: boolean; error?: string }> {
    return this.afterProposal(this.proposals.resolveMcpProposal(name, approve))
  }

  /** Restarts the orchestrator when a proposal answer asks for it — the change is already saved by then */
  private async afterProposal({ restart, ...result }: ProposalOutcome): Promise<{ ok: boolean; error?: string }> {
    if (restart) await this.restartOrchestrator()
    return result
  }

  /**
   * A tool execution called through the bridge (the Codex path).
   *
   * **Only the orchestrator itself can call this.** The bridge is a separate process, so anyone
   * holding its token could call anything at all — leaving that door open to let one session instruct
   * another session that is not its own would turn access scope into a promise instead of something
   * structurally guaranteed.
   */
  async runOrchestratorTool(sessionId: string, name: string, args: Record<string, unknown>) {
    const m = this.meta.get(sessionId)
    const { profile, tools } = m ? this.tools.toolChoice(m) : { profile: null, tools: () => undefined }
    if (!m || !profile) {
      throw rpcError('Only the orchestrator can use this tool')
    }
    /*
     * Narrowing only what is exposed still lets anyone who knows the name just call it anyway (#69) —
     * the bridge is a separate process and can ask for anything at all with just the token. The same
     * check is made again on the execution side too.
     */
    if (!profileAllows(profile, name)) {
      throw rpcError(notAToolText(profile, name))
    }
    return runOrchestratorTool(tools()!, name, args, { sessionId, profile })
  }

  /**
   * Receives the external app runtime (M4 A-5) — a session that comes up after this receives whatever
   * apps decision 4 says it should.
   *
   * Why this is received separately instead of as a constructor argument: the runtime and the manager
   * never know about each other; the host (main.ts) is the one that connects them. This means the
   * host's own tests can run with no manager, and the manager's own tests can run with no runtime.
   */
  /** Where the installed CLI versions come from (#297) — wired by the host, like the app runtime */
  useVersionHint(hint: (tool: ToolName) => string | null): void {
    this.versionHint = hint
  }

  /** The same service the window calls; this tool never writes the automatic-apply preference. */
  useUpdates(updates: UpdateService): void {
    this.updatesAsked.updates = updates
  }

  /** The windows' "Apply now" for an agent (#665, update-apply.ts) — wired by the host, which owns the event stream */
  useUpdateApply(broker: UpdateApplyBroker): void {
    this.updatesAsked.updateApply = broker
  }

  /**
   * Says in the conversation that the session moved to a newer CLI (#297): restarting a process by itself is never
   * silent. A notice from Centralu, not from the tool, so it reads as what happened rather than as something to fix.
   */
  noteAgentMoved(sessionId: string, from: string, to: string): void {
    const m = this.meta.get(sessionId)
    if (!m) return
    const label = this.toolLabel(m.tool)
    this.onEvent({
      type: 'notice',
      sessionId,
      level: 'info',
      from: 'Centralu',
      label: 'agent update',
      text: `${label} restarted on ${to} (was ${from}). The conversation continues.`,
    })
  }

  /** `SessionAppWiring.useExternalApps` (session-app-wiring.ts), kept on the manager for its callers */
  useExternalApps(...a: Parameters<SessionAppWiring['useExternalApps']>): ReturnType<SessionAppWiring['useExternalApps']> {
    return this.apps.useExternalApps(...a)
  }

  /** `SessionAppWiring.appReach` (session-app-wiring.ts), kept on the manager for its callers */
  appReach(...a: Parameters<SessionAppWiring['appReach']>): ReturnType<SessionAppWiring['appReach']> {
    return this.apps.appReach(...a)
  }

  /** `SessionAppWiring.appSessionTools` (session-app-wiring.ts), kept on the manager for its callers */
  appSessionTools(...a: Parameters<SessionAppWiring['appSessionTools']>): ReturnType<SessionAppWiring['appSessionTools']> {
    return this.apps.appSessionTools(...a)
  }

  /** `SessionAppWiring.callAppForSession` (session-app-wiring.ts), kept on the manager for its callers */
  callAppForSession(...a: Parameters<SessionAppWiring['callAppForSession']>): ReturnType<SessionAppWiring['callAppForSession']> {
    return this.apps.callAppForSession(...a)
  }

  /** `SessionAppWiring.sessionAppsHub` (session-app-wiring.ts), kept on the manager for its callers */
  sessionAppsHub(...a: Parameters<SessionAppWiring['sessionAppsHub']>): ReturnType<SessionAppWiring['sessionAppsHub']> {
    return this.apps.sessionAppsHub(...a)
  }

  /** `SessionAppWiring.recordAppView` (session-app-wiring.ts), kept on the manager for its callers */
  recordAppView(...a: Parameters<SessionAppWiring['recordAppView']>): ReturnType<SessionAppWiring['recordAppView']> {
    return this.apps.recordAppView(...a)
  }

  /** `SessionAppWiring.setAppShared` (session-app-wiring.ts), kept on the manager for its callers */
  setAppShared(...a: Parameters<SessionAppWiring['setAppShared']>): ReturnType<SessionAppWiring['setAppShared']> {
    return this.apps.setAppShared(...a)
  }

  /** This project's trunk branch (#76): the one chosen for the former worktree manager's slot, still read from its row (#561
   * part 3). null if none was set — HEAD is then used as the baseline */
  private trunkOf(projectId: string): string | null {
    return this.store.worktreeTrunk(projectId)
  }

  /** Sets the project's worktree trunk (`worktrees.setTrunk`, #76; the manager's dialog chose it before #561 part 3) */
  async setWorktreeTrunk(projectId: string, baseBranch: string): Promise<void> {
    this.requireProject(projectId)
    const branch = baseBranch.trim()
    if (!branch) throw rpcError('Pick the branch worktrees should fork from')
    if (!(await gitValidBranchName(branch))) throw rpcError(`Not a branch name: ${branch}`)
    this.store.setWorktreeTrunk(projectId, branch)
    this.emit({ type: 'projects_changed' })
  }

  /**
   * PR status checker (#76, stage 3). Kept as a field because gh is a network call, and a test cannot
   * measure it — a test swaps this field out instead. prPollMs is also a field for the same reason (a test
   * sets it to 0).
   */
  prLookup: (projectCwd: string, branch: string, signal?: AbortSignal) => Promise<BranchPr | 'unavailable' | null> = gitBranchPr
  prPollMs = 120_000

  /** `MergeChecks.refreshMergedWorktrees` (merge-checks.ts), kept on the manager for its callers */
  refreshMergedWorktrees(...a: Parameters<MergeChecks['refreshMergedWorktrees']>): ReturnType<MergeChecks['refreshMergedWorktrees']> {
    return this.merges.refreshMergedWorktrees(...a)
  }

  /** A summary of the orchestrator's past conversation for its next system prompt (transcript-view.ts) */
  private orchestratorMemory(sessionId: string): string {
    return orchestratorMemory(this.store, sessionId)
  }

  /**
   * The app's one and only orchestrator. Created on the spot if none exists.
   *
   * **Only comes into existence when called.** Creating it ahead of time when the app is turned on
   * would leave a session nobody ever uses holding onto a tool process — too expensive a price just to
   * turn on the control tower.
   *
   * Returned as-is even if its process is dead. Bringing it back to life is send()'s own job (FR-10),
   * and reviving it here would mean a tool process comes up just from drawing the sidebar.
   */
  /**
   * Returns it if it exists, and **never creates one** if it does not (#63).
   *
   * Once onboarding started showing the orchestrator screen first, "opening the screen" stopped
   * meaning "creating the process". This only ever asks — the actual creation happens inside
   * orchestrator(), the moment the first question is sent. Creating it before that would spin up a
   * tool process on behalf of someone who never even asked for it.
   */
  orchestratorPeek(): SessionInfo | null {
    const known = this.store.orchestratorId()
    return known ? (this.meta.get(known) ?? null) : null
  }

  /**
   * The tool the central orchestrator runs on (#63, the card choice on the onboarding screen).
   *
   * **Only settings for before a session exists.** Because there is a gap between choosing and
   * actually creating it (clicking the card -> ... at some point later ... -> the first question),
   * the choice has to be recorded somewhere, and since this is a property of the install itself,
   * app_settings is the right place for it. Once it has actually been created, switching agents in the
   * session's own settings takes over — this value is never read again after that.
   */
  /**
   * The tool to use when nothing has chosen one — the first registered adapter, or none.
   *
   * A project's `defaultTool` is nullable because only the host knows which tools exist, so
   * a project created before any tool was picked has none. Falling back to a literal
   * `'claude'` here would put a vendor name back into code that is meant not to know any.
   */
  private firstTool(preferred?: ToolName | null): ToolName | null {
    return registeredTool(this.adapters, preferred)
  }

  /** A tool's display name, from whichever adapter owns it — falls back to the bare id. */
  private toolLabel(tool: ToolName): string {
    return this.adapters.get(tool)?.descriptor.label ?? tool
  }

  configureOrchestrator(tool: ToolName): void {
    this.store.setAppSetting('orchestrator_tool', tool)
  }

  /** The orchestrator being created (#839): a second ask while it is made waits on this one, never makes another */
  private orchestratorCreating: Promise<SessionInfo> | null = null

  async orchestrator(): Promise<SessionInfo> {
    const known = this.store.orchestratorId()
    if (known) {
      const m = this.meta.get(known)
      if (m) return m
      // The id remains but the session is gone — the marker alone is cleared, and a new one is created
    }
    if (this.orchestratorCreating) return this.orchestratorCreating
    const creating = this.createOrchestrator().finally(() => {
      if (this.orchestratorCreating === creating) this.orchestratorCreating = null
    })
    this.orchestratorCreating = creating
    return creating
  }

  private async createOrchestrator(): Promise<SessionInfo> {

    /*
     * The tool follows the choice made on the onboarding screen (configureOrchestrator) — hardcoding
     * 'claude' created a contradiction where someone with only Codex installed could pass through
     * onboarding ("Codex is ready") and still be unable to open the orchestrator (#63). The wiring on
     * the Codex side (the stdio bridge) was already laid down and measured by the project orchestrator (#13).
     */
    const configured = this.store.appSetting('orchestrator_tool')
    const info = await this.createSession({
      projectId: null,
      // The marker is born together with the session — stamping it separately would leave a window with no
      // marker at all
      kind: 'orchestrator',
      cwd: orchestratorHome(),
      tool: this.firstTool(configured),
      permissionPreset: 'normal',
    })
    // Kept as a name the person set, so the auto-name (FR-18) never overwrites it with the first prompt
    this.rename(info.id, 'Orchestrator')
    return this.meta.get(info.id)!
  }

  /**
   * The person sets a name (FR-18).
   *
   * **autoNamed is cleared so an auto-name can never overwrite it again.** An auto-name cuts down the
   * first prompt, but a session created by resuming or importing all share the same first line, so
   * four sessions named `This session is being continued…` once stood side by side in the list — the
   * name alone could not distinguish anything, and the body itself had to be searched (issue #5). So a
   * name the person has chosen once must survive no matter what happens.
   *
   * **Never silently passes through.** This used to just `return` when the session did not exist, and
   * the RPC still reported `{ ok: true }` — the name never changed, but the screen wore the face of success.
   */
  rename(sessionId: string, name: string): void {
    const m = this.sessionOf(sessionId)
    // One line (#838): a name goes into the model's text (list_sessions, cards, reports), where a line break started a line of its own
    const next = oneLineText(name)
    // An empty name becomes a row in the list that points at nothing at all — accepting it would create a
    // nameless session
    if (!next) throw rpcError('Session name cannot be empty')
    m.name = next
    m.autoNamed = false
    this.store.upsertSession(m)
    // auto:false — the receiving side needs to know "the person set this" in order to block the next
    // auto-name
    this.emit({ type: 'session_title', sessionId, title: next, auto: false })
  }

  markRead(sessionId: string, seq: number): void {
    const m = this.meta.get(sessionId)
    if (!m) return
    m.lastReadSeq = Math.max(m.lastReadSeq, seq)
    this.store.markRead(sessionId, seq)
  }

  /** `SessionRecord.messageImage` (session-record.ts), kept on the manager for its callers */
  messageImage(...a: Parameters<SessionRecord['messageImage']>): ReturnType<SessionRecord['messageImage']> {
    return this.record.messageImage(...a)
  }

  /** `SessionRecord.loadSubagentMessages` (session-record.ts), kept on the manager for its callers */
  loadSubagentMessages(...a: Parameters<SessionRecord['loadSubagentMessages']>): ReturnType<SessionRecord['loadSubagentMessages']> {
    return this.record.loadSubagentMessages(...a)
  }

  /** `SessionRecord.loadMessages` (session-record.ts), kept on the manager for its callers */
  loadMessages(...a: Parameters<SessionRecord['loadMessages']>): ReturnType<SessionRecord['loadMessages']> {
    return this.record.loadMessages(...a)
  }


  /**
   * The handles are being let go of (#839): a quit sweeping them (`disposeAll`), or a handover (`detachAll`). A process
   * that comes up now is missed by the sweep, so whoever started it stops it, and no process is swapped for another.
   * Only during the quit's sweep, not after: a manager stopped this way is woken again in tests, and a quitting host
   * exits once the sweep is done.
   */
  private sweepingHandles = false
  private lettingGo(): boolean {
    return this.sweepingHandles || this.handingOver
  }
  /** Refuses a process swap asked for while the handles are let go of (#839): it would stop a process the keeper keeps */
  private refuseWhileLettingGo(): void {
    if (this.lettingGo()) throw rpcError('Centralu is restarting or quitting; try again once it is back')
  }

  async disposeAll(): Promise<void> {
    this.sweepingHandles = true
    try {
      await this.disposeEverything()
    } finally {
      this.sweepingHandles = false
    }
  }

  private async disposeEverything(): Promise<void> {
    // The cards it closes below are not the person's answers: a standing start_agent request stays stored (#673)
    this.disposing = true
    this.leaveHost('Centralu is shutting down')
    // The messages in progress are written as they stand — a shutdown must not swallow the last two seconds (#66).
    // Written, not closed: the supervisor may kill the host before the processes are down
    for (const [id, run] of this.record.streams) this.record.flushStream(id, run)
    // Even if one fails, the rest are still cleaned up — one rejection blocking the whole cleanup during
    // shutdown would leave orphans behind
    // No merge check's git or gh is still running once this returns (#368)
    await Promise.allSettled([...[...this.handles.values()].map((h) => h.dispose()), ...this.merges.mergeChecks])
    // The closed processes get a moment to leave on their own before the host's exit takes them along (#353)
    await Promise.allSettled([...this.adapters.values()].map((a) => a.settle?.()))
    // Closed once the processes are down, so their last deltas grow the open rows instead of opening new ones (#213)
    for (const id of [...this.record.streams.keys()]) this.record.closeStream(id)
    // Stamped after dispose finishes (see the comment on stampExternalSynced). Never stamped on a
    // crash — stamping the current time when the actual moment of death is unknown could swallow
    // whatever happened externally between death and discovery.
    for (const id of this.handles.keys()) this.externals.stampExternalSynced(id)
    this.handles.clear()
  }

  /**
   * The host is leaving but the keeper keeps the agents (#280 step 2): a restart, a crash, a build
   * switch — and the blue-green swap of step 3 calls this too. The opposite of `disposeAll` where it
   * matters: no process is stopped, no waiting approval is denied, and the sessions keep their
   * state, because the next host re-attaches to the same processes and finds them as they were.
   *
   * What lives in this host still ends here: app agent runs and capability questions (the app
   * processes are restarted with the host, decision 2), and the in-process tool servers. Output that
   * arrives while each process is being released is recorded before the streams are closed, and
   * nothing is stamped as synced: the conversation goes on.
   */
  async detachAll(): Promise<void> {
    // The kept turns go on under the next host, which owes their reports (#646); failing the waits here must not report
    this.handingOver = true
    this.leaveHost('Centralu is restarting')
    await Promise.allSettled([...[...this.handles.values()].map((h) => (h.detach ? h.detach() : h.dispose())), ...this.merges.mergeChecks])
    for (const [id, run] of this.record.streams) this.record.flushStream(id, run)
    for (const id of [...this.record.streams.keys()]) this.record.closeStream(id)
    this.handles.clear()
  }

  /**
   * What ends with this host whether it quits (`disposeAll`) or hands its sessions over (`detachAll`), said once: the
   * two used to list it each, and handing over missed the reconnect clocks, which went on to flag a session from a
   * host that had already left. `why` is what the waits it fails hear.
   */
  private leaveHost(why: string): void {
    // Reconnect clocks die with the host (#698); the next one starts its own from the session's next event
    this.interruptions.stopAll()
    // So do the waits of paused reports (#721): quitting, the work ends with its process and the next start drops the
    // mark; handing over, the wait is the next host's, which starts it again on adoption
    this.reports.stopSettlingPausedReports()
    this.linkedReports.dispose()
    // So does a start waiting for memory (#686); handing over, it stays stored for the next host
    this.memoryGate?.close()
    this.watchers.close()
    // Ends a merge check's gh; the check itself is waited for with the processes (#368). The next host checks merges
    // again at its start
    this.merges.mergeChecksStop.abort()
    this.apps.appsHub?.rt.attachBrokerHost(null)
    for (const run of [...this.agentRuns.values()]) run.fail(new Error(why))
    for (const readers of this.turnObservers.values()) for (const observer of readers) observer.fail(new Error(why))
    for (const ask of [...this.hostCards.hostAsks.values()]) ask.resolve(null)
    this.hostCards.hostAsks.clear()
    for (const q of [...this.hostCards.appQuestions.values()]) q.resolve(null)
    this.hostCards.appQuestions.clear()
    this.apps.appAccess?.dispose()
    this.apps.appsHub?.dispose()
  }

  /** A session's row, or `session_not_found` */
  private sessionOf(sessionId: string): SessionInfo {
    const m = this.meta.get(sessionId)
    if (!m) throw sessionNotFound(sessionId)
    return m
  }

  /** Refuses a session whose worktree, or the worktree its folder is in, is being removed (#647) */
  private notBeingRemoved(sessionId: string): void {
    if (this.worktrees.worktreeCleanupBlocks(sessionId)) throw rpcError('The session worktree is being removed')
  }

  /** A session that may be woken, sent to or changed now: it exists and no worktree removal holds it (#647) */
  private openSession(sessionId: string): SessionInfo {
    this.notBeingRemoved(sessionId)
    return this.sessionOf(sessionId)
  }

  /** A registered project's row, read now (trust and paths change under a running host) */
  private projectRow(projectId: string | null | undefined): ReturnType<Store['listProjects']>[number] | undefined {
    return projectId ? this.store.listProjects().find((p) => p.id === projectId) : undefined
  }

  /** A registered project's row, or `Project not found` */
  private requireProject(projectId: string): ReturnType<Store['listProjects']>[number] {
    const p = this.projectRow(projectId)
    if (!p) throw rpcError(`Project not found: ${projectId}`)
    return p
  }

  /**
   * Whether a turn runs in the session for anyone (#677): its state says so, or a wait on it (an app's run, a
   * delegation) has not settled yet, which a turn that has not stepped into `working` already holds
   */
  private turnRunning(m: SessionInfo): boolean {
    const run = this.agentRuns.get(m.id)
    return inTurn(m.state) || (!!run && !run.finished)
  }

  private requireHandle(sessionId: string): SessionHandle {
    const h = this.handles.get(sessionId)
    if (!h) throw sessionNotFound(sessionId)
    return h
  }
}

/**
 * What we may honestly say when the tool has no record of a conversation.
 *
 * This used to read "This conversation was deleted in Claude Code". Nobody ever observed a
 * deletion. The tool only answered "not in this directory" — and it keys its session store
 * **by working directory**, so it says that whenever the folder moves too. That is what
 * happened (issue #28): renaming the data directory moved the orchestrator's cwd, the tool
 * looked under a slug that had never existed, and the app told its owner that 924 messages
 * and an 821KB transcript — both still sitting on disk — had been deleted.
 *
 * So: report the observation, name the directory we looked in, and offer the two causes we
 * cannot tell apart from here. Claiming a deletion we did not witness reads as data loss,
 * and a person who believes their data is gone stops looking for it.
 */
function externalMissingReason(label: string, cwd: string): string {
  return (
    `${label} has no record of this conversation under ${cwd} — either it was removed there, ` +
    `or this folder has moved since the session started. The history kept here is still readable, ` +
    `and you can continue in a new session`
  )
}

