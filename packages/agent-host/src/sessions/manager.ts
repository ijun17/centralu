import { repairWorktreeRecoveryRemovals } from '../dev-services/worktree-recovery.js'
import { windowAround } from './snippet.js'
import { orchestratorToolsFor, type OrchestratorSeatHost } from './orchestrator-seat.js'
import { QueuedRequests, type QueuedRequestsHost } from './queued-requests.js'
import { RoutedCards, type RoutedCardsHost } from './routed-cards.js'
import { HandoffChildren, type HandoffChildrenHost } from './handoff-children.js'
import { ChildReports, type ChildReportsHost } from './child-reports.js'
import { InterruptionWatch, type InterruptionWatchHost } from './interruption-watch.js'
import { LaunchRecords, type LaunchRecordsHost } from './launch-records.js'
import { MergeChecks, type MergeChecksHost } from './merge-checks.js'
import { MachineFlow, type MachineOps } from './machine-flow.js'
import { ProjectCreation, type ProjectCreationHost } from './project-creation.js'
import { UpdatesAsked, type UpdatesAskedHost } from './updates-asked.js'
import { ProjectConsents, type ProjectConsentsHost } from './project-consents.js'
import { UiPreferenceStore, type UiPreferenceStoreHost } from './ui-preferences.js'
import { SessionAppWiring, type SessionAppWiringHost } from './session-app-wiring.js'
import { SessionTools, type SessionToolsHost } from './session-tools.js'
import { HandoffNotes, type HandoffNotesHost } from './handoff-notes.js'
import { SessionStarts, freshStartKey, type SessionStartsHost } from './session-start.js'
import { SessionEvents, type SessionEventsHost } from './session-events.js'
import { ToolRegistry, type ToolRegistryHost } from './tool-registry.js'
import { ApprovalRules } from './approval-rules.js'
import { ProjectRegistry, type ProjectRegistryHost } from './project-registry.js'
import { LaunchInputs, type LaunchInputsHost } from './launch-inputs.js'
import { SessionLayout, type SessionLayoutHost } from './session-layout.js'
import { ChildOwnership, PAUSED_REPORT_SETTLE_MS } from './child-ownership.js'
import { LinkedReports, type LinkedReportsHost } from './linked-reports.js'
import { OrchestratorSlot, type OrchestratorSlotHost } from './orchestrator-slot.js'
import { LinkedHost, type LinkedHostHost } from './linked-host.js'
import { SessionSettings, type SessionSettingsHost } from './session-settings.js'
import { AgentRunWait } from './app-agents.js'
import { CacheLedger } from './cache-ledger.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  RebuildCause,
  ApprovalDecision,
  Attachment,
  ApprovalScope,
  MachineInfo,
  NormalizedEvent,
  PermissionPreset,
  QuestionAnswer,
  SessionInfo,
  SessionState,
  ToolName,
  MachineAskConsent,
} from '@cc/protocol'
import {
  sessionOnlyAlways,
  DATA_DIR,
  withoutToolRecord,
  alwaysAllowKey,
} from '@cc/protocol'
import type { AgentAdapter, AgentProcess, AgentSpawnSpec, EventSink, LinkedSessions, OrchestratorTools, SessionHandle } from '../adapters/contract.js'
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
import { gitWorktreeDirty } from '../dev-services/git-worktree.js'
import { gitBranchPr, type BranchPr } from '../dev-services/git-pr.js'
import { ProjectFiles } from '../dev-services/project-files.js'
import { AskProjectFlow, type AskProjectHost } from './ask-project-flow.js'
import { HandoffFlow, type HandoffFlowHost, type HandoffTimings } from './handoff-flow.js'
import { DelegationFlow, type DelegationHost, ASK_THE_PERSON, agentStartPersonText } from './delegation-flow.js'
import type { AgentStartFlow } from './start-agent-flow.js'
import { RestartPolicy, type RestartHost } from './restart-policy.js'
import { WorktreeSessions, type WorktreeHost } from './worktree-sessions.js'
import { canonicalPath, isInside } from '../dev-services/path-guard.js'
import { HostCards, type HostCardsHost } from './host-cards.js'
import { ExternalConversations, type ExternalConversationsHost } from './external-conversations.js'
import { SessionRecord, type SessionRecordHost } from './session-record.js'
import { ToolQueries, type ToolQueriesHost } from './tool-queries.js'
import { AppSessions, type AppSessionsHost } from './app-sessions.js'
import type { AppMessageSource, AppViewPlace } from './app-messages.js'
import { SessionTrash, type SessionTrashHost } from './session-trash.js'
import { MachineAsks } from './machine-asks.js'
import type { HubsReader } from './ask-project-flow.js'
export { appMessageFrame } from './app-messages.js'
export type { AppMessageSource, AppMessageVia, AppViewPlace } from './app-messages.js'
export { START_AGENT_CALL_MS, START_AGENT_MODEL_CHECK_MS, START_AGENT_SETUP_MS } from './delegation-flow.js'

/** What the modules moved out of the manager reach of it (`SessionManager.parts`): every module's host type at once */
type ManagerParts = HandoffFlowHost & HostCardsHost & WorktreeHost & RestartHost & SessionTrashHost & AppSessionsHost & ToolQueriesHost &
  SessionRecordHost & ExternalConversationsHost & AskProjectHost & LinkedReportsHost & DelegationHost & QueuedRequestsHost & RoutedCardsHost & HandoffChildrenHost & ChildReportsHost & InterruptionWatchHost & LaunchRecordsHost & MergeChecksHost & ProjectCreationHost & UpdatesAskedHost & ProjectConsentsHost & UiPreferenceStoreHost & SessionAppWiringHost & SessionToolsHost & HandoffNotesHost & SessionStartsHost & SessionEventsHost & ToolRegistryHost & ProjectRegistryHost & LaunchInputsHost & SessionLayoutHost & OrchestratorSlotHost & LinkedHostHost & SessionSettingsHost

