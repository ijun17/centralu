import { ModelWindows, autoCompactPlan } from './auto-compact.js'
import { repairWorktreeRecoveryRemovals } from '../dev-services/worktree-recovery.js'
import { windowAround } from './snippet.js'
import { createdPreset, orchestratorToolsFor, type OrchestratorSeatHost } from './orchestrator-seat.js'
import { parseAddress } from '../mail/address.js'
import { presetWithin } from './start-agent.js'
import { matchProjects } from './ask-project.js'
import { AskedGate } from './asked-gate.js'
import { withHubMark } from './hub-preset.js'
import { MailNotAtRest } from '../mail/delivery.js'
import { QueuedRequests, type QueuedRequestsHost } from './queued-requests.js'
import { RoutedCards, type RoutedCardsHost } from './routed-cards.js'
import { HandoffChildren, type HandoffChildrenHost } from './handoff-children.js'
import { ChildReports, type ChildReportsHost } from './child-reports.js'
import { InterruptionWatch, type InterruptionWatchHost } from './interruption-watch.js'
import { OverloadRetry } from './overload-retry.js'
import { LaunchRecords, type LaunchRecordsHost } from './launch-records.js'
import { MergeChecks, type MergeChecksHost } from './merge-checks.js'
import { MachineFlow, type MachineOps } from './machine-flow.js'
import { PreferencesFlow } from './preferences-flow.js'
import { TrashFlow } from './trash-flow.js'
import { TrustFlow } from './trust-flow.js'
import { AppUpkeepFlow } from './app-upkeep-flow.js'
import { HousekeepingFlow } from './housekeeping-flow.js'
import type { WindowRpc } from './window-rpc.js'
import { ProjectCreation, type ProjectCreationHost } from './project-creation.js'
import { UpdatesAsked, type UpdatesAskedHost } from './updates-asked.js'
import { ProjectConsents, type ProjectConsentsHost } from './project-consents.js'
import { UiPreferenceStore, type UiPreferenceStoreHost } from './ui-preferences.js'
import { SessionAppWiring, type SessionAppWiringHost } from './session-app-wiring.js'
import { SessionTools, type SessionToolsHost } from './session-tools.js'
import { HandoffNotes, type HandoffNotesHost } from './handoff-notes.js'
import { SessionStarts, type SessionStartsHost } from './session-start.js'
import { SessionEvents, type SessionEventsHost } from './session-events.js'
import { MailSessionsView, type MailSessionsHost } from './mail-sessions.js'
import { TurnInputs, type TurnInputsHost } from './turn-inputs.js'
import { SessionProcesses, type SessionProcessesHost } from './session-processes.js'
import { SelfCompaction } from './self-compaction.js'
import { settingThenKeep } from './then-keep.js'
import { ContextNudges } from './context-nudges.js'
import { ToolRegistry, type ToolRegistryHost } from './tool-registry.js'
import { ApprovalRules } from './approval-rules.js'
import { ProjectRegistry, type ProjectRegistryHost } from './project-registry.js'
import { LaunchInputs, type LaunchInputsHost } from './launch-inputs.js'
import { SessionLayout, type SessionLayoutHost } from './session-layout.js'
import { ChildOwnership, type QuitNotice, type TurnStarter } from './child-ownership.js'
import { LinkedReports, type LinkedReportsHost } from './linked-reports.js'
import { OrchestratorSlot, type OrchestratorSlotHost } from './orchestrator-slot.js'
import { LinkedHost, type LinkedHostHost } from './linked-host.js'
import { SessionSettings, type SessionSettingsHost } from './session-settings.js'
import { CacheLedger } from './cache-ledger.js'
import { UsageRecorder } from './usage-recorder.js'
import { usageHistory } from './usage-history.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  MachineInfo,
  NormalizedEvent,
  PermissionPreset,
  SessionInfo,
  ToolName,
  MachineAskConsent,
  UsageHistory,
  UsageHistoryBy,
} from '@cc/protocol'
import {
  autoCompactOf,
  DATA_DIR,
  withoutToolRecord,
  errorMessage,
  ORCHESTRATOR_CHANGE,
  oneLineText,
  PermissionPreset as PresetSchema,
} from '@cc/protocol'
import type { AgentAdapter, AgentProcess, AgentSpawnSpec, LinkedSessions, OrchestratorTools, SessionHandle } from '../adapters/contract.js'
import { raceTimeout } from '../timing.js'
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
import { cutTurns, inTurn, turnCut } from '../idle.js'
import { crashedInSystemEnd, cutBySystemEnd, type SystemEnd } from '../lifecycle/system-end.js'
import { recordUpdateCut, UpdateResumeLists, type UpdateResumeFolder } from '../lifecycle/update-resume.js'
import type { Ended } from '../lifecycle/update-ended.js'
import { stoppedAtUpdate, updateNote, type Stopped } from '../lifecycle/update-stopped.js'
import { UPDATE_CONTINUE_LINE, UPDATE_TASKS_LINE } from './interruptions.js'
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
import { SessionTrash, type SessionTrashHost } from './session-trash.js'
import { MachineAsks } from './machine-asks.js'
import type { HubsReader } from './ask-project-flow.js'

/** How long `adoptKept` waits for an adopted tool to say whether its conversation is idle (`SessionHandle.adoptedIdle`): past it, the turn is taken to go on */
const ADOPTED_IDLE_WAIT_MS = 30_000

/** What the modules moved out of the manager reach of it (`SessionManager.parts`): every module's host type at once */
type ManagerParts = HandoffFlowHost & HostCardsHost & WorktreeHost & RestartHost & SessionTrashHost & AppSessionsHost & ToolQueriesHost &
  SessionRecordHost & ExternalConversationsHost & AskProjectHost & LinkedReportsHost & DelegationHost & QueuedRequestsHost & RoutedCardsHost & HandoffChildrenHost & ChildReportsHost & InterruptionWatchHost & LaunchRecordsHost & MergeChecksHost & ProjectCreationHost & UpdatesAskedHost & ProjectConsentsHost & UiPreferenceStoreHost & SessionAppWiringHost & SessionToolsHost & HandoffNotesHost & SessionStartsHost & SessionEventsHost & ToolRegistryHost & ProjectRegistryHost & LaunchInputsHost & SessionLayoutHost & OrchestratorSlotHost & LinkedHostHost & SessionSettingsHost & MailSessionsHost & TurnInputsHost & SessionProcessesHost

/** Whether `o` stands on `proto` (`Object.setPrototypeOf` answers `any`, so the type is said here, not asserted) */
function stands<O extends object, P extends object>(o: O, proto: P): o is O & P {
  return Object.getPrototypeOf(o) === proto
}

/**
 * Session lifecycle plus persistence. Adapters hold no state (docs/agent-host.md §2), so all state
 * tracking and storage happens here.
 */