// Lives with the paused reports it times (child-ownership.ts), here and for a linked machine's (#723)
export { PAUSED_REPORT_SETTLE_MS }
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
  /** Every session this host knows, in sidebar order; never replaced, so a module may read it through `parts()` */
  private readonly meta = new Map<string, SessionInfo>()
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
  /** Every model request's cache figures over the last day, per tool (docs/agent-host.md §6.1); read by `usageFor` */
  private readonly cacheLedger = new CacheLedger()
  /** A project's git panel, file tree and file operations (dev-services/project-files.ts) */
  private readonly files: ProjectFiles
  /** The agent tools this host runs: the default one, labels, accounts, whether one can start now (tool-registry.ts) */
  private readonly toolRegistry: ToolRegistry
  /** The remembered "always allow" answers: written, read for a launch, listed in Settings (approval-rules.ts) */
  private readonly approvalRules: ApprovalRules
  /** The registered projects: rows, folders, trust, `ProjectInfo` and the settings kept on them (project-registry.ts) */
  private readonly projectRegistry: ProjectRegistry
  /** What a session's process is launched with: setting files, read grants, the orchestrator's memory and skills (launch-inputs.ts) */
  private readonly launchInputs: LaunchInputs
  /** The sidebar order of sessions and the grid's panels (session-layout.ts) */
  private readonly layout: SessionLayout
  /** A linked machine's events and work owed there, and what a hub reads of and sends to this host (linked-host.ts) */
  private readonly linkedHost: LinkedHost
  /** What is changed on a session: settings, name, read mark, background tasks, CLI move notices (session-settings.ts) */
  private readonly sessionSettings: SessionSettings
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
  private readonly machineFlow: MachineFlow
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
  /** A linked machine's sessions asking this computer's projects (#550) */
  private readonly machineAsks: MachineAsks
  /** This computer's name as a linked machine's session reads it (#550); main.ts gives the host name */
  private hubName: () => string = () => 'this computer'
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
  /** A session's process brought up, for a new session or a wake, and what it launches with (session-start.ts) */
  private readonly starts: SessionStarts
  /** What a session's tool says, received and settled, and what goes into its conversation (session-events.ts) */
  private readonly events: SessionEvents
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
  /** The central orchestrator: its making, its proposals and skills, the bridge's door to its tools (orchestrator-slot.ts) */
  private readonly orchestratorSlot: OrchestratorSlot
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
    this.files = new ProjectFiles({
      rootOf: (projectId) => this.projectRegistry.cwdOf(projectId),
      trust: (projectId) => this.projectRegistry.gitTrust(projectId),
      session: (sessionId) => this.meta.get(sessionId),
      store,
      // `this.emit` is wrapped below; looked up when a change goes out, not now
      emit: (e) => this.emit(e),
    })
    this.toolRegistry = new ToolRegistry(this.parts())
    this.projectRegistry = new ProjectRegistry(this.parts())
    this.launchInputs = new LaunchInputs(this.parts())
    this.layout = new SessionLayout(this.parts())
    this.linkedHost = new LinkedHost(this.parts())
    this.sessionSettings = new SessionSettings(this.parts())
    this.approvalRules = new ApprovalRules(this.parts())
    this.children = new ChildOwnership(store)
    this.handoffNotes = new HandoffNotes(this.parts())
    this.tools = new SessionTools(this.parts())
    this.apps = new SessionAppWiring(this.parts())
    this.prefs = new UiPreferenceStore(this.parts())
    this.consents = new ProjectConsents(this.parts())
    this.updatesAsked = new UpdatesAsked(this.parts())
    this.projectCreation = new ProjectCreation(this.parts())
    this.machineFlow = new MachineFlow(this.parts())
    this.merges = new MergeChecks(this.parts())
    this.launches = new LaunchRecords(this.parts())
    this.interruptions = new InterruptionWatch(this.parts())
    this.reports = new ChildReports(this.parts())
    this.handoffChildren = new HandoffChildren(this.parts())
    this.cards = new RoutedCards(this.parts())
    this.queue = new QueuedRequests(this.parts())
    this.cardRests = new CardRests(appSettingRests(store.settings))
    this.delegationFlow = new DelegationFlow(this.parts())
    this.handoffFlow = new HandoffFlow(this.parts(), keeperOpts.handoffTimings)
    this.askProjectFlow = new AskProjectFlow(this.parts())
    this.machineAsks = new MachineAsks(this.parts(), () => this.hubName())
    this.externals = new ExternalConversations(this.parts())
    this.record = new SessionRecord(this.parts())
    this.toolQueries = new ToolQueries(this.parts())
    this.appSessions = new AppSessions(this.parts())
    this.trash = new SessionTrash(this.parts())
    this.restartPolicy = new RestartPolicy(this.parts())
    this.worktrees = new WorktreeSessions(this.parts())
    this.hostCards = new HostCards(this.parts())
    this.linkedReports = new LinkedReports(this.parts())
    this.starts = new SessionStarts(this.parts())
    this.events = new SessionEvents(this.parts())
    this.orchestratorSlot = new OrchestratorSlot(this.parts())
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
    for (const s of store.sessions.listSessions()) {
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
        store.sessions.upsertSession(fixed)
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
    const marks = new Map(store.children.listReportMarks().map((r) => [r.sessionId, r.callerSessionId]))
    const turnGivers = new Map(store.children.listDelegatedTurns().map((r) => [r.sessionId, r.callerSessionId]))
    for (const s of stoppedByQuit) {
      const requester = [marks.get(s.id), turnGivers.get(s.id), s.askedBy].find((id): id is string => !!id && id !== s.id && this.meta.has(id))
      if (requester) this.quitNotices.push({ sessionId: s.id, requester })
    }
    // A card the previous host left standing over a kept process closes back into its rest here too (#428)
    this.cardRests.restore((id) => !!keeperOpts.keptSessions?.has(id) && this.meta.get(id)?.state === 'waiting_approval')
    this.children.restoreReports(this.meta, keeperOpts.keptSessions)
    this.delegationFlow.starts.restoreAgentStarts()
    // The reports owed of children on linked machines (#1038): each settles once its machine says where it stands
    this.delegationFlow.remote.restore()
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
    this.recoveryRepair = repairWorktreeRecoveryRemovals((id) => store.trash.isTrashed(id)).catch((e) => console.error(`[trash] recovery folders left by an interrupted purge were not repaired: ${(e as Error).message}`))
    this.nameUnnamedWorktrees()
    // "Always allow" rules ending in `*` (#838): since #908 none allows anything, and an older build read them as prefixes
    const wildcards = store.permissions.dropWildcardApprovalRules()
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
      this.store.sessions.upsertSession(renamed)
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

  /** `ProjectCreation.inspectFolder` (project-creation.ts): `projects.inspect` (#1220) */
  inspectFolder(...a: Parameters<ProjectCreation['inspectFolder']>): ReturnType<ProjectCreation['inspectFolder']> {
    return this.projectCreation.inspectFolder(...a)
  }

  /** The linked machines as `machines.list` answers (#1220), for the orchestrator's list_machines; none until wired */
  private machineList: () => MachineInfo[] = () => []

  useMachineList(list: () => MachineInfo[]): void {
    this.machineList = list
  }

  /** The hub's links, for the orchestrator's machine commands (#1219); main.ts wires them */
  useMachineOps(ops: MachineOps): void {
    this.machineFlow.useOps(ops)
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
   * Sessions the store moved into a project behind the manager's back (#1141: a user-folder app's builder and agents,
   * when its folder became a project in place, after this manager loaded them). The loaded copies follow, so the
   * builder is found under the app's new key in this same run, and each window hears the session again
   * (`session_created`, which a window applies to a session it already holds when the project differs). A live
   * handle's attachment is moved as well, so a builder that outlived the move (kept across a host swap) is still given
   * its own app.
   */
  sessionsMovedToProject(sessionIds: readonly string[], projectId: string): void {
    for (const id of sessionIds) {
      const m = this.meta.get(id)
      if (!m || m.projectId === projectId) continue
      const moved = { ...m, projectId }
      this.meta.set(id, moved)
      // A live handle's app attachment follows too (a builder kept running across a swap): it gets its own app again at once
      this.apps.appsHub?.sessionMoved(id, projectId)
      this.emit({ type: 'session_created', sessionId: id, session: moved })
    }
    // The names sessions saw the app under, and what they attached, moved to its new key in the store (#1141, #1205):
    // both are read again
    this.apps.appAccess?.reload()
    this.apps.appsHub?.reloadNames()
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
    const root = this.projectRegistry.projectRow(projectId)?.path
    this.store.trash.deleteProject(projectId)
    // Its apps' secrets too, as their grants above (#1141): a project id is never reused, so nobody could read them again
    this.apps.appsHub?.rt.forgetProject(projectId)
    // What was held for the project's folder goes with it (#392): its watchers and its `@` file index
    this.files.forgetProject(projectId, root)
  }

  /** How many of a project's directories are watched (tests) */
  watchedDirCount(projectId: string): number {
    return this.files.watchedDirCount(projectId)
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
    const was = this.projectRegistry.projectRow(projectId)?.trusted
    if (!this.store.projects.setProjectTrusted(projectId, trusted)) {
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

  /** `ProjectRegistry.setProjectCommands` (project-registry.ts), kept on the manager for its callers */
  setProjectCommands(...a: Parameters<ProjectRegistry['setProjectCommands']>): ReturnType<ProjectRegistry['setProjectCommands']> {
    return this.projectRegistry.setProjectCommands(...a)
  }

  /** `ProjectRegistry.setWorktreeSetup` (project-registry.ts), kept on the manager for its callers */
  setWorktreeSetup(...a: Parameters<ProjectRegistry['setWorktreeSetup']>): ReturnType<ProjectRegistry['setWorktreeSetup']> {
    return this.projectRegistry.setWorktreeSetup(...a)
  }

  /** `ProjectRegistry.reorderProjects` (project-registry.ts), kept on the manager for its callers */
  reorderProjects(...a: Parameters<ProjectRegistry['reorderProjects']>): ReturnType<ProjectRegistry['reorderProjects']> {
    return this.projectRegistry.reorderProjects(...a)
  }

  /** `SessionLayout.reorderSessions` (session-layout.ts), kept on the manager for its callers */
  reorderSessions(...a: Parameters<SessionLayout['reorderSessions']>): ReturnType<SessionLayout['reorderSessions']> {
    return this.layout.reorderSessions(...a)
  }

  /** `SessionLayout.grid` (session-layout.ts), kept on the manager for its callers */
  grid(...a: Parameters<SessionLayout['grid']>): ReturnType<SessionLayout['grid']> {
    return this.layout.grid(...a)
  }

  /** `SessionLayout.setGridView` (session-layout.ts), kept on the manager for its callers */
  setGridView(...a: Parameters<SessionLayout['setGridView']>): ReturnType<SessionLayout['setGridView']> {
    return this.layout.setGridView(...a)
  }

  /** `SessionLayout.useLinkedSessions` (session-layout.ts), kept on the manager for its callers */
  useLinkedSessions(...a: Parameters<SessionLayout['useLinkedSessions']>): ReturnType<SessionLayout['useLinkedSessions']> {
    return this.layout.useLinkedSessions(...a)
  }

  /** `SessionLayout.useLinkedApps` (session-layout.ts), kept on the manager for its callers */
  useLinkedApps(...a: Parameters<SessionLayout['useLinkedApps']>): ReturnType<SessionLayout['useLinkedApps']> {
    return this.layout.useLinkedApps(...a)
  }

  /** The linked machines' sessions, for the central orchestrator's and a trusted reader's reading tools (#82 phase 4, #984). None without links */
  private linkedReader: LinkedSessions | null = null

  useLinkedReader(reader: LinkedSessions): void {
    this.linkedReader = reader
  }

  /** The hubs linked to this host that let its sessions ask their projects (#550, links/linked-hubs.ts) */
  useLinkedHubs(hubs: HubsReader): void {
    this.askProjectFlow.hubs = hubs
  }

  /** This computer's name, as a linked machine's session reads it in an answer or a refusal (#550) */
  useHubName(name: () => string): void {
    this.hubName = name
  }

  /**
   * A linked machine's session asks a project of this computer (#550, the reverse direction, `hub.askProject`): this
   * computer's card for the pair, then the task in an existing ordinary session here (sessions/machine-asks.ts)
   */
  askFromMachine(...a: Parameters<MachineAsks['ask']>): ReturnType<MachineAsks['ask']> {
    return this.machineAsks.ask(...a)
  }

  /** The projects a linked machine's session may name (`hub.projects`, #550) */
  projectsForMachines(): ReturnType<MachineAsks['projects']> {
    return this.machineAsks.projects()
  }

  /** Every approved pair of the reverse direction, with the names as they are now (#550, Settings → Machines) */
  machineAskConsents(machineName: (id: string) => string | undefined): MachineAskConsent[] {
    const names = new Map(this.store.projects.listProjects().map((p) => [p.id, p.name]))
    return this.store.machines.listMachineAskConsents().map((c) => ({
      ...c,
      machineName: machineName(c.machineId) ?? c.machineId,
      projectName: names.get(c.projectId) ?? '(project no longer exists)',
    }))
  }

  /** Closes the cards standing for a machine's asks (#550 review): its switch went off, or it was removed */
  closeMachineAskCards(machineId: string): void {
    this.machineAsks.closeCards(machineId)
  }

  /** Withdraws one approved pair (#550): that session's next ask into that project raises the card again */
  withdrawMachineAsk(machineId: string, sessionId: string, projectId: string): void {
    if (this.store.machines.forgetMachineAskConsent(machineId, sessionId, projectId)) this.emit({ type: 'project_consents_changed' })
  }

  /** `LinkedHost.linkedWorkOwed` (linked-host.ts), kept on the manager for its callers */
  linkedWorkOwed(...a: Parameters<LinkedHost['linkedWorkOwed']>): ReturnType<LinkedHost['linkedWorkOwed']> {
    return this.linkedHost.linkedWorkOwed(...a)
  }

  /** `LinkedHost.remoteAgentParent` (linked-host.ts), kept on the manager for its callers */
  remoteAgentParent(...a: Parameters<LinkedHost['remoteAgentParent']>): ReturnType<LinkedHost['remoteAgentParent']> {
    return this.linkedHost.remoteAgentParent(...a)
  }

  /** `LinkedHost.observeLinked` (linked-host.ts), kept on the manager for its callers */
  observeLinked(...a: Parameters<LinkedHost['observeLinked']>): ReturnType<LinkedHost['observeLinked']> {
    return this.linkedHost.observeLinked(...a)
  }

  /** `LinkedHost.sendFromHub` (linked-host.ts), kept on the manager for its callers */
  sendFromHub(...a: Parameters<LinkedHost['sendFromHub']>): ReturnType<LinkedHost['sendFromHub']> {
    return this.linkedHost.sendFromHub(...a)
  }

  /** `LinkedHost.hostReader` (linked-host.ts), kept on the manager for its callers */
  hostReader(...a: Parameters<LinkedHost['hostReader']>): ReturnType<LinkedHost['hostReader']> {
    return this.linkedHost.hostReader(...a)
  }

  /** `ProjectRegistry.listProjects` (project-registry.ts), kept on the manager for its callers */
  listProjects(...a: Parameters<ProjectRegistry['listProjects']>): ReturnType<ProjectRegistry['listProjects']> {
    return this.projectRegistry.listProjects(...a)
  }

  /** `ProjectRegistry.projectGitStatus` (project-registry.ts), kept on the manager for its callers */
  projectGitStatus(...a: Parameters<ProjectRegistry['projectGitStatus']>): ReturnType<ProjectRegistry['projectGitStatus']> {
    return this.projectRegistry.projectGitStatus(...a)
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

  /** `SessionStarts.createSession` (session-start.ts), kept on the manager for its callers */
  createSession(...a: Parameters<SessionStarts['createSession']>): ReturnType<SessionStarts['createSession']> {
    return this.starts.createSession(...a)
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
    const p = this.starts.doResumeSession(sessionId, adopt).finally(() => this.resuming.delete(sessionId))
    this.resuming.set(sessionId, p)
    return p
  }

  /** Says in the conversation that the restart in progress applies a change of the project's trust (#663) */
  private noticeTrustRestart(sessionId: string): void {
    if (!this.restartPolicy.trustRestartNotice.delete(sessionId)) return
    const m = this.meta.get(sessionId)
    if (!m || !this.handles.has(sessionId)) return
    const text = this.projectRegistry.projectTrusted(m.projectId)
      ? "Restarted the agent to apply this project's new trust: it now reads the project's own settings and instruction files (CLAUDE.md, AGENTS.md)."
      : "Restarted the agent to apply this project's removed trust: it now reads only your own settings, not the project's files."
    this.onEvent({ type: 'notice', sessionId, level: 'info', from: 'Centralu', label: 'restart', text })
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
            this.events.applyStateHint(change, m)
            this.interruptions.markStoppedByQuit(m, true)
            this.store.sessions.upsertSession(m)
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
      this.store.sessions.upsertSession(m)
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

  /** `SessionTrash.readTrashedRun` (session-trash.ts), kept on the manager for its callers */
  readTrashedRun(...a: Parameters<SessionTrash['readTrashedRun']>): ReturnType<SessionTrash['readTrashedRun']> {
    return this.trash.readTrashedRun(...a)
  }

  /** `SessionTrash.purgeTrashedRuns` (session-trash.ts), kept on the manager for its callers */
  purgeTrashedRuns(...a: Parameters<SessionTrash['purgeTrashedRuns']>): ReturnType<SessionTrash['purgeTrashedRuns']> {
    return this.trash.purgeTrashedRuns(...a)
  }

  /** `SessionTrash.emptyTrash` (session-trash.ts), kept on the manager for its callers */
  emptyTrash(...a: Parameters<SessionTrash['emptyTrash']>): ReturnType<SessionTrash['emptyTrash']> {
    return this.trash.emptyTrash(...a)
  }

  /** `SessionTrash.subagentUsage` (session-trash.ts, #418), kept on the manager for its callers */
  subagentUsage(...a: Parameters<SessionTrash['subagentUsage']>): ReturnType<SessionTrash['subagentUsage']> {
    return this.trash.subagentUsage(...a)
  }

  /** `SessionTrash.trashSubagentSteps` (session-trash.ts, #418), kept on the manager for its callers */
  trashSubagentSteps(...a: Parameters<SessionTrash['trashSubagentSteps']>): ReturnType<SessionTrash['trashSubagentSteps']> {
    return this.trash.trashSubagentSteps(...a)
  }

  /** `SessionTrash.restoreSubagentSteps` (session-trash.ts, #418), kept on the manager for its callers */
  restoreSubagentSteps(...a: Parameters<SessionTrash['restoreSubagentSteps']>): ReturnType<SessionTrash['restoreSubagentSteps']> {
    return this.trash.restoreSubagentSteps(...a)
  }

  /** `SessionTrash.purgeSubagentSteps` (session-trash.ts, #418), kept on the manager for its callers */
  purgeSubagentSteps(...a: Parameters<SessionTrash['purgeSubagentSteps']>): ReturnType<SessionTrash['purgeSubagentSteps']> {
    return this.trash.purgeSubagentSteps(...a)
  }

  /** `SessionTrash.subagentTrashed` (session-trash.ts, #418), kept on the manager for its callers */
  subagentTrashed(...a: Parameters<SessionTrash['subagentTrashed']>): ReturnType<SessionTrash['subagentTrashed']> {
    return this.trash.subagentTrashed(...a)
  }

  /** `SessionSettings.updateSettings` (session-settings.ts), kept on the manager for its callers */
  updateSettings(...a: Parameters<SessionSettings['updateSettings']>): ReturnType<SessionSettings['updateSettings']> {
    return this.sessionSettings.updateSettings(...a)
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

  /** `SessionEvents.onEvent` (session-events.ts), kept on the manager for its callers */
  private onEvent(...a: Parameters<SessionEvents['onEvent']>): ReturnType<SessionEvents['onEvent']> {
    return this.events.onEvent(...a)
  }

  /** A queued note not yet taken, on the delegation's wait or an observer's own reader (#646): the session is not between turns */
  private inputsHeld(sessionId: string): boolean {
    if (this.agentRuns.get(sessionId)?.waitingForInputs) return true
    for (const observer of this.turnObservers.get(sessionId) ?? []) if (observer.waitingForInputs) return true
    return false
  }

  /** The rest an adapter's card raised between turns was raised in (`CardRests`, card-rest.ts), written to the store */
  private cardRests: CardRests

  /** `SessionRecord.saveAttachment` (session-record.ts), kept on the manager for its callers */
  saveAttachment(...a: Parameters<SessionRecord['saveAttachment']>): ReturnType<SessionRecord['saveAttachment']> {
    return this.record.saveAttachment(...a)
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
    // The person wrote to it (#378): an app's agent session they wrote to becomes theirs
    if (!from) this.appSessions.noteTookPart(sessionId, 'wrote')
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
   * An app's notice into a session that called it (#1161 item 1, the broker's `notify`) — delivered as a report
   * arrives: recorded as the app's message and handed to the agent framed as the app's text (`appMessageFrame`
   * `notice`), waking the session if it is idle or asleep. Throws a reason the app reads when it cannot be delivered
   * now: while this host hands over or quits (the app tries again; the next host takes it), or once the session is gone.
   */
  async appNotice(sessionId: string, text: string, app: AppMessageSource): Promise<void> {
    if (this.handingOver || this.disposing) throw new Error('Centralu is restarting; post it again in a moment')
    if (!this.meta.has(sessionId) || this.trash.trashing.has(sessionId)) throw new Error('that session is gone')
    return this.deliver(sessionId, text, undefined, undefined, false, app, 'notice')
  }

  /** `SessionEvents.deliver` (session-events.ts), kept on the manager for its callers */
  private deliver(...a: Parameters<SessionEvents['deliver']>): ReturnType<SessionEvents['deliver']> {
    return this.events.deliver(...a)
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
    this.store.settings.setAppSetting(freshStartKey(m.id), String(this.store.messages.loadMessages(m.id, 1)[0]?.seq ?? 0))
    /*
     * The broadcast state is also written into meta (#163). It used to only broadcast idle while
     * saving meta as working, so a screen that reconnected and the orchestrator's list_sessions both
     * saw an interrupted turn as "still working" (the settings tool refused that session outright).
     */
    this.events.settleState(m, { type: 'state_change', sessionId, state: 'idle', reason: 'tool_changed' })

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

    // Persisting the rule (approval-rules.ts)
    // Only the card's own key (`remembered` above): an edit with no path has none (#428), so "(no path)" is never a rule
    if (decision === 'always' && m && remembered) this.approvalRules.rememberAlways(sessionId, m.projectId, scope, remembered)
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

  /** `ToolRegistry.accountFor` (tool-registry.ts), kept on the manager for its callers */
  accountFor(...a: Parameters<ToolRegistry['accountFor']>): ReturnType<ToolRegistry['accountFor']> {
    return this.toolRegistry.accountFor(...a)
  }

  /** `ToolQueries.listModels` (tool-queries.ts), kept on the manager for its callers */
  listModels(...a: Parameters<ToolQueries['listModels']>): ReturnType<ToolQueries['listModels']> {
    return this.toolQueries.listModels(...a)
  }

  /** A project's working directory. Used by the terminal to decide its own key (cwd) */
  cwdOfProject(projectId: string): string {
    return this.projectRegistry.cwdOf(projectId)
  }

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
    const stored = this.store.sessions.sessionCwd(m.id)
    if (stored) return stored
    const derived = m.worktree?.path ?? this.projectRegistry.cwdOf(m.projectId)
    this.store.sessions.setSessionCwd(m.id, derived)
    return derived
  }

  /** `ProjectRegistry.folderRoots` (project-registry.ts), kept on the manager for its callers */
  folderRoots(...a: Parameters<ProjectRegistry['folderRoots']>): ReturnType<ProjectRegistry['folderRoots']> {
    return this.projectRegistry.folderRoots(...a)
  }

  /** The material needed to decide whether a worktree can be deleted. null if this is not a worktree session
   */
  async worktreeStatus(
    sessionId: string,
  ): Promise<{ path: string; branch: string; dirty: boolean; changedFiles: number; more?: true; unknown?: true } | null> {
    const m = this.meta.get(sessionId)
    if (!m?.worktree) return null
    // A failed read is not a clean worktree: the delete dialog then warns instead of removing quietly (#850 review)
    const state = await gitWorktreeDirty(m.worktree.path, this.projectRegistry.gitTrust(m.projectId)).catch(() => ({
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

  /** `ProjectRegistry.gitTrust` (project-registry.ts), kept on the manager for its callers */
  gitTrust(...a: Parameters<ProjectRegistry['gitTrust']>): ReturnType<ProjectRegistry['gitTrust']> {
    return this.projectRegistry.gitTrust(...a)
  }

  /** `ProjectFiles.projectOrigin` (dev-services/project-files.ts), kept on the manager for its callers */
  projectOrigin(...a: Parameters<ProjectFiles['projectOrigin']>): ReturnType<ProjectFiles['projectOrigin']> {
    return this.files.projectOrigin(...a)
  }

  /** `ProjectFiles.gitStatusFiles` (dev-services/project-files.ts), kept on the manager for its callers */
  gitStatusFiles(...a: Parameters<ProjectFiles['gitStatusFiles']>): ReturnType<ProjectFiles['gitStatusFiles']> {
    return this.files.gitStatusFiles(...a)
  }

  /** `ProjectFiles.gitDiff` (dev-services/project-files.ts), kept on the manager for its callers */
  gitDiff(...a: Parameters<ProjectFiles['gitDiff']>): ReturnType<ProjectFiles['gitDiff']> {
    return this.files.gitDiff(...a)
  }

  /** `ProjectFiles.gitLog` (dev-services/project-files.ts), kept on the manager for its callers */
  gitLog(...a: Parameters<ProjectFiles['gitLog']>): ReturnType<ProjectFiles['gitLog']> {
    return this.files.gitLog(...a)
  }

  /** `ProjectFiles.gitCommitDetail` (dev-services/project-files.ts), kept on the manager for its callers */
  gitCommitDetail(...a: Parameters<ProjectFiles['gitCommitDetail']>): ReturnType<ProjectFiles['gitCommitDetail']> {
    return this.files.gitCommitDetail(...a)
  }

  /** `ProjectFiles.gitBranches` (dev-services/project-files.ts), kept on the manager for its callers */
  gitBranches(...a: Parameters<ProjectFiles['gitBranches']>): ReturnType<ProjectFiles['gitBranches']> {
    return this.files.gitBranches(...a)
  }

  /** `ProjectFiles.gitIgnoredEntries` (dev-services/project-files.ts), kept on the manager for its callers */
  gitIgnoredEntries(...a: Parameters<ProjectFiles['gitIgnoredEntries']>): ReturnType<ProjectFiles['gitIgnoredEntries']> {
    return this.files.gitIgnoredEntries(...a)
  }

  /** `ProjectFiles.gitCheckout` (dev-services/project-files.ts), kept on the manager for its callers */
  gitCheckout(...a: Parameters<ProjectFiles['gitCheckout']>): ReturnType<ProjectFiles['gitCheckout']> {
    return this.files.gitCheckout(...a)
  }

  /** `ProjectFiles.gitStage` (dev-services/project-files.ts), kept on the manager for its callers */
  gitStage(...a: Parameters<ProjectFiles['gitStage']>): ReturnType<ProjectFiles['gitStage']> {
    return this.files.gitStage(...a)
  }

  /** `ProjectFiles.gitCommit` (dev-services/project-files.ts), kept on the manager for its callers */
  gitCommit(...a: Parameters<ProjectFiles['gitCommit']>): ReturnType<ProjectFiles['gitCommit']> {
    return this.files.gitCommit(...a)
  }

  /** `ProjectFiles.gitPush` (dev-services/project-files.ts), kept on the manager for its callers */
  gitPush(...a: Parameters<ProjectFiles['gitPush']>): ReturnType<ProjectFiles['gitPush']> {
    return this.files.gitPush(...a)
  }

  /** `ProjectFiles.gitCancel` (dev-services/project-files.ts), kept on the manager for its callers */
  gitCancel(...a: Parameters<ProjectFiles['gitCancel']>): ReturnType<ProjectFiles['gitCancel']> {
    return this.files.gitCancel(...a)
  }

  /** `ProjectFiles.listDir` (dev-services/project-files.ts), kept on the manager for its callers */
  listDir(...a: Parameters<ProjectFiles['listDir']>): ReturnType<ProjectFiles['listDir']> {
    return this.files.listDir(...a)
  }

  /** `ProjectFiles.watchDirs` (dev-services/project-files.ts), kept on the manager for its callers */
  watchDirs(...a: Parameters<ProjectFiles['watchDirs']>): ReturnType<ProjectFiles['watchDirs']> {
    return this.files.watchDirs(...a)
  }

  /** `ProjectFiles.forgetWatchHolder` (dev-services/project-files.ts), kept on the manager for its callers */
  forgetWatchHolder(...a: Parameters<ProjectFiles['forgetWatchHolder']>): ReturnType<ProjectFiles['forgetWatchHolder']> {
    return this.files.forgetWatchHolder(...a)
  }

  /** `ProjectFiles.readTextFile` (dev-services/project-files.ts), kept on the manager for its callers */
  readTextFile(...a: Parameters<ProjectFiles['readTextFile']>): ReturnType<ProjectFiles['readTextFile']> {
    return this.files.readTextFile(...a)
  }

  /** `ProjectFiles.moveEntry` (dev-services/project-files.ts), kept on the manager for its callers */
  moveEntry(...a: Parameters<ProjectFiles['moveEntry']>): ReturnType<ProjectFiles['moveEntry']> {
    return this.files.moveEntry(...a)
  }

  /** `ProjectFiles.importFile` (dev-services/project-files.ts), kept on the manager for its callers */
  importFile(...a: Parameters<ProjectFiles['importFile']>): ReturnType<ProjectFiles['importFile']> {
    return this.files.importFile(...a)
  }

  /** `ProjectFiles.resolveFile` (dev-services/project-files.ts), kept on the manager for its callers */
  resolveFile(...a: Parameters<ProjectFiles['resolveFile']>): ReturnType<ProjectFiles['resolveFile']> {
    return this.files.resolveFile(...a)
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

  /** `ApprovalRules.listApprovalRules` (approval-rules.ts), kept on the manager for its callers */
  listApprovalRules(...a: Parameters<ApprovalRules['listApprovalRules']>): ReturnType<ApprovalRules['listApprovalRules']> {
    return this.approvalRules.listApprovalRules(...a)
  }

  /** `ApprovalRules.deleteApprovalRule` (approval-rules.ts), kept on the manager for its callers */
  deleteApprovalRule(...a: Parameters<ApprovalRules['deleteApprovalRule']>): ReturnType<ApprovalRules['deleteApprovalRule']> {
    return this.approvalRules.deleteApprovalRule(...a)
  }

  /**
   * Search for the command palette. The store now returns the whole body, so **it is cut down to one
   * line right here** (the palette only ever shows one line). The orchestrator's recall cuts a much
   * wider window from that same body — how much is needed is up to whoever is using it.
   */
  searchMessages(query: string, limit?: number) {
    return this.store
      .messages.searchMessages(query, limit)
      .map((h) => ({ sessionId: h.sessionId, seq: h.seq, snippet: windowAround(h.body, query, 60) }))
  }

  /** `SessionSettings.stopBackgroundTask` (session-settings.ts), kept on the manager for its callers */
  stopBackgroundTask(...a: Parameters<SessionSettings['stopBackgroundTask']>): ReturnType<SessionSettings['stopBackgroundTask']> {
    return this.sessionSettings.stopBackgroundTask(...a)
  }

  /** `SessionSettings.clearBackgroundTasks` (session-settings.ts), kept on the manager for its callers */
  clearBackgroundTasks(...a: Parameters<SessionSettings['clearBackgroundTasks']>): ReturnType<SessionSettings['clearBackgroundTasks']> {
    return this.sessionSettings.clearBackgroundTasks(...a)
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
   * kept: `emit` is re-wrapped in the constructor, and a kept value would leave a module on the old one (#757 review:
   * `reorderSessions` used to replace `meta`; it sorts it in place since #1143). Each
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
      appProjectTarget: (...a) => self.projectCreation.appProjectTarget(...a),
      registerMadeFolder: (...a) => self.projectCreation.registerMadeFolder(...a),
      applyStateHint: (...a) => self.events.applyStateHint(...a),
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
      get appSessions() {
        return self.appSessions
      },
      get apps() {
        return self.apps
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
      get cardRests() {
        return self.cardRests
      },
      get cards() {
        return self.cards
      },
      get children() {
        return self.children
      },
      checkMergedInBackground: (...a) => self.merges.checkMergedInBackground(...a),
      cleanUpWorktreeChild: (...a) => self.worktrees.cleanUpWorktreeChild(...a),
      get lettingGo() {
        return self.lettingGo()
      },
      get closing() {
        return self.disposing || self.handingOver
      },
      createSession: (...a) => self.createSession(...a),
      cwdFor: (...a) => self.cwdFor(...a),
      cwdOf: (...a) => self.projectRegistry.cwdOf(...a),
      defaultToolFor: (...a) => self.toolRegistry.defaultToolFor(...a),
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
      get endpoint() {
        return self.endpoint
      },
      enqueue: (...a) => self.queue.enqueue(...a),
      ensureProjectAccess: (...a) => self.ensureProjectAccess(...a),
      exportHandoffNote: (...a) => self.exportHandoffNote(...a),
      exportHandoffRecord: (...a) => self.exportHandoffRecord(...a),
      get externals() {
        return self.externals
      },
      firstTool: (...a) => self.toolRegistry.firstTool(...a),
      forgetCardRest: (id) => self.cardRests.forget(id),
      forgetCommits: (...a) => self.events.forgetCommits(...a),
      gitTrust: (...a) => self.projectRegistry.gitTrust(...a),
      grantReads: (...a) => self.delegationFlow.grantReads(...a),
      handedOverReply: (...a) => self.delegationFlow.handedOverReply(...a),
      handleSink: () => self.handleSink(),
      get handingOver() {
        return self.handingOver
      },
      get handles() {
        return self.handles
      },
      handoffHeir: (...a) => self.handoffNotes.handoffHeir(...a),
      get handoffChildren() {
        return self.handoffChildren
      },
      get handoffNotes() {
        return self.handoffNotes
      },
      hasSession: (id) => self.meta.has(id),
      get hubAskTurns() {
        return self.linkedHost.hubAskTurns
      },
      get askProjectFlow() {
        return self.askProjectFlow
      },
      get linkedReports() {
        return self.linkedReports
      },
      get hostCards() {
        return self.hostCards
      },
      inputsHeld: (...a) => self.inputsHeld(...a),
      get interruptions() {
        return self.interruptions
      },
      isAppAgentSession: (...a) => self.apps.isAppAgentSession(...a),
      get keeperOpts() {
        return self.keeperOpts
      },
      get launches() {
        return self.launches
      },
      get leaving() {
        return self.leaving
      },
      get linkedReader() {
        return self.linkedReader
      },
      linkedTasksRunning: (...a) => self.linkedReports.ownTasksRunning(...a),
      listCommands: (...a) => self.listCommands(...a),
      listSessions: (...a) => self.listSessions(...a),
      loadMessages: (...a) => self.loadMessages(...a),
      migrateApprovedMcpServers: (...a) => self.orchestratorSlot.proposals.migrateApprovedMcpServers(...a),
      mayRead: (...a) => self.launchInputs.mayRead(...a),
      get memoryGate() {
        return self.memoryGate
      },
      get meta() {
        return self.meta
      },
      modelsWithin: (...a) => self.toolQueries.modelsWithin(...a),
      moveChildren: (...a) => self.handoffChildren.moveChildren(...a),
      notBeingRemoved: (...a) => self.notBeingRemoved(...a),
      observeCommit: (...a) => self.events.observeCommit(...a),
      openSession: (...a) => self.openSession(...a),
      orchestratorMemory: (...a) => self.launchInputs.orchestratorMemory(...a),
      orchestratorToolsFor: (...a) => self.orchestratorToolsFor(...a),
      onEvent: (e: NormalizedEvent, from?: SessionHandle | null) => self.onEvent(e, from),
      ownTasksRunning: (...a) => self.reports.ownTasksRunning(...a),
      pauseReport: (...a) => self.reports.pauseReport(...a),
      pausedTasksNow: (...a) => self.reports.pausedTasksNow(...a),
      get proposals() {
        return self.orchestratorSlot.proposals
      },
      get prLookup() {
        return self.prLookup
      },
      get prPollMs() {
        return self.prPollMs
      },
      get prCheckedAt() {
        return self.merges.prCheckedAt
      },
      projectInfo: (...a) => self.projectRegistry.projectInfo(...a),
      projectOrigin: (...a) => self.files.projectOrigin(...a),
      projectRow: (...a) => self.projectRegistry.projectRow(...a),
      projectTrusted: (...a) => self.projectRegistry.projectTrusted(...a),
      queuedOf: (...a) => self.queue.queuedOf(...a),
      get queue() {
        return self.queue
      },
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
      get reports() {
        return self.reports
      },
      rememberBackgroundTasks: (...a) => self.launches.rememberBackgroundTasks(...a),
      rename: (...a) => self.rename(...a),
      requireHandle: (...a) => self.requireHandle(...a),
      requireAppAccess: (...a) => self.apps.requireAppAccess(...a),
      respondApproval: (...a) => self.respondApproval(...a),
      runAppAgent: (...a) => self.runAppAgent(...a),
      appNotice: (...a) => self.appNotice(...a),
      reportBackIfAwaited: (...a) => self.reports.reportBackIfAwaited(...a),
      get restartPolicy() {
        return self.restartPolicy
      },
      restartSession: (...a) => self.restartSession(...a),
      resumeSession: (...a) => self.resumeSession(...a),
      get resuming() {
        return self.resuming
      },
      routedCards: (...a) => self.cards.routedCards(...a),
      rulesFor: (...a) => self.approvalRules.rulesFor(...a),
      get running() {
        return self.running
      },
      scheduleDrain: (...a) => self.queue.scheduleDrain(...a),
      send: (...a) => self.send(...a),
      sessionsInside: (...a) => self.sessionsInside(...a),
      sessionOf: (...a) => self.sessionOf(...a),
      settingFilesFor: (...a) => self.launchInputs.settingFilesFor(...a),
      settleState: (...a) => self.events.settleState(...a),
      settleLinkedTurn: (sessionId) => self.linkedReports.observe({ type: 'turn_complete', sessionId }),
      // Whose a linked child's turn is decides whether its report goes (#1038 review)
      reportGate: (sessionId) => self.delegationFlow.remote.reportGate(sessionId),
      skillsPrompt: () => self.launchInputs.skillsPrompt(),
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
      toolLabel: (...a) => self.toolRegistry.toolLabel(...a),
      get tools() {
        return self.tools
      },
      nameOf: (...a) => self.reports.nameOf(...a),
      toolProblem: (...a) => self.toolRegistry.toolProblem(...a),
      trashSession: (...a) => self.trashSession(...a),
      purgeSession: (...a) => self.purgeSession(...a),
      trashIf: (...a) => self.trash.trashIf(...a),
      agentRunEnded: (...a) => self.appSessions.agentRunEnded(...a),
      get trashing() {
        return self.trash.trashing
      },
      trunkOf: (...a) => self.projectRegistry.trunkOf(...a),
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
      get versionHint() {
        return self.versionHint
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
   * runs, never kept: a kept value would leave the tools on an old one (#757 review, when `reorderSessions` still replaced
   * `meta`; it sorts it in place since #1143).
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
        return self.orchestratorSlot.proposals
      },
      linkedReader: () => this.linkedReader,
      linkedReportRestored: (sessionId) => this.linkedReports.restored(sessionId),
      emit: (e) => this.emit(e),
      updateCentraluAsked: (sessionId, action, signal) => this.updatesAsked.updateCentraluAsked(sessionId, action, signal),
      updateSettings: (sessionId, settings, by) => this.updateSettings(sessionId, settings, by),
      createSession: (params) => this.createSession(params),
      firstTool: (preferred) => this.toolRegistry.firstTool(preferred),
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
      askAppProject: (sessionId, spec, signal) => this.projectCreation.askAppProject(sessionId, spec, signal),
      createProjectOnMachine: (sessionId, reader, machine, spec, signal) => this.projectCreation.createProjectOnMachine(sessionId, reader, machine, spec, signal),
      addFolderAsked: (sessionId, path, signal) => this.projectCreation.addFolderAsked(sessionId, path, signal),
      addFolderOnMachine: (sessionId, reader, machine, path, signal) => this.projectCreation.addFolderOnMachine(sessionId, reader, machine, path, signal),
      machineList: () => this.machineList(),
      machineRequest: (sessionId, req, signal) => this.machineFlow.run(sessionId, req, signal),
      startAgent: (callerId, opts, signal) => this.startAgent(callerId, opts, signal),
      agentSession: (callerId, opts, signal) => this.agentSession(callerId, opts, signal),
      listAgents: (callerId) => this.delegationFlow.listAgents(callerId),
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

  /** `AppSessions.commitImport` (app-sessions.ts): an import brought in as a project of its own (#1141) */
  commitImport(...a: Parameters<AppSessions['commitImport']>): ReturnType<AppSessions['commitImport']> {
    return this.appSessions.commitImport(...a)
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
      const cwd = this.store.sessions.sessionCwd(s.id) ?? s.worktree?.path
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

  /** `OrchestratorSlot.mcpProposals` (orchestrator-slot.ts), kept on the manager for its callers */
  mcpProposals(...a: Parameters<OrchestratorSlot['mcpProposals']>): ReturnType<OrchestratorSlot['mcpProposals']> {
    return this.orchestratorSlot.mcpProposals(...a)
  }

  /** `OrchestratorSlot.skillProposals` (orchestrator-slot.ts), kept on the manager for its callers */
  skillProposals(...a: Parameters<OrchestratorSlot['skillProposals']>): ReturnType<OrchestratorSlot['skillProposals']> {
    return this.orchestratorSlot.skillProposals(...a)
  }

  /** `OrchestratorSlot.orchestratorSkills` (orchestrator-slot.ts), kept on the manager for its callers */
  orchestratorSkills(...a: Parameters<OrchestratorSlot['orchestratorSkills']>): ReturnType<OrchestratorSlot['orchestratorSkills']> {
    return this.orchestratorSlot.orchestratorSkills(...a)
  }

  /** `OrchestratorSlot.resolveSkillProposal` (orchestrator-slot.ts), kept on the manager for its callers */
  resolveSkillProposal(...a: Parameters<OrchestratorSlot['resolveSkillProposal']>): ReturnType<OrchestratorSlot['resolveSkillProposal']> {
    return this.orchestratorSlot.resolveSkillProposal(...a)
  }

  /** `OrchestratorSlot.deleteOrchestratorSkill` (orchestrator-slot.ts), kept on the manager for its callers */
  deleteOrchestratorSkill(...a: Parameters<OrchestratorSlot['deleteOrchestratorSkill']>): ReturnType<OrchestratorSlot['deleteOrchestratorSkill']> {
    return this.orchestratorSlot.deleteOrchestratorSkill(...a)
  }

  /** `OrchestratorSlot.resolveMcpProposal` (orchestrator-slot.ts), kept on the manager for its callers */
  resolveMcpProposal(...a: Parameters<OrchestratorSlot['resolveMcpProposal']>): ReturnType<OrchestratorSlot['resolveMcpProposal']> {
    return this.orchestratorSlot.resolveMcpProposal(...a)
  }

  /** `OrchestratorSlot.runOrchestratorTool` (orchestrator-slot.ts), kept on the manager for its callers */
  runOrchestratorTool(...a: Parameters<OrchestratorSlot['runOrchestratorTool']>): ReturnType<OrchestratorSlot['runOrchestratorTool']> {
    return this.orchestratorSlot.runOrchestratorTool(...a)
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

  /** `SessionSettings.noteAgentMoved` (session-settings.ts), kept on the manager for its callers */
  noteAgentMoved(...a: Parameters<SessionSettings['noteAgentMoved']>): ReturnType<SessionSettings['noteAgentMoved']> {
    return this.sessionSettings.noteAgentMoved(...a)
  }

  /** `SessionSettings.noteAgentMoveFailed` (session-settings.ts), kept on the manager for its callers */
  noteAgentMoveFailed(...a: Parameters<SessionSettings['noteAgentMoveFailed']>): ReturnType<SessionSettings['noteAgentMoveFailed']> {
    return this.sessionSettings.noteAgentMoveFailed(...a)
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

  /** `ProjectRegistry.setWorktreeTrunk` (project-registry.ts), kept on the manager for its callers */
  setWorktreeTrunk(...a: Parameters<ProjectRegistry['setWorktreeTrunk']>): ReturnType<ProjectRegistry['setWorktreeTrunk']> {
    return this.projectRegistry.setWorktreeTrunk(...a)
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

  /** `OrchestratorSlot.orchestratorPeek` (orchestrator-slot.ts), kept on the manager for its callers */
  orchestratorPeek(...a: Parameters<OrchestratorSlot['orchestratorPeek']>): ReturnType<OrchestratorSlot['orchestratorPeek']> {
    return this.orchestratorSlot.orchestratorPeek(...a)
  }

  /** `OrchestratorSlot.configureOrchestrator` (orchestrator-slot.ts), kept on the manager for its callers */
  configureOrchestrator(...a: Parameters<OrchestratorSlot['configureOrchestrator']>): ReturnType<OrchestratorSlot['configureOrchestrator']> {
    return this.orchestratorSlot.configureOrchestrator(...a)
  }

  /** `OrchestratorSlot.orchestrator` (orchestrator-slot.ts), kept on the manager for its callers */
  orchestrator(...a: Parameters<OrchestratorSlot['orchestrator']>): ReturnType<OrchestratorSlot['orchestrator']> {
    return this.orchestratorSlot.orchestrator(...a)
  }

  /** `SessionSettings.rename` (session-settings.ts), kept on the manager for its callers */
  rename(...a: Parameters<SessionSettings['rename']>): ReturnType<SessionSettings['rename']> {
    return this.sessionSettings.rename(...a)
  }

  /** `SessionSettings.markRead` (session-settings.ts), kept on the manager for its callers */
  markRead(...a: Parameters<SessionSettings['markRead']>): ReturnType<SessionSettings['markRead']> {
    return this.sessionSettings.markRead(...a)
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
    this.files.close()
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