export class SessionManager {
  private handles = new Map<string, SessionHandle>()
  /** Every session this host knows, in sidebar order; never replaced, so a module may read it through `parts()` */
  private readonly meta = new Map<string, SessionInfo>()
  /** Every model request's cache figures over the last day, per tool (docs/agent-host.md §6.1); read by `usageFor` */
  private readonly cacheLedger = new CacheLedger(Date.now(), (tool) => this.adapters.get(tool)?.cacheBilling ?? 'anthropic')
  /** The same requests summed per hour and kept, with the limit windows' readings (docs/agent-host.md §6.2) */
  private readonly usageRecorder: UsageRecorder
  /** Each model's context window as the tools reported it, for where agents compact (#1376, auto-compact.ts) */
  private readonly modelWindows: ModelWindows
  /** A project's git panel, file tree and file operations (dev-services/project-files.ts); the RPC router calls it directly */
  readonly files: ProjectFiles
  /** The agent tools this host runs: the default one, labels, accounts, whether one can start now (tool-registry.ts) */
  readonly toolRegistry: ToolRegistry
  /** The remembered "always allow" answers: written, read for a launch, listed in Settings (approval-rules.ts) */
  readonly approvalRules: ApprovalRules
  /** The registered projects: rows, folders, trust, `ProjectInfo` and the settings kept on them (project-registry.ts) */
  readonly projectRegistry: ProjectRegistry
  /** What a session's process is launched with: setting files, read grants, the orchestrator's memory and skills (launch-inputs.ts) */
  private readonly launchInputs: LaunchInputs
  /** The sidebar order of sessions and the grid's panels (session-layout.ts) */
  readonly layout: SessionLayout
  /** A linked machine's events and work owed there, and what a hub reads of and sends to this host (linked-host.ts) */
  readonly linkedHost: LinkedHost
  /** What is changed on a session: settings, name, read mark, background tasks, CLI move notices (session-settings.ts) */
  readonly sessionSettings: SessionSettings
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
  /** A turn the provider ended for want of capacity, kept waiting to be continued (overload-retry.ts, #1693) */
  private readonly overloadRetry: OverloadRetry
  /** What a session's process was started with, kept for the next host, and the restart a change needs (launch-records.ts) */
  readonly launches: LaunchRecords
  /** Whether worktree branches have landed on their trunk, by git or by their PR (merge-checks.ts) */
  readonly merges: MergeChecks
  /** A project added or made here, and the orchestrator's create_project (project-creation.ts) */
  readonly projectCreation: ProjectCreation
  private readonly machineFlow: MachineFlow
  /** The orchestrator's get_preferences and set_preferences (preferences-flow.ts) */
  private readonly preferencesFlow: PreferencesFlow
  /** The orchestrator's session archive commands (trash-flow.ts) */
  private readonly trashFlow: TrashFlow
  /** The orchestrator's trust commands (trust-flow.ts) */
  private readonly trustFlow: TrustFlow
  /** The orchestrator's app upkeep commands (app-upkeep-flow.ts) */
  private readonly appUpkeepFlow: AppUpkeepFlow
  /** The orchestrator's housekeeping and read commands (housekeeping-flow.ts) */
  private readonly housekeepingFlow = new HousekeepingFlow()
  /** An agent's update_centralu: check, install and apply, behind its preset and the person's card (updates-asked.ts) */
  private readonly updatesAsked: UpdatesAsked
  /** Compacting at a turn's end: the agent's `compact_self` and a session at rest over the lower share (#1451, self-compaction.ts) */
  private readonly selfCompaction: SelfCompaction
  /** The quiet notices that tell a growing session to call `compact_self` (#1492, context-nudges.ts) */
  private readonly contextNudges: ContextNudges
  /** Whether a session of one project may reach another, and the consents remembered for it (project-consents.ts) */
  readonly consents: ProjectConsents
  /** The screen's preferences and workspace layout (ui-preferences.ts) */
  readonly prefs: UiPreferenceStore
  /** The external app runtime as the sessions meet it: attached apps, on-demand access, the broker (session-app-wiring.ts) */
  readonly apps: SessionAppWiring
  /** The tools a session receives: its profile, its bundle, the reader's set (session-tools.ts) */
  readonly tools: SessionTools
  /** A handoff's note: written, read by a successor, swept when nobody owns it (handoff-notes.ts) */
  readonly handoffNotes: HandoffNotes
  /** ask_project, here or on a linked machine (ask-project-flow.ts) */
  private readonly askProjectFlow: AskProjectFlow
  /** A linked machine's sessions asking this computer's projects (#550) */
  readonly machineAsks: MachineAsks
  /** This computer's name as a linked machine's session reads it (#550); main.ts gives the host name */
  private hubName: () => string = () => 'this computer'
  /** The conversations a tool keeps on its own side: listing, holders, import and catch-up (external-conversations.ts) */
  readonly externals: ExternalConversations
  /** What a session's events leave in the store: streamed messages, rows, images (session-record.ts) */
  readonly record: SessionRecord
  /** What the host asks a tool outside a turn: commands, usage, models (tool-queries.ts) */
  readonly toolQueries: ToolQueries
  /** The sessions an external app owns: its builder and the agents it asks for (app-sessions.ts) */
  readonly appSessions: AppSessions
  /** A session's way to the session archive and back: delete, list, restore, purge (session-trash.ts) */
  readonly trash: SessionTrash
  /** When a session's process is replaced, and the background work a restart waits for (restart-policy.ts) */
  private readonly restartPolicy: RestartPolicy
  /** A worktree session's worktree: made for a new session, taken apart on cleanup (worktree-sessions.ts) */
  readonly worktrees: WorktreeSessions
  /** The cards the host raises in a session's approval slot, and the screen's capability questions (host-cards.ts) */
  readonly hostCards: HostCards
  /** The orchestrator's steps that ask the person when a session asked for the turn (#1447) */
  private readonly askedGate: AskedGate
  /** The orchestrator's reports from linked machines' sessions, and the work they pause on (linked-reports.ts) */
  private readonly linkedReports: LinkedReports
  /** A session's process brought up, for a new session or a wake, and what it launches with (session-start.ts) */
  private readonly starts: SessionStarts
  /** What a session's tool says, received and settled, and what goes into its conversation (session-events.ts) */
  readonly events: SessionEvents
  /** The mailbox's view of the sessions: its hooks, whether a session can take mail now, stop notices, seat rules (mail-sessions.ts) */
  readonly mail: MailSessionsView
  /** What goes into a session's turn from outside its tool: messages, approvals, answers, a Stop, and the waits on a turn (turn-inputs.ts) */
  readonly inputs: TurnInputs
  /** A session's process: woken, forked, switched, put to sleep, restarted, and whether it is idle (session-processes.ts) */
  readonly processes: SessionProcesses
  /** The central orchestrator: its making, its proposals and skills, the bridge's door to its tools (orchestrator-slot.ts) */
  readonly orchestratorSlot: OrchestratorSlot
  /**
   * The installed version of a tool as last read (#297, agent-versions.ts), or null. A process started now runs it,
   * so a session carries it as its `agentVersion` until the process reports its own; it is also what the keeper's
   * tag records, because a process the next host adopts does not report again.
   */
  private versionHint: ((tool: ToolName) => string | null) | null = null
  /** Turns a quit cut, and who to tell, waiting for the start to finish (#698, `tellQuitNotices`) */
  private quitNotices: QuitNotice[] = []
  /**
   * The session each turn a quit cut is told to by the older report path (`tellAskerOfInterruption`), and whether that path told it (known once it
   * ended), read by the mailbox's stop notice (`quitTold`) so a session told is not told again and one not told is. `read`: the stop notice asked
   */
  private quitRequesters = new Map<string, { requester: string; told?: boolean; read?: boolean }>()
  /** Sessions this start found mid-turn with no process: the person is told of the ones whose work is theirs (§8.1), once the mailbox is wired */
  private quitPersonWork: string[] = []
  /**
   * Sessions an update's stop left, to tell once the start is done (#1618, `continueCutTurns`): a turn it cut is continued (`turn`; its end
   * says so, #1966); a session at rest whose tasks it stopped is woken for the note alone (#1902). `stopped`: what else it ended there
   */
  private updateCuts: { sessionId: string; turn: boolean; stopped: Stopped | null }[] = []
  /**
   * The turns this host continues because an update cut them, and when its start took them up (#1618): said in every hello,
   * for a hub's callers. Taken at the start, before this host answers any hello, so a hub that connects while a Continue is
   * still on its way is told of it too (#1626 review); one that turns out lost leaves it (`turnLostInSwap`)
   */
  private continuedAfterUpdate: { sessionId: string; at: number }[] = []
  /** The lists of the turns an update cut that the stops before this start left (#1618), each removed once dealt with */
  private updateLists: UpdateResumeLists | null = null
  /** A linked hub stops this host for an update (`host.stop { forUpdate }`): the turns its stop ends are listed (#1618) */
  private stoppingForUpdate = false
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
    private endpoint?: (sessionId: string) => { url: string; token: string; credential?: string } | null,
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
      /** How long a kept process that could not be re-attached is waited for after SIGTERM before it is killed and its session resumed; default 5 s */
      exitWaitMs?: number
      /**
       * The data folder's list of the turns an update cut (#1618, lifecycle/update-resume.ts): the host before this one wrote
       * it as it stopped, and each listed session this start finds mid-turn with no process is continued once
       * (`continueCutTurns`). This host writes it in turn when a linked hub stops it for an update (`stopForUpdate`)
       */
      updateResume?: UpdateResumeFolder
      /**
       * When the last host was told the system was ending, as it wrote it (lifecycle/system-end.ts, #1397): a session
       * in a turn the host lost, or ended by `adapter_crashed` about then, stopped because of that, and says so
       */
      systemEnd?: SystemEnd | null
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
    this.usageRecorder = new UsageRecorder(store.usage, { accountOf: async (tool) => (await this.toolRegistry.accountFor(tool)).fingerprint ?? '' })
    this.startUsageHistory()
    this.handoffNotes = new HandoffNotes(this.parts())
    this.tools = new SessionTools(this.parts())
    this.apps = new SessionAppWiring(this.parts())
    this.prefs = new UiPreferenceStore(this.parts())
    this.consents = new ProjectConsents(this.parts())
    this.updatesAsked = new UpdatesAsked(this.parts())
    this.projectCreation = new ProjectCreation(this.parts())
    this.machineFlow = new MachineFlow(this.parts())
    this.preferencesFlow = new PreferencesFlow(this.parts())
    this.trashFlow = new TrashFlow(this.parts())
    this.trustFlow = new TrustFlow(this.parts())
    this.appUpkeepFlow = new AppUpkeepFlow(this.parts())
    this.merges = new MergeChecks(this.parts())
    this.launches = new LaunchRecords(this.parts())
    this.interruptions = new InterruptionWatch(this.parts())
    this.reports = new ChildReports(this.parts())
    this.handoffChildren = new HandoffChildren(this.parts())
    this.cards = new RoutedCards(this.parts())
    this.queue = new QueuedRequests(this.parts())
    this.cardRests = new CardRests(appSettingRests(store.settings))
    this.modelWindows = new ModelWindows(store.settings)
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
    this.askedGate = new AskedGate({
      askedBy: (id) => this.mail.hooks?.askedBy?.(id) ?? null,
      // Allow or deny only, under every preset: `auto` does not answer a session's request for the person (§9.7)
      ask: async (id, question, signal) => {
        const answer = await this.hostCards.askHost(id, { kind: 'other', about: ORCHESTRATOR_CHANGE, raw: question }, signal, { alwaysAsk: true, uncovered: true })
        return answer === null ? null : answer === 'deny' ? 'deny' : 'allow'
      },
      cover: (id, run, signal) => this.hostCards.cover(id, run, signal),
      // Work handed on to a session no looser than the asking one, the one check about power (docs/plans/cited-requests.md §4); where it goes is the orchestrator's judgement
      noLooser: (asker, call) => {
        const me = this.meta.get(asker.sessionId)
        if (!me) return false
        const seatId = this.orchestratorId()
        const seat = (seatId === null ? undefined : this.meta.get(seatId))?.permissionPreset ?? 'safe'
        // A session of this host by id or mail address; one on a linked machine is not known here, so its preset is not either
        const of = (v: unknown): PermissionPreset | undefined => {
          if (typeof v !== 'string') return undefined
          const party = parseAddress(v.trim())
          return this.meta.get(party?.kind === 'session' ? party.sessionId : v.trim())?.permissionPreset
        }
        const preset =
          // What `createdPreset` gives in this asked turn (one this host does not hold, on a linked machine, is taken as trusted: the higher default)
          call.name === 'create_session' ? (createdPreset(seat, { trusted: this.createdInTrusted(call.args.project) }, PresetSchema.safeParse(call.args.preset).data, me.permissionPreset) ?? undefined)
          : call.name === 'start_agent' ? seat // its child runs under the caller's preset (start-agent-flow.ts)
          : call.name === 'handoff_session' ? (call.args.sessionId === undefined ? seat : of(call.args.sessionId)) // the new session keeps the old one's
          : call.name === 'ask_project' ? of(call.args.session)
          : call.name === 'mail' ? of(call.args.to)
          : of(call.args.sessionId)
        return preset !== undefined && presetWithin(preset, me.permissionPreset)
      },
      done: (asker, act) => {
        const cites = asker.cites
        const cited = cites ? this.store.messages.loadMessagesFrom(asker.sessionId, cites.seq - 1, 1).find((r) => r.seq === cites.seq) : undefined
        const words = cited && typeof cited.payload === 'object' && cited.payload !== null && 'text' in cited.payload ? String(cited.payload.text) : ''
        const why = cites
          ? `On your message from ${Math.max(1, Math.round((Date.now() - cites.at) / 60_000))} min ago (${JSON.stringify(oneLineText(words, 60))}), the orchestrator did this for this session's request`
          : "For this session's request, which cites no message of yours, the orchestrator did this"
        this.events.onEvent({ type: 'notice', sessionId: asker.sessionId, level: 'info', from: 'Centralu', label: 'request record', text: `${why}: ${oneLineText(act, 300)}` })
      },
    })
    this.linkedReports = new LinkedReports(this.parts())
    this.starts = new SessionStarts(this.parts())
    this.events = new SessionEvents(this.parts())
    this.mail = new MailSessionsView(this.parts())
    this.inputs = new TurnInputs(this.parts())
    this.processes = new SessionProcesses(this.parts())
    this.overloadRetry = new OverloadRetry({
      meta: this.meta,
      leaving: () => this.handingOver || this.disposing,
      compactTurn: (id) => this.selfCompaction.compactTurn(id),
      running: (id) => this.handles.has(id),
      note: (e) => this.events.onEvent(e),
      // Through Centralu's channel, as an update's continue: sent only while the retry still stands (a Stop or a message of the person's takes it away, even while a restart is waited out)
      send: (id, text, gate) =>
        this.events
          .deliverMail(id, { text, quiet: false, line: '', label: 'retry', skipLine: () => true }, {
            leaving: () => this.handingOver || this.disposing,
            // The last check before the tool is given the note (deliverMail asks it once, right before): passed, the turn is the tool's
            atRest: () => {
              const stands = gate.live() && inTurn(this.meta.get(id)?.state ?? 'idle')
              if (stands) gate.handed()
              return stands
            },
          })
          // Stopped or taken over while it waited: nothing was sent, and nothing failed
          .catch((err: unknown) => {
            if (!(err instanceof MailNotAtRest)) throw err
          }),
    })
    const compactSetting = () => autoCompactOf(this.prefs.uiPreferences())
    const compactNotice = (id: string, text: string) => this.events.onEvent({ type: 'notice', sessionId: id, level: 'info', from: 'Centralu', label: 'compaction', text })
    this.selfCompaction = new SelfCompaction({
      sessions: () => this.listSessions(),
      session: (id) => this.meta.get(id),
      idle: (id) => this.processes.sessionIdle(id),
      running: (id) => this.handles.has(id),
      ready: (id) => this.mail.mailReceiver(id).kind === 'ready',
      window: (m) => this.modelWindows.of(m),
      setting: compactSetting,
      command: (id, tool, focus) => {
        const handle = this.handles.get(id)
        if (handle?.compactCommand) return handle.compactCommand(focus)
        return this.adapters.get(tool)?.compactCommand?.(focus) ?? '/compact'
      },
      send: (id, text) => this.events.sendCompact(id, text),
      // An ordinary turn of the session's own, in Centralu's channel with no user row; a session with no process is woken for it
      sendThen: (id, text, line) =>
        this.events.deliverMail(id, { text, quiet: false, line, label: 'compaction' }, { leaving: () => this.handingOver || this.disposing, atRest: () => this.mail.mailReceiver(id).kind === 'ready' }),
      // What waits to start a turn behind the compact turn: what the tool holds (a tool that cannot say answers null) and mail waiting for the session
      queued: (id) => {
        const held = this.handles.get(id)?.queuedInputs?.()
        const mail = this.mail.hooks?.waiting?.(id) ?? false
        return mail || (held === undefined ? null : held > 0)
      },
      keep: settingThenKeep(this.store.settings),
      warnCycles: (id, count) => this.mail.hooks?.compactCycles?.(id, count),
      nudge: (id, text) => this.handles.get(id)?.nudge?.(text) ?? false,
      notice: compactNotice,
    })
    this.contextNudges = new ContextNudges({
      session: (id) => this.meta.get(id),
      window: (m) => this.modelWindows.of(m),
      setting: compactSetting,
      // The two seats that have the tool (tool-seats.ts): an ordinary session and the orchestrator
      hasCompactTool: (id) => this.mail.canReadMail(id),
      nudge: (id, text) => this.handles.get(id)?.nudge?.(text) ?? false,
      notice: compactNotice,
    })
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
     * Which states those are is the one definition a stop lists the turns it ends by (`turnCut`, idle.ts, #1618): what a
     * stop cut and what this start finds cut are the same sessions.
     */
    /** Sessions this start found mid-turn with no process (#698): whoever gave them the turn is told once */
    const stoppedByQuit: SessionInfo[] = []
    const cutTurns = new Map<string, TurnStarter>()
    /** Sessions whose turn a hub's update cut, continued once the start is done (#1618, `continueCutTurns`) */
    const cutByUpdate: SessionInfo[] = []
    /** What an update's stop ended in each session besides its turn (#1902), by session: told once the start is done (`continueCutTurns`) */
    const stoppedBy = new Map<string, Stopped>()
    const lists = keeperOpts.updateResume ? new UpdateResumeLists(keeperOpts.updateResume) : null
    this.updateLists = lists
    for (const s of store.sessions.listSessions()) {
      /*
       * Except where the process **does** still exist (#280 step 2): the keeper kept it through the
       * restart and `adoptKept` re-attaches it. That state is true; if the adoption fails, it is reset
       * there.
       */
      const cut = turnCut(s) && !keeperOpts.keptSessions?.has(s.id)
      /*
       * And where a linked hub's update cut the turn (#1618): the turn goes on, in a new process, as a kept session's
       * does in its old one. It stays `working` until it is continued, so a hub reading this machine meanwhile sees a
       * turn running, not one that ended; the report it owes stays owed. If it cannot be continued, it is reset there
       * (`turnLostInSwap`), as a kept process that could not be re-attached is. Only the turn the stop listed: its
       * conversation still ends where it ended when that stop was done (`UpdateResumeLists.cut`), so a list left behind
       * names no later turn, such as one a stop of the person's cut after a rollback to a host that never reads lists. It
       * holds because every listed session leaves this start with a row past the mark: the Continue's line, or the stopped
       * mark below (`turnLostInSwap` for one that cannot be continued)
       */
      const goesOn = cut && !!lists?.cut(s.id, s.lastSeq)
      const stale = cut && !goesOn
      /*
       * Where the last host recorded the system ending (#1397): a turn it lost is the system's, unless the session has rows from
       * after that end (a later host's, of a build that reads no record). And a session in `error` by an `adapter_crashed` about
       * then: its agent got the system's termination too (exit 0) and the host wrote the error before it went. It is no crash,
       * so it is reset and marked as a lost turn is
       */
      const end = keeperOpts.systemEnd
      const recent = end && (stale || s.state === 'error') ? store.messages.loadMessages(s.id, 20) : []
      const crashedAtEnd = !cut && crashedInSystemEnd(s, recent, end)
      const lost = stale || crashedAtEnd
      const bySystem = crashedAtEnd || (stale && cutBySystemEnd(end, recent.at(-1)?.ts))
      const fixed = lost ? { ...s, state: 'idle' as const, waitingSince: null } : goesOn ? { ...s, state: 'working' as const, waitingSince: null } : s
      // Started from a linked computer (#1273): kept beside the row, as its depth is
      this.meta.set(s.id, withHubMark(store.settings, fixed))
      if (lost) {
        console.error(`[agent-host] stale state reset: ${s.id.slice(0, 8)} ${s.state} -> idle${bySystem ? ' (the system was ending)' : ''}`)
        // No window is attached yet: the marker and the interruption are read with the conversation and the list
        this.interruptions.markTurnLost(fixed, false, bySystem ? 'shutdown' : 'quit')
        store.sessions.upsertSession(fixed)
        // The turn the last host was in never sent its end and no process holds what it was given (#1604); whose it was says who is told (#1946)
        cutTurns.set(s.id, this.children.processGone(s.id))
        stoppedByQuit.push(fixed)
      }
      const stopped = lost ? null : lists?.stoppedOf(s.id, s.lastSeq) ?? null
      if (stopped) stoppedBy.set(s.id, stopped)
      if (goesOn) {
        console.error(`[agent-host] ${s.id.slice(0, 8)}: an update of this machine ended its turn; continuing it`)
        store.sessions.upsertSession(fixed)
        cutByUpdate.push(fixed)
        // Until its Continue is in: a wake meanwhile (a window that sees the machine back) keeps it in its turn (`SessionStarts`)
        this.restartPolicy.continuingTurns.add(s.id)
        this.continuedAfterUpdate.push({ sessionId: s.id, at: Date.now() })
      }
    }
    // A listed session this start does not find cut by that stop (at rest, gone, or in a later turn) has nothing to continue
    for (const id of lists?.ids() ?? []) if (!cutByUpdate.some((s) => s.id === id) && !stoppedBy.has(id)) this.updateLists?.done(id)
    /** What the start takes over as going on: the keeper's processes, and the turns an update cut (#1618) */
    const goingOn = new Set([...(keeperOpts.keptSessions ?? []), ...cutByUpdate.map((s) => s.id)])
    /*
     * Who to tell of a turn a quit cut (#698): the session owed its report, else the one that gave the running turn
     * (an ask_project or a send), else the one that started it; the first of them that still exists. Read before the
     * loops below clear those rows. An asker that delegated without waiting was at rest, not cut, and would otherwise
     * never hear: its mark used to be dropped.
     *
     * A requester the same quit cut is skipped when the notice is given (`tellAskerOfInterruption`, its `quit`).
     */
    this.quitPersonWork = stoppedByQuit.map((s) => s.id)
    const marks = new Map(store.children.listReportMarks().map((r) => [r.sessionId, r.callerSessionId]))
    const turnGivers = new Map(store.children.listDelegatedTurns().map((r) => [r.sessionId, r.callerSessionId]))
    const requesterOf = (s: SessionInfo) => [marks.get(s.id), turnGivers.get(s.id), s.askedBy].find((id): id is string => !!id && id !== s.id && this.meta.has(id))
    for (const s of stoppedByQuit) {
      const requester = requesterOf(s)
      // A report owed is told of the stop whoever's turn it was: this start drops the mark (`restoreReports`), so it would never hear otherwise
      if (requester) {
        this.quitNotices.push({ sessionId: s.id, requester, turn: marks.has(s.id) ? undefined : cutTurns.get(s.id) })
        this.quitRequesters.set(s.id, { requester })
      }
    }
    // And a session at rest whose background tasks the stop ended is woken for the note alone (#1902)
    const cutIds = new Set(cutByUpdate.map((s) => s.id))
    this.updateCuts = [
      ...cutByUpdate.map((s) => ({ sessionId: s.id, turn: true, stopped: stoppedBy.get(s.id) ?? null })),
      ...[...stoppedBy].filter(([id]) => !cutIds.has(id)).map(([id, stopped]) => ({ sessionId: id, turn: false, stopped })),
    ]
    // A card the previous host left standing over a kept process closes back into its rest here too (#428)
    this.cardRests.restore((id) => !!keeperOpts.keptSessions?.has(id) && this.meta.get(id)?.state === 'waiting_approval')
    // A turn that ended while the old host let go is told as such (#1186), once the start is done, as a quit's is
    for (const m of this.children.restoreReports(this.meta, goingOn)) this.quitNotices.push({ sessionId: m.sessionId, requester: m.callerSessionId, swapped: true })
    // Whose the turn of each kept session still in one is, owed a report or not (#1946)
    for (const id of keeperOpts.keptSessions ?? []) if (inTurn(this.meta.get(id)?.state ?? 'idle') && !this.children.awaitingReport.has(id)) this.children.adoptStarter(id)
    this.delegationFlow.starts.restoreAgentStarts()
    // The reports owed of children on linked machines (#1038): each settles once its machine says where it stands
    this.delegationFlow.remote.restore()
    this.children.restoreTurns(this.meta, goingOn)
    this.keptAtStart = goingOn
    this.children.restoreQueued(this.meta, (r) => r.via === 'ask_project' && !this.queue.pairConsented(r.callerSessionId, this.meta.get(r.sessionId)!))
    if (this.children.queued.size) {
      setTimeout(() => {
        for (const id of this.children.queued.keys()) if (!goingOn.has(id)) this.queue.scheduleDrain(id)
      }, 0)
    }
    /*
     * A requester the keeper kept is told once it is adopted (`adoptKept`), and one whose turn an update cut once it is
     * continued (`continueCutTurns`), so the note does not start a second process
     */
    if (this.quitNotices.length || this.quitPersonWork.length) setTimeout(() => this.tellQuitNotices((id) => !goingOn.has(id)), 0)
    if (this.updateCuts.length) setTimeout(() => void this.continueCutTurns(), 0)
    /*
     * Sweeps orphaned handoff notes (#106). **Why startup is a safe moment for this**: no handoff is
     * in progress right now — a note being read mid-flight cannot be cleaned up out from under
     * someone. A failure here is no reason to block session restore, so it is not awaited.
     */
    void this.handoffNotes.sweepOrphanHandoffNotes().catch(() => {})
    // Recovery folders a purge moved aside and never finished with (#647): back for an entry still in the session archive, gone otherwise
    // Not awaited here; a purge or restore waits for it, so neither reads the folder while it is still aside
    this.recoveryRepair = repairWorktreeRecoveryRemovals((id) => store.trash.isTrashed(id)).catch((e) => console.error(`[archive] recovery folders left by an interrupted purge were not repaired: ${(e as Error).message}`))
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

  /** The linked machines as `machines.list` answers (#1220), for the orchestrator's list_machines; none until wired */
  private machineList: () => MachineInfo[] = () => []

  useMachineList(list: () => MachineInfo[]): void {
    this.machineList = list
  }

  /** The hub's links, for the orchestrator's machine commands (#1219); main.ts wires them */
  useMachineOps(ops: MachineOps): void {
    this.machineFlow.useOps(ops)
  }

  /** The window's RPC as the router answers it, for the orchestrator's settings commands (#1219); main.ts wires it */
  useWindowRpc(rpc: WindowRpc): void {
    this.preferencesFlow.useRpc(rpc)
    this.trashFlow.useRpc(rpc)
    this.trashFlow.useSessions({ lossesOf: (id) => this.trash.lossesOf(id), deleteIfQuiet: (id, also) => this.trash.trashIfQuiet(id, also) })
    this.trustFlow.useRpc(rpc)
    this.appUpkeepFlow.useRpc(rpc)
    this.housekeepingFlow.useRpc(rpc)
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
   * would leave nowhere to ask what to discard. Conversely, if the session archive step fails, this ends
   * having deleted nothing.
   *
   * Sessions go straight through `trashSession` — **its sessions go to the session archive (#204), not with the
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
    for (const s of leavesFirst) await this.trash.trashSession(s.id).catch(() => {})
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

  listSessions(): SessionInfo[] {
    return [...this.meta.values()].map((s) => {
      const live = this.handles.has(s.id)
      // The CLI version belongs to the process (#297): without one there is no version to compare
      return { ...s, live, agentVersion: live ? (s.agentVersion ?? null) : null }
    })
  }

  /** The sessions this host took over mid-run: the keeper's, and the turns an update cut and this host continues */
  private keptAtStart: ReadonlySet<string> = new Set()

  /**
   * Whether the session's turn goes on from the host before: kept by the keeper, or cut by an update and continued (#1618). Its mail turn row is not
   * lost, so what the turn sends keeps that turn's cause and depth (mailbox §8.2 step 6)
   */
  keptInTurn(sessionId: string): boolean {
    const m = this.meta.get(sessionId)
    return this.keptAtStart.has(sessionId) && !!m && inTurn(m.state)
  }

  /**
   * The session the older report path tells of the quit that cut `sessionId`'s turn, found at this start: `told` once that path told it, `held` while
   * it has not ended (a requester the keeper kept or an update cut is told later, `tellQuitNotices`). Neither when it ended without telling it (one
   * cut by the same quit waits for the person's Continue, `tellAskerOfInterruption`), so the stop notice tells it
   */
  quitTold(sessionId: string): { told: string[]; held: string[] } {
    const q = this.quitRequesters.get(sessionId)
    if (!q) return { told: [], held: [] }
    q.read = true
    return q.told === undefined ? { told: [], held: [q.requester] } : { told: q.told ? [q.requester] : [], held: [] }
  }

  /** The older report path told, or did not tell, a quit's requester (`tellQuitNotices`): the stop notice that held it hears it */
  private quitTellEnded(sessionId: string, told: string | undefined): void {
    const q = this.quitRequesters.get(sessionId)
    if (!q) return
    q.told = told === q.requester
    if (q.read) this.mail.mailOldPathEnded(sessionId, q.requester, q.told)
  }

  stopSelfCompaction(): void {
    this.selfCompaction.stop()
    this.contextNudges.stop()
  }

  /** Starts compacting the sessions at rest over the lower share (#1451); the shutdown plan stops it before the sessions are let go of */
  startSelfCompaction(): void {
    this.selfCompaction.start()
    // What the last host left of a `compact_self` (#2024); a process the keeper kept is looked at once it is adopted (`adoptKept`)
    this.selfCompaction.recover((id) => !this.keeperOpts.keptSessions?.has(id))
  }


  /** A session that is here (not in the trash), as the mailbox's relations read it (#1347); undefined for one that is gone */
  sessionInfo(id: string): SessionInfo | undefined {
    return this.meta.get(id)
  }

  /** Active sessions running in the same directory (the basis for FR-2's concurrent-session warning) */
  activeSessionsIn(projectId: string): SessionInfo[] {
    return this.listSessions().filter((s) => s.projectId === projectId)
  }

  /** `SessionStarts.createSession` (session-start.ts), kept on the manager for its callers */
  createSession(...a: Parameters<SessionStarts['createSession']>): ReturnType<SessionStarts['createSession']> {
    return this.starts.createSession(...a)
  }

  /**
   * The turn a kept process was running is over after a swap (#698): the session goes idle with the quit mark and its line,
   * and the report it owed goes now, rather than naming a later turn
   */
  private turnLostInSwap(m: SessionInfo): void {
    // The same statement the window gets, through the same rules (#428)
    const change = { type: 'state_change' as const, sessionId: m.id, state: 'idle' as const, reason: 'reattach_failed' }
    this.events.applyStateHint(change, m)
    this.interruptions.markTurnLost(m, true)
    this.store.sessions.upsertSession(m)
    this.emit(change)
    // The turn is over: so is a hub task's depth for it, as at any end of a turn (#2020)
    this.events.endHubAsk(m.id)
    // Its turn is over: the report it owed says so now, rather than naming a later turn (#698)
    // Whose the turn was (#1377): the person's is reported to nobody
    // The process is gone with it (#1604): what it was given is run by no one
    const turnBy = this.children.turnEnded(m.id, null, true)
    // Centralu cut this turn and could not continue it: the senders of the questions it left unanswered are told (§4.1). The notice to a session the older
    // path below may tell of the same stop (the owner of the report, the session that gave the turn or started it) waits for that path to end
    const held = [this.children.awaitingReport.get(m.id), this.children.turnOwners.get(m.id)?.callerId ?? m.askedBy ?? undefined].flatMap((id) => (id && id !== m.id ? [id] : []))
    this.mail.mailStopped(m.id, 'uncontinued', { held })
    const sends: Promise<string | undefined>[] = []
    if (this.children.awaitingReport.has(m.id)) sends.push(this.reports.reportBackIfAwaited(m.id, { type: 'state_change', sessionId: m.id, state: 'idle' }, undefined, undefined, turnBy))
    else {
      sends.push(this.reports.tellAskerOfInterruption(m.id, this.children.turnOwners.get(m.id)?.callerId, turnBy))
      // The work the person owns: the same end, in their Inbox (§8.1)
      void this.reports.reportToPersonIfOwed(m.id, { type: 'state_change', sessionId: m.id, state: 'idle' }, undefined, turnBy)
    }
    this.mail.mailStopTold(m.id, held, sends)
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
        const r = await this.processes.resumeSession(k.sessionId, k.process).catch((err: Error) => ({ resumed: false, reason: err.message }))
        // Any start that did not take the process (no adapter, no resume, a project gone, a failed re-attach) left it with
        // nobody to address it: stopped here, once, whatever the refusal (#1720). A host that is leaving hands it on instead
        let gone: Promise<void> = Promise.resolve()
        if (!r.resumed && !this.lettingGo()) gone = this.endKept(k.process)
        const adopted = r.resumed ? this.handles.get(k.sessionId) : undefined
        // Reopened in a new process rather than taken over (ACP, #1562 review): the turn it ran is over, as if not re-attached. Centralu cut it, so it continues it (#1966)
        if (adopted?.takesOverTurn === false && inTurn(m.state)) await this.continueLostTurn(m)
        /*
         * The tool says its conversation is idle while the record says a turn runs (#2020): that turn ended while no host ran and its
         * end was not stored (a crash during a capacity retry's wait, which the host that held the error took with it). Nothing will say
         * it ended, and the retry was in that host's memory: the turn is over, as one a swap could not continue is, and a message goes on.
         * Not when this host holds a retry of its own: the error reached it as a frame the keeper buffered, and the wait is its.
         * Asked after the conversation opened and the buffered frames were handled, and the state read again then
         */
        else if (adopted?.adoptedIdle && inTurn(m.state) && (await raceTimeout(adopted.adoptedIdle(), ADOPTED_IDLE_WAIT_MS, false)) && inTurn(m.state) && !this.lettingGo() && !this.overloadRetry.stands(k.sessionId)) this.turnLostInSwap(m)
        // Its `compact_self` the old host left: the step goes in if the compaction was done, else the agent is told (#2024)
        this.selfCompaction.recover((id) => id === k.sessionId)
        // A request queued for it under the old host goes in now if its turn ended during the swap (#677)
        if (this.children.queued.has(k.sessionId)) this.queue.scheduleDrain(k.sessionId)
        if (!r.resumed) {
          console.error(`[agent-host] could not re-attach ${k.sessionId.slice(0, 8)}: ${r.reason ?? 'unknown'}`)
          if (inTurn(m.state)) {
            // The old CLI may still be writing its transcript: the conversation is resumed once it has exited (#1966 review)
            await gone
            await this.continueLostTurn(m)
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

  /**
   * Continues each turn a linked hub's update cut (#1618, owner 2026-10-26): the update no longer waits for the turns on a
   * machine, so the host it starts takes them up again, once. The session was left `working` by the start; it is woken
   * and given Centralu's note through Centralu's own channel (`deliverMail`: no message of the person's, so the turn stays
   * whose it was and its report, if one is owed, is still that turn's end). Its requester is told nothing of the cut: the
   * report of the continued turn's end says so (#1966). A session that cannot be continued (its tool cannot resume it, it is gone there) ends
   * as a kept process that could not be re-attached does (`turnLostInSwap`): idle, marked stopped, its report or its
   * requester told. Each is taken once: the list is emptied first, and its id leaves the file once its Continue was sent
   * or its loss reported (`UpdateResumeLists.done`), not before, so a host stopped in between leaves it for the next.
   *
   * The note also says what else the stop ended in the session: its background tasks and the cards that waited for the person
   * (`updateNote`, #1902). A session at rest whose tasks it stopped is woken for the note alone: that is a continue of the
   * update, not a turn a message or mail started (docs/plans/mailbox.md §8.2), so it goes in through `deliverMail` and not the
   * mailbox's delivery, and a session the person woke first takes it into the turn they started.
   */
  private async continueCutTurns(): Promise<void> {
    const cuts = this.updateCuts
    this.updateCuts = []
    await Promise.all(
      cuts.map(async ({ sessionId, turn, stopped }) => {
        const m = this.meta.get(sessionId)
        // Leaving before it went in: still listed, for the host that starts next
        if (this.disposing || this.handingOver) return
        if (!m || (turn && !inTurn(m.state))) {
          // Gone, or stopped by the person before its Continue went in: nothing to continue
          this.restartPolicy.continuingTurns.delete(sessionId)
          this.notContinued(sessionId)
          this.updateLists?.done(sessionId)
          return
        }
        // Marked before it goes in: a turn that ends at once (a tool that refuses) is still the continued one's end
        if (turn) this.children.noteContinuedCut(sessionId)
        try {
          await this.sendUpdateNote(sessionId, turn, stopped)
        } catch (e) {
          this.children.dropContinuedCut(sessionId)
          if (this.disposing || this.handingOver || this.meta.get(sessionId) !== m) return
          this.restartPolicy.continuingTurns.delete(sessionId)
          if (!turn) {
            // Nothing was cut: the agent is not told which tasks the update stopped, and the log says so
            console.error(`[agent-host] ${sessionId.slice(0, 8)}: the agent could not be told what an update stopped (${errorMessage(e)})`)
            this.updateLists?.done(sessionId)
            return
          }
          console.error(`[agent-host] ${sessionId.slice(0, 8)}: the turn an update ended could not be continued (${errorMessage(e)})`)
          this.turnLostInSwap(m)
          this.notContinued(sessionId)
          this.updateLists?.done(sessionId)
          return
        }
        /*
         * In, but this host is leaving meanwhile (a second update's stop, #1626 review): its stop lists the turn again, the
         * note included, and the host after it continues it. Nothing is settled from here
         */
        if (this.disposing || this.handingOver) return
        this.restartPolicy.continuingTurns.delete(sessionId)
        // Sent: a host that starts after this one does not send it again
        this.updateLists?.done(sessionId)
        // Its parent is told nothing now: the report of the continued turn's end says the turn was cut and continued (#1966)
      }),
    )
    this.tellQuitNotices(() => true)
  }

  /**
   * Centralu's note to the agent after an update or a swap stopped it (#1618, #1966): the Continue of a cut turn, or the tasks the stop ended
   * for a session at rest. The one door of the update's continue and of the swap's (`adoptKept`). Not sent once this host is leaving (a second
   * update's stop while the session wakes): the host after it sends the one
   */
  private sendUpdateNote(sessionId: string, turn: boolean, stopped: Stopped | null): Promise<void> {
    return this.events.deliverMail(
      sessionId,
      { text: updateNote(turn, stopped), quiet: false, line: turn ? UPDATE_CONTINUE_LINE : UPDATE_TASKS_LINE, label: 'update', skipLine: () => this.disposing && this.stoppingForUpdate },
      { leaving: () => this.handingOver || this.disposing, atRest: () => true },
    )
  }

  /**
   * A turn a host swap cut that its tool cannot take up again (ACP reopens the conversation in a new process; a process that could not be
   * re-attached): continued like one an update cut, with the same Continue (#1966). Only a turn Centralu itself cut. One that cannot be
   * continued ends as it did: stopped, its report or its requester told (`turnLostInSwap`)
   */
  private async continueLostTurn(m: SessionInfo): Promise<void> {
    // A new process keeps the turn's state as it comes up, as an update's continue does: a reader never sees the turn at rest in between
    this.restartPolicy.continuingTurns.add(m.id)
    this.children.noteContinuedCut(m.id)
    try {
      await this.sendUpdateNote(m.id, true, null)
    } catch (e) {
      this.children.dropContinuedCut(m.id)
      if (this.disposing || this.handingOver || this.meta.get(m.id) !== m) return
      console.error(`[agent-host] ${m.id.slice(0, 8)}: the turn a swap ended could not be continued (${errorMessage(e)})`)
      this.turnLostInSwap(m)
    } finally {
      this.restartPolicy.continuingTurns.delete(m.id)
    }
  }

  /** Stops a kept process nobody can address; resolves when it has exited, or after a bound (then it is killed) */
  private endKept(p: AgentProcess): Promise<void> {
    if (p.exitCode !== null || p.signalCode) return Promise.resolve()
    const exited = new Promise<boolean>((r) => p.once('exit', () => r(true)))
    p.kill('SIGTERM')
    return raceTimeout(exited, this.keeperOpts.exitWaitMs ?? 5_000, false).then((done) => {
      if (!done) p.kill('SIGKILL')
    })
  }

  /** A turn the start took up that is not continued after all: the hello stops naming it (#1618) */
  private notContinued(sessionId: string): void {
    this.continuedAfterUpdate = this.continuedAfterUpdate.filter((c) => c.sessionId !== sessionId)
  }

  /**
   * A linked hub stops this host to update it, roll it back or put a version back (`host.stop { forUpdate }`, #1618): as the
   * sessions are let go of (`disposeAll`), the ones in a turn are listed for the host that starts next, which continues them
   */
  stopForUpdate(): void {
    this.stoppingForUpdate = true
  }

  /** The terminals and Run commands an update's stop left in the lists, once (#1902): the lists that held them go */
  takeUpdateEnded(): Ended {
    return this.updateLists?.takeEnded() ?? { terminals: [], runs: [] }
  }

  /** The turns this host continues after an update cut them (#1618), for the hello a linked hub reads */
  updateContinued(): { sessionId: string; at: number }[] {
    return [...this.continuedAfterUpdate]
  }


  /** Tells each requester of a turn a quit cut, once (#698); `ready` holds back one the keeper still has to hand over */
  private tellQuitNotices(ready: (requester: string) => boolean): void {
    // A host stopping before its first moment tells nobody; the next start does not repeat it either (the reset is done)
    if (this.disposing || this.handingOver) return
    // The work the person owns (a script started the session, §8.1): the turn a quit cut is reported to their Inbox as it ended
    const person = this.quitPersonWork
    this.quitPersonWork = []
    for (const id of person) if (this.meta.has(id)) void this.reports.reportToPersonIfOwed(id, { type: 'state_change', sessionId: id, state: 'idle' })
    const now = this.quitNotices.filter((n) => ready(n.requester))
    this.quitNotices = this.quitNotices.filter((n) => !ready(n.requester))
    for (const n of now) {
      if (n.swapped) void this.reports.tellTurnEndedInSwap(n.sessionId, n.requester)
      else void this.reports.tellAskerOfInterruption(n.sessionId, n.requester, n.turn).then((told) => this.quitTellEnded(n.sessionId, told), () => this.quitTellEnded(n.sessionId, undefined))
    }
  }

  /** The startup repair of recovery folders an interrupted purge left aside (#647) */
  private recoveryRepair: Promise<void> = Promise.resolve()

  /** `SessionSettings.updateSettings` (session-settings.ts), kept on the manager for its callers */
  updateSettings(...a: Parameters<SessionSettings['updateSettings']>): ReturnType<SessionSettings['updateSettings']> {
    return this.sessionSettings.updateSettings(...a)
  }

  /** Whether a session is one of this host's, without copying the list (#1405: asked at every hello with a session credential) */
  hasSession(sessionId: string): boolean {
    return this.meta.has(sessionId)
  }

  /** A session's name, or null when it has none or is not this host's (#1405: named on a host request) */
  sessionName(sessionId: string): string | null {
    return this.meta.get(sessionId)?.name ?? null
  }

  /** Whether a session's process is alive (what the UI uses to know if it can be continued) */
  isLive(sessionId: string): boolean {
    return this.handles.has(sessionId)
  }

  /** The rest an adapter's card raised between turns was raised in (`CardRests`, card-rest.ts), written to the store */
  private cardRests: CardRests

  /**
   * Whether a project create_session names is trusted here, matched as create_session matches it (`matchProjects`: id,
   * then name, then any case); one this host does not hold, or a name two projects share, reads as trusted, the looser
   * default (#1739's gate)
   */
  private createdInTrusted(project: unknown): boolean {
    const all = this.store.projects.listProjects()
    const found = matchProjects(typeof project === 'string' ? project : '', all.map((p) => ({ id: p.id, name: p.name, machine: null, machineId: null })))
    const [only, second] = found
    return only && !second ? all.find((p) => p.id === only.id)?.trusted === true : true
  }

  /**
   * Usage over time (docs/agent-host.md §6.2): the figures an earlier run of this host stored come back into the
   * cache ledger, and the recorder starts writing this run's. A store that cannot be read costs the history only.
   */
  private startUsageHistory(): void {
    try {
      this.store.usage.sweepOrphans()
      const now = Date.now()
      this.cacheLedger.restore(this.store.usage.buckets(Math.floor((now - 24 * 3_600_000) / 3_600_000) * 3_600_000, now + 3_600_000))
    } catch (err) {
      console.error(`[usage] could not restore the cache figures: ${errorMessage(err)}`)
    }
    this.usageRecorder.start(
      () => [...new Set([...this.handles.keys()].map((id) => this.meta.get(id)?.tool).filter((t): t is ToolName => t !== undefined))],
      (tool) => this.toolQueries.usageFor(tool),
    )
  }

  /** `usage.history` (docs/agent-host.md §6.2): what this host stored of the limit windows and of the tokens per hour */
  usageHistory(p: { from: string; to: string; groupBy: 'day' | 'hour'; by: UsageHistoryBy; tool?: ToolName }): UsageHistory {
    this.usageRecorder.flush() // what is still in memory counts too
    const projects = new Map(this.store.projects.listProjects().map((x) => [x.id, x.name]))
    return usageHistory(
      this.store.usage,
      { from: Date.parse(p.from), to: Date.parse(p.to), groupBy: p.groupBy, by: p.by, ...(p.tool ? { tool: p.tool } : {}) },
      { session: (id) => this.meta.get(id)?.name ?? this.store.trash.trashedSession(id)?.session.name, project: (id) => projects.get(id) },
    )
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

  /** Where a session's agent compacts the next time its process starts, as the launch decides it (`agents.autoCompact`, #1376) */
  autoCompactFor(sessionId: string): { controlled: boolean; share: number; tokens: number | null } {
    return autoCompactPlan(autoCompactOf(this.prefs.uiPreferences()), this.modelWindows, this.sessionOf(sessionId))
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
      mailTool: (id, args) => self.mail.hooks?.tool?.(id, args) ?? { text: 'The mailbox is not available.', isError: true },
      refusesDelegation: (callerId, target, call) => self.mail.hooks?.refusesDelegation?.(callerId, target, call) ?? null,
      roleMoved: (toId) => self.mail.hooks?.roleMoved?.(toId),
      whenAsked: (id, call, signal, run, refused) => self.askedGate.when(id, call, signal, run, refused),
      requestTurn: (id) => ({
        active: () => self.askedGate.active(id),
        ask: (tool, input, signal) => self.askedGate.askCli(id, tool, input, signal),
        done: (tool, input) => self.askedGate.cliDone(id, tool, input),
      }),
      compactSelf: (id, focus, then) => self.selfCompaction.request(id, focus, then),
      compactTurn: (id) => self.selfCompaction.compactTurn(id),
      compactEvent: (e, ended) => {
        try {
          self.selfCompaction.observe(e, ended)
        } catch (err) {
          console.error(`[compact] ${e.sessionId?.slice(0, 8) ?? '?'}: ${errorMessage(err)}`)
        }
        try {
          self.contextNudges.observe(e)
        } catch (err) {
          console.error(`[compact] ${e.sessionId?.slice(0, 8) ?? '?'}: ${errorMessage(err)}`)
        }
      },
      listAgents: (...a) => self.delegationFlow.listAgents(...a),
      get agentRuns() {
        return self.inputs.agentRuns
      },
      answerRoutedCard: (...a) => self.cards.answerRoutedCard(...a),
      answerQuestion: (...a) => self.inputs.answerQuestion(...a),
      applyDeferredRestart: (...a) => self.restartPolicy.applyDeferredRestart(...a),
      appProjectTarget: (...a) => self.projectCreation.appProjectTarget(...a),
      registerMadeFolder: (...a) => self.projectCreation.registerMadeFolder(...a),
      applyStateHint: (...a) => self.events.applyStateHint(...a),
      askGateError: (...a) => self.askProjectFlow.askGateError(...a),
      askProject: (...a) => self.askProject(...a),
      askHost: (...a) => self.hostCards.askHost(...a),
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
      get usageRecorder() {
        return self.usageRecorder
      },
      forgetUsage: (id) => {
        self.usageRecorder.forget(id)
        self.cacheLedger.forget(id)
      },
      usageFor: (...a) => self.toolQueries.usageFor(...a),
      get modelWindows() {
        return self.modelWindows
      },
      get approvalRules() {
        return self.approvalRules
      },
      get starts() {
        return self.starts
      },
      get inputs() {
        return self.inputs
      },
      refuseWhileLettingGo: () => self.refuseWhileLettingGo(),
      get cardRests() {
        return self.cardRests
      },
      get cards() {
        return self.cards
      },
      joinsRunningTurn: (sessionId) => {
        const tool = self.meta.get(sessionId)?.tool
        return tool !== undefined && self.adapters.get(tool)?.capabilities.midTurnInput === true
      },
      contextAtRequest: (sessionId) => {
        const tool = self.meta.get(sessionId)?.tool
        return tool !== undefined && self.adapters.get(tool)?.contextAtRequest === true
      },
      get children() {
        return self.children
      },
      checkMergedInBackground: (...a) => self.merges.checkMergedInBackground(...a),
      userAppFolders: () => {
        const rt = self.apps.appsHub?.rt
        return rt ? Object.keys(self.store.adoption.adopted()).map((appId) => rt.userAppDir(appId)) : []
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
      cwdOf: (...a) => self.projectRegistry.cwdOf(...a),
      defaultToolFor: (...a) => self.toolRegistry.defaultToolFor(...a),
      get delegationFlow() {
        return self.delegationFlow
      },
      deliver: (...a) => self.events.deliver(...a),
      deliverReport: (...a) => self.reports.deliverReport(...a),
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
      ensureProjectAccess: (...a) => self.consents.ensureProjectAccess(...a),
      exportHandoffNote: (...a) => self.handoffNotes.exportHandoffNote(...a),
      exportHandoffRecord: (...a) => self.handoffNotes.exportHandoffRecord(...a),
      get events() {
        return self.events
      },
      get externals() {
        return self.externals
      },
      firstTool: (...a) => self.toolRegistry.firstTool(...a),
      forgetCardRest: (id) => self.cardRests.forget(id),
      forgetHeldNotices: (id) => self.reports.forgetHeld(id),
      mailPoke: (id) => {
        try {
          self.mail.hooks?.sessionChanged(id)
        } catch (e) {
          console.error(`[mail] ${id.slice(0, 8)}: ${errorMessage(e)}`)
        }
      },
      mailStopped: (id, why, o) => self.mail.mailStopped(id, why, o),
      mailStopTold: (id, held, sends) => self.mail.mailStopTold(id, held, sends),
      mailEvent: (e, ended) => {
        try {
          self.mail.hooks?.sessionEvent?.(e, ended)
        } catch (err) {
          console.error(`[mail] ${e.sessionId?.slice(0, 8) ?? '?'}: ${errorMessage(err)}`)
        }
      },
      mailWork: (id) => {
        try {
          return self.mail.hooks?.openWork?.(id) ?? { unanswered: [], owed: [] }
        } catch (e) {
          console.error(`[mail] ${id.slice(0, 8)}: its open work could not be read (${errorMessage(e)})`)
          return null
        }
      },
      mailHandOver: (...a) => self.mail.hooks?.handOver?.(...a) ?? [],
      mailHandOverPreview: (from, to) => {
        try {
          return self.mail.hooks?.handOverPreview?.(from, to) ?? []
        } catch (e) {
          console.error(`[mail] ${from.slice(0, 8)}: what a handoff would move could not be read (${errorMessage(e)})`)
          return null
        }
      },
      mailGone: (id) => {
        try {
          self.mail.hooks?.sessionGone(id)
        } catch (e) {
          // The trash move has happened and is not undone by the mailbox: the delivery sweep moves the work on at its next run
          console.error(`[mail] ${id.slice(0, 8)}: the work it held could not be moved on (${errorMessage(e)}); the next sweep does it`)
        }
      },
      forgetCommits: (...a) => self.events.forgetCommits(...a),
      gitTrust: (...a) => self.projectRegistry.gitTrust(...a),
      grantReads: (...a) => self.delegationFlow.grantReads(...a),
      handedOverReply: (...a) => self.delegationFlow.handedOverReply(...a),
      handleSink: () => self.processes.handleSink(),
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
      inputsHeld: (...a) => self.inputs.inputsHeld(...a),
      get interruptions() {
        return self.interruptions
      },
      get overloadRetry() {
        return self.overloadRetry
      },
      get keeperOpts() {
        return self.keeperOpts
      },
      get launches() {
        return self.launches
      },
      get leaving() {
        return self.processes.leaving
      },
      get linkedReader() {
        return self.linkedReader
      },
      linkedTasksRunning: (...a) => self.linkedReports.ownTasksRunning(...a),
      listCommands: (...a) => self.toolQueries.listCommands(...a),
      listSessions: (...a) => self.listSessions(...a),
      loadMessages: (...a) => self.record.loadMessages(...a),
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
      onEvent: (e: NormalizedEvent, from?: SessionHandle | null) => self.events.onEvent(e, from),
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
      respondApproval: (...a) => self.inputs.respondApproval(...a),
      appNotice: (...a) => self.inputs.appNotice(...a),
      reportBackIfAwaited: (...a) => self.reports.reportBackIfAwaited(...a),
      get restartPolicy() {
        return self.restartPolicy
      },
      restartSession: (...a) => self.processes.restartSession(...a),
      resumeSession: (...a) => self.processes.resumeSession(...a),
      get resuming() {
        return self.processes.resuming
      },
      routedCards: (...a) => self.cards.routedCards(...a),
      rulesFor: (...a) => self.approvalRules.rulesFor(...a),
      get running() {
        return self.processes.running
      },
      scheduleDrain: (...a) => self.queue.scheduleDrain(...a),
      send: (...a) => self.inputs.send(...a),
      sessionsInside: (...a) => self.sessionsInside(...a),
      sessionOf: (...a) => self.sessionOf(...a),
      settingFilesFor: (...a) => self.launchInputs.settingFilesFor(...a),
      settleState: (...a) => self.events.settleState(...a),
      settleLinkedTurn: (sessionId) => self.linkedReports.observe({ type: 'turn_complete', sessionId }),
      // Whose a linked child's turn is decides whether its report goes (#1038 review)
      reportGate: (sessionId) => self.delegationFlow.remote.reportGate(sessionId),
      keepsOverLoss: (sessionId) => self.delegationFlow.remote.keepsOverLoss(sessionId),
      skillsPrompt: () => self.launchInputs.skillsPrompt(),
      sleepSession: (...a) => self.processes.sleepSession(...a),
      startAgent: (...a) => self.startAgent(...a),
      startDelegation: (...a) => self.delegationFlow.startDelegation(...a),
      stopBackgroundTask: (...a) => self.sessionSettings.stopBackgroundTask(...a),
      stopWatchingReconnect: (...a) => self.interruptions.stopWatchingReconnect(...a),
      get store() {
        return self.store
      },
      sweepOrphanHandoffNotes: (...a) => self.handoffNotes.sweepOrphanHandoffNotes(...a),
      tellSession: (...a) => self.reports.tellSession(...a),
      toolProfileOf: (...a) => self.tools.toolProfileOf(...a),
      canReadMail: (...a) => self.mail.canReadMail(...a),
      toolLabel: (...a) => self.toolRegistry.toolLabel(...a),
      get tools() {
        return self.tools
      },
      nameOf: (...a) => self.reports.nameOf(...a),
      toolProblem: (...a) => self.toolRegistry.toolProblem(...a),
      toolRefusal: (...a) => self.processes.toolRefusal(...a),
      refusal: (...a) => self.toolRegistry.refusal(...a),
      trashSession: (...a) => self.trash.trashSession(...a),
      purgeSession: (...a) => self.trash.purgeSession(...a),
      archiveBusy: (...a) => self.trash.archiveBusy(...a),
      trashIf: (...a) => self.trash.trashIf(...a),
      get trashing() {
        return self.trash.trashing
      },
      trunkOf: (...a) => self.projectRegistry.trunkOf(...a),
      turnRunning: (...a) => self.inputs.turnRunning(...a),
      get turnObservers() {
        return self.inputs.turnObservers
      },
      uiPreferences: (...a) => self.prefs.uiPreferences(...a),
      untilCard: (...a) => self.cards.untilCard(...a),
      updateCentraluAsked: (...a) => self.updatesAsked.updateCentraluAsked(...a),
      untilWakeWithdrawn: (...a) => self.processes.untilWakeWithdrawn(...a),
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
    // What `parts()` already says (its getters still run when read through the prototype) plus what only the tools need
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getter below reads this manager's field when used
    const self = this
    const own: Pick<OrchestratorSeatHost, 'linkedReader' | 'proposals'> & Omit<OrchestratorSeatHost, keyof ManagerParts> = {
      get proposals() {
        return self.orchestratorSlot.proposals
      },
      linkedReader: () => this.linkedReader,
      linkedReportRestored: (sessionId) => this.linkedReports.restored(sessionId),
      updateSettings: (sessionId, settings, by) => this.updateSettings(sessionId, settings, by),
      forkFor: (callerId, target, text, readOnly, via, signal) => this.delegationFlow.forkFor(callerId, target, text, readOnly, via, signal),
      createProjectAsked: (sessionId, spec, signal) => this.projectCreation.createProjectAsked(sessionId, spec, signal),
      askAppProject: (sessionId, spec, signal) => this.projectCreation.askAppProject(sessionId, spec, signal),
      createProjectOnMachine: (sessionId, reader, machine, spec, signal) => this.projectCreation.createProjectOnMachine(sessionId, reader, machine, spec, signal),
      addFolderAsked: (sessionId, path, signal) => this.projectCreation.addFolderAsked(sessionId, path, signal),
      addFolderOnMachine: (sessionId, reader, machine, path, signal) => this.projectCreation.addFolderOnMachine(sessionId, reader, machine, path, signal),
      machineList: () => this.machineList(),
      machineRequest: (sessionId, req, signal) => this.machineFlow.run(sessionId, req, signal),
      preferencesRequest: (sessionId, req, signal) => this.preferencesFlow.run(sessionId, req, signal),
      trashRequest: (sessionId, req, signal) => this.trashFlow.run(sessionId, req, signal),
      trustRequest: (sessionId, req, signal) => this.trustFlow.run(sessionId, req, signal),
      appUpkeepRequest: (sessionId, req, signal) => this.appUpkeepFlow.run(sessionId, req, signal),
      housekeepingRequest: (sessionId, req) => this.housekeepingFlow.run(sessionId, req),
      handoff: (callerId, target, opts, signal) => this.handoffFlow.handoff(callerId, target, opts, signal),
      handoffWait: (callerId, handle, signal) => this.handoffFlow.wait(callerId, handle, signal),
      usageHistory: (p) => this.usageHistory(p),
      checkApp: (ref) => this.appSessions.checkApp(ref),
      createApp: (params) => this.appSessions.createApp(params),
      askedBy: (orchestratorId) => this.mail.hooks?.askedBy?.(orchestratorId) ?? null,
    }
    // `own` stands on `parts()` (not copied from it: `Object.assign` would read the `proposals` getter once and keep the value)
    const parts: Omit<ManagerParts, 'linkedReader' | 'proposals'> = this.parts()
    Object.setPrototypeOf(own, parts)
    if (!stands(own, parts)) throw new Error('The orchestrator seat could not be set on the module parts')
    return (this.seatHost ??= own)
  }

  /** The central orchestrator's session id, or none while it has not been made (#1447: `mail send to "orchestrator"`) */
  orchestratorId(): string | null {
    return [...this.meta.values()].find((m) => m.kind === 'orchestrator')?.id ?? null
  }

  /** The tools given to an orchestrator (FR-11), built over this manager (`orchestrator-seat.ts`) */
  private orchestratorToolsFor(orchestratorId: string, scopeIds?: string[], ownProject?: boolean, hubView?: boolean): OrchestratorTools {
    return orchestratorToolsFor(this.seat(), orchestratorId, scopeIds, ownProject, hubView)
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

  /** `OrchestratorSlot.runOrchestratorTool` (orchestrator-slot.ts), kept on the manager for its callers */
  runOrchestratorTool(...a: Parameters<OrchestratorSlot['runOrchestratorTool']>): ReturnType<OrchestratorSlot['runOrchestratorTool']> {
    return this.orchestratorSlot.runOrchestratorTool(...a)
  }

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

  /** Whether Automatic updates are on and the host idle, for an agent's apply to go with no card (#1509, updates-asked.ts) — wired by the host */
  useUpdateAtRest(atRest: (besidesSessionId: string) => boolean): void {
    this.updatesAsked.updateAtRest = atRest
  }

  /**
   * PR status checker (#76, stage 3). Kept as a field because gh is a network call, and a test cannot
   * measure it — a test swaps this field out instead. prPollMs is also a field for the same reason (a test
   * sets it to 0).
   */
  prLookup: (projectCwd: string, branch: string, signal?: AbortSignal) => Promise<BranchPr | 'unavailable' | null> = gitBranchPr
  prPollMs = 120_000

  /** `OrchestratorSlot.orchestrator` (orchestrator-slot.ts), kept on the manager for its callers */
  orchestrator(...a: Parameters<OrchestratorSlot['orchestrator']>): ReturnType<OrchestratorSlot['orchestrator']> {
    return this.orchestratorSlot.orchestrator(...a)
  }

  /** `SessionSettings.rename` (session-settings.ts), kept on the manager for its callers */
  rename(...a: Parameters<SessionSettings['rename']>): ReturnType<SessionSettings['rename']> {
    return this.sessionSettings.rename(...a)
  }

  /**
   * Done on a session in error (#1549): the person has read why, and nothing is left to do about the mark. It goes to `idle`
   * (the table allows error → idle) through the statement a resume makes, so every window hears it and a new error marks the
   * session again. The error line stays in the conversation; nothing is stopped or sent. Its last answer is read, so a stopped
   * turn that waits unread in the inbox goes too.
   */
  clearError(sessionId: string, seq: number): { cleared: boolean; newer: boolean } {
    const m = this.meta.get(sessionId)
    if (!m) throw sessionNotFound(sessionId)
    // Only the error the person saw: a newer row (another error after a Continue, say) is theirs to read first
    const newer = m.state === 'error' && m.lastSeq > seq
    const cleared = m.state === 'error' && !newer
    if (cleared) this.events.settleState(m, { type: 'state_change', sessionId, state: 'idle', reason: 'error_cleared' })
    this.sessionSettings.markRead(sessionId, seq)
    return { cleared, newer }
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
    this.usageRecorder.stop()
    this.stopSelfCompaction()
    this.sweepingHandles = true
    try {
      await this.disposeEverything()
    } finally {
      this.sweepingHandles = false
    }
  }

  private async disposeEverything(): Promise<void> {
    // The cards it closes below are not the person's answers: a standing start_agent request stays stored (#673)
    // A retry waiting for the provider's capacity ends its turn with the error it stood in for: no later host would hear it again (#1693). Before the host is marked as leaving: the end is the error's, not a stop of the quit's
    this.overloadRetry.stopAll()
    this.disposing = true
    this.leaveHost('Centralu is shutting down')
    /*
     * A linked hub's update stops this host (#1618): the turns it ends are the ones in a turn now, read in the same step as
     * the processes are let go of below, with no new turn taken since `leaveHost`. Listed once the processes are down and
     * their last output written (below), each with the last row of its conversation then: the mark the next start
     * continues it by. A list of its own, beside any an earlier stop left (turns this host had not continued yet)
     */
    const sessions = this.stoppingForUpdate && this.keeperOpts.updateResume ? this.listSessions() : []
    const cut = cutTurns({ sessions, terminals: 0, commandRuns: 0 })
    /*
     * And what else the stop ends in them (#1902): the background tasks their processes hold, with the command of the call that
     * started each, and the cards that wait for the person. Read here, before the processes go: the tool reports each task gone
     * as its process ends, and the store's record of them is emptied at the next start. Idle sessions count: a dev server
     * outlives the turn that started it.
     */
    const stopped = stoppedAtUpdate(sessions, (id, callId) => this.store.messages.toolCallInput(id, callId))
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
    if ((cut.length || stopped.length) && this.keeperOpts.updateResume) {
      // One mark for both, read now: the processes are down and their last rows written, which the next start's reading must find
      const mark = (id: string) => this.store.messages.nextSeq(id) - 1
      recordUpdateCut(this.keeperOpts.updateResume, cut.map((id) => ({ id, seq: mark(id) })), stopped.map((x) => ({ ...x, seq: mark(x.id) })))
    }
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
    this.usageRecorder.stop()
    // A compact now would reach a process the next host is meant to take over, as a sleep would (#568)
    this.stopSelfCompaction()
    // The kept turns go on under the next host, which owes their reports (#646); failing the waits here must not report
    // Ends as a quit's does, before the host is marked as leaving (#1693)
    this.overloadRetry.stopAll()
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
    for (const run of [...this.inputs.agentRuns.values()]) run.fail(new Error(why))
    for (const readers of this.inputs.turnObservers.values()) for (const observer of readers) observer.fail(new Error(why))
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

  private requireHandle(sessionId: string): SessionHandle {
    const h = this.handles.get(sessionId)
    if (!h) throw sessionNotFound(sessionId)
    return h
  }
}

