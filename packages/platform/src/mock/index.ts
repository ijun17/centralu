import { defaultCapabilities } from '../capabilities.js'
import { changedFileCount, type NormalizedEvent } from '@cc/protocol'
import type { AgentPort, Platform } from '../ports/index.js'
import { AgentVersionsMock } from './agent-versions.js'
import { AppBuilderMock } from './app-builder.js'
import { AppImportsMock } from './app-imports.js'
import { AppRegistry } from './app-registry.js'
import { AppSettingsMock } from './app-settings.js'
import { ApprovalsMock } from './approvals.js'
import { AppsMock } from './apps.js'
import { BackgroundTasksMock } from './background-tasks.js'
import { MockClock } from './clock.js'
import { CommandsMock } from './commands.js'
import { EventBus, type Emit } from './event-bus.js'
import { ExternalSessionsMock } from './external-sessions.js'
import { FilesMock } from './files.js'
import { GitMock } from './git.js'
import { GridMock } from './grid.js'
import { HandoffMock } from './handoff.js'
import { KeeperMock } from './keeper.js'
import { MachinesMock } from './machines.js'
import { OrchestratorMock } from './orchestrator.js'
import { PreferencesMock } from './preferences.js'
import { ProjectStore } from './project-store.js'
import { ProjectsMock } from './projects.js'
import { ProposalsMock } from './proposals.js'
import { RulesMock } from './rules.js'
import { SessionStore } from './session-store.js'
import { SessionsMock } from './sessions.js'
import { SystemMock } from './system.js'
import { TerminalsMock } from './terminals.js'
import { ThemesMock } from './themes.js'
import { ToolsMock } from './tools.js'
import { TrashMock } from './trash.js'
import { UpdatesMock } from './updates.js'
import { UsageMock } from './usage.js'
import { type MemoryFsState } from './memory-fs.js'

/**
 * The in-memory implementation (docs/platform-abstraction.md §6).
 * Tests and Playwright use this — the ports are not mocked ad hoc with a mocking library
 * (that would split the contract apart).
 */

export type MockOptions = {
  /** A deterministic clock — for testing elapsed waiting time */
  now?: () => number
}

export class MockPlatform implements Platform {
  private readonly clock = new MockClock(() => Date.now())
  private readonly bus = new EventBus()
  /** The `emit` the modules are given, so they can broadcast without importing this class */
  private readonly forward: Emit = (event) => this.emit(event)
  private readonly store = new SessionStore(this.clock)
  private readonly toolsMock = new ToolsMock()
  private readonly backgroundMock = new BackgroundTasksMock(this.forward)
  private readonly gitMock = new GitMock()
  private readonly projectStore = new ProjectStore(() => changedFileCount(this.gitMock.gitState.files))
  private readonly externalSessionsMock = new ExternalSessionsMock(this.store)
  private readonly gridMock = new GridMock(this.store, this.projectStore)
  private readonly trashMock = new TrashMock(this.clock, this.forward, this.store, this.projectStore, this.toolsMock, this.gridMock)
  private readonly sessionsMock = new SessionsMock(this.clock, this.forward, this.store, this.projectStore, this.externalSessionsMock, this.trashMock)
  private readonly agentVersionsMock = new AgentVersionsMock(this.clock, this.forward, this.store, this.toolsMock, this.backgroundMock, this.sessionsMock)
  private readonly registry = new AppRegistry(this.forward)
  private readonly orchestratorMock = new OrchestratorMock(this.clock, this.store, this.toolsMock)
  private readonly appBuilderMock = new AppBuilderMock(this.clock, this.forward, this.store, this.projectStore, this.registry, this.toolsMock, this.orchestratorMock)
  private readonly appImportsMock = new AppImportsMock(this.clock, this.forward, this.registry)
  private readonly appSettingsMock = new AppSettingsMock(this.forward, this.registry)
  private readonly rulesMock = new RulesMock(this.forward)
  private readonly approvalsMock = new ApprovalsMock(this.clock, this.forward, this.store, this.rulesMock)
  private readonly appsMock = new AppsMock(this.clock, this.forward, this.store, this.registry)
  private readonly terminalsMock = new TerminalsMock(this.clock, this.projectStore)
  private readonly commandsMock = new CommandsMock(this.clock, this.terminalsMock)
  private readonly filesMock = new FilesMock()
  private readonly handoffMock = new HandoffMock(this.store)
  private readonly updatesMock = new UpdatesMock(this.clock, this.forward)
  private readonly keeperMock = new KeeperMock(this.updatesMock)
  private readonly machinesMock = new MachinesMock(this.forward, this.projectStore)
  private readonly preferencesMock = new PreferencesMock()
  private readonly projectsMock = new ProjectsMock(this.clock, this.forward, this.store, this.projectStore, this.registry, this.toolsMock, this.gridMock, this.machinesMock, this.trashMock)
  private readonly proposalsMock = new ProposalsMock(this.forward)
  private readonly systemMock = new SystemMock()
  private readonly themesMock = new ThemesMock(this.forward)
  private readonly usageMock = new UsageMock()

  readonly agents: AgentPort = {
    ...this.sessionsMock.agents,
    ...this.approvalsMock.agents,
    ...this.orchestratorMock.agents,
    ...this.gridMock.agents,
    ...this.toolsMock.agents,
    ...this.backgroundMock.agents,
    ...this.handoffMock.agents,
    ...this.proposalsMock.agents,
    ...this.externalSessionsMock.agents,
    ...this.usageMock.agents,
    ...this.agentVersionsMock.agents,
    ...this.bus.agents,
  }
  readonly apps = {
    ...this.appsMock.apps,
    ...this.appBuilderMock.apps,
    ...this.appSettingsMock.apps,
    ...this.appImportsMock.apps,
  }
  readonly projects = this.projectsMock.projects
  readonly machines = this.machinesMock.machines
  readonly trash = this.trashMock.trash
  readonly fs = this.filesMock.fs
  readonly git = this.gitMock.git
  readonly terminal = this.terminalsMock.terminal
  readonly commands = this.commandsMock.commands
  readonly system = this.systemMock.system
  readonly workspace = this.preferencesMock.workspace
  readonly prefs = this.preferencesMock.prefs
  readonly themes = this.themesMock.themes
  readonly updates = this.updatesMock.updates
  readonly relaunch = this.keeperMock.relaunch
  readonly background = this.keeperMock.background
  readonly processes = this.keeperMock.processes
  readonly search = this.rulesMock.search
  readonly consents = this.rulesMock.consents
  readonly rules = this.rulesMock.rules

  constructor(opts: MockOptions = {}) {
    if (opts.now) this.clock.now = opts.now
  }

  /*
   * The defaults, with the window edge where E2E measures the header from. The file manager settles on the Mac name:
   * guessing the machine e2e runs on would make what gets written on screen vary from test to test. E2E drives this
   * mock in Chromium and in WebKit, and the engine running it is the real one.
   */
  readonly capabilities = defaultCapabilities({ fileManagerName: 'Finder' })

  /** The channel through which tests inject events */
  emit(event: NormalizedEvent): void {
    // The event families are recorded by the modules that own what they touch; this only runs them in the host's order
    if (event.type === 'subagent_event') {
      const stepSeq = this.store.recordSubagentStep(event)
      // A step the host keeps no row for is not sent on either (a chunk with no text)
      if (stepSeq !== null) this.bus.broadcast({ ...event, stepSeq })
      return
    }
    this.backgroundMock.track(event)
    if (this.store.isRepeatedNotice(event)) return
    let out: NormalizedEvent = event
    this.registry.recordInlineView(event)
    if (event.sessionId) {
      const s = this.store.sessions.get(event.sessionId)
      if (s) {
        this.store.applyLiveFacts(s, event)
        out = this.store.record(s, event, out)
      }
    }
    this.bus.broadcast(out)
  }

  /** The fake file tree tests manipulate — the state lives in the MemoryFs behind the `fs` port */
  get fsState(): MemoryFsState {
    return this.filesMock.memoryFs.state
  }
  set fsState(state: MemoryFsState) {
    this.filesMock.memoryFs.state = state
  }

  // session-store.ts
  get sessions() { return this.store.sessions }
  set sessions(value: SessionStore['sessions']) { this.store.sessions = value }
  get messages() { return this.store.messages }
  set messages(value: SessionStore['messages']) { this.store.messages = value }
  get subagentMessages() { return this.store.subagentMessages }
  set subagentMessages(value: SessionStore['subagentMessages']) { this.store.subagentMessages = value }
  get subagentReads() { return this.store.subagentReads }
  set subagentReads(value: SessionStore['subagentReads']) { this.store.subagentReads = value }

  // app-registry.ts
  get externalAppList() { return this.registry.externalAppList }
  set externalAppList(value: AppRegistry['externalAppList']) { this.registry.externalAppList = value }
  get appErrors() { return this.registry.appErrors }
  get appRuns() { return this.registry.appRuns }
  get appBuilders() { return this.registry.appBuilders }
  get pinnedInstances() { return this.registry.pinnedInstances }
  get inlineInstances() { return this.registry.inlineInstances }
  get inlineRecords() { return this.registry.inlineRecords }

  // project-store.ts
  get projectsList() { return this.projectStore.list }
  set projectsList(value: ProjectStore['list']) { this.projectStore.list = value }

  // sessions.ts
  get unresumable() { return this.sessionsMock.unresumable }
  get savedAttachments() { return this.sessionsMock.savedAttachments }
  get sentAttachments() { return this.sessionsMock.sentAttachments }
  get attachmentData() { return this.sessionsMock.attachmentData }
  get restarted() { return this.sessionsMock.restarted }
  set restarted(value: SessionsMock['restarted']) { this.sessionsMock.restarted = value }
  get lastCreateParams() { return this.sessionsMock.lastCreateParams }
  set lastCreateParams(value: SessionsMock['lastCreateParams']) { this.sessionsMock.lastCreateParams = value }
  get createParamsLog() { return this.sessionsMock.createParamsLog }
  get mockWorktreeDirty() { return this.sessionsMock.mockWorktreeDirty }
  set mockWorktreeDirty(value: SessionsMock['mockWorktreeDirty']) { this.sessionsMock.mockWorktreeDirty = value }
  get messageImages() { return this.sessionsMock.messageImages }
  get messageImageCalls() { return this.sessionsMock.messageImageCalls }
  get resumeCalls() { return this.sessionsMock.resumeCalls }
  set resumeCalls(value: SessionsMock['resumeCalls']) { this.sessionsMock.resumeCalls = value }
  get wakeDelayMs() { return this.sessionsMock.wakeDelayMs }
  set wakeDelayMs(value: SessionsMock['wakeDelayMs']) { this.sessionsMock.wakeDelayMs = value }

  // approvals.ts
  get approvalAnswers() { return this.approvalsMock.approvalAnswers }
  get approvalScopes() { return this.approvalsMock.approvalScopes }

  // orchestrator.ts
  get orchestratorTool() { return this.orchestratorMock.orchestratorTool }
  set orchestratorTool(value: OrchestratorMock['orchestratorTool']) { this.orchestratorMock.orchestratorTool = value }

  // proposals.ts
  get mcpProposalList() { return this.proposalsMock.mcpProposalList }
  get mcpApproved() { return this.proposalsMock.mcpApproved }
  get skillProposalList() { return this.proposalsMock.skillProposalList }
  get proposalReads() { return this.proposalsMock.proposalReads }
  set proposalReads(value: ProposalsMock['proposalReads']) { this.proposalsMock.proposalReads = value }
  get skillList() { return this.proposalsMock.skillList }

  // handoff.ts
  get handoffNotes() { return this.handoffMock.handoffNotes }
  set handoffNotes(value: HandoffMock['handoffNotes']) { this.handoffMock.handoffNotes = value }

  // external-sessions.ts
  get externalSessions() { return this.externalSessionsMock.externalSessions }
  set externalSessions(value: ExternalSessionsMock['externalSessions']) { this.externalSessionsMock.externalSessions = value }
  get externalHistory() { return this.externalSessionsMock.externalHistory }
  set externalHistory(value: ExternalSessionsMock['externalHistory']) { this.externalSessionsMock.externalHistory = value }
  get holdExternalSessions() { return this.externalSessionsMock.holdExternalSessions }
  set holdExternalSessions(value: boolean) { this.externalSessionsMock.holdExternalSessions = value }
  releaseExternalSessions(): void { this.externalSessionsMock.releaseExternalSessions() }

  // trash.ts
  get externallyDeleted() { return this.trashMock.externallyDeleted }
  get trashBin() { return this.trashMock.trashBin }
  /** The app-agent run records in the trash (#378); a test seeds one with `keepRun` */
  get keptRuns() { return this.trashMock.keptRuns }
  keepRun(...a: Parameters<TrashMock['keepRun']>): void { this.trashMock.keepRun(...a) }

  // tools.ts
  get detected() { return this.toolsMock.detected }
  set detected(value: ToolsMock['detected']) { this.toolsMock.detected = value }
  get machineDetected() { return this.toolsMock.machineDetected }
  set machineDetected(value: ToolsMock['machineDetected']) { this.toolsMock.machineDetected = value }
  get commandState() { return this.toolsMock.commandState }
  set commandState(value: ToolsMock['commandState']) { this.toolsMock.commandState = value }

  // usage.ts
  get usageState() { return this.usageMock.usageState }
  set usageState(value: UsageMock['usageState']) { this.usageMock.usageState = value }
  get machineUsage() { return this.usageMock.machineUsage }
  set machineUsage(value: UsageMock['machineUsage']) { this.usageMock.machineUsage = value }
  get usageCalls() { return this.usageMock.usageCalls }
  set usageCalls(value: UsageMock['usageCalls']) { this.usageMock.usageCalls = value }
  get cacheStats() { return this.usageMock.cacheStats }
  set cacheStats(value: UsageMock['cacheStats']) { this.usageMock.cacheStats = value }

  // agent-versions.ts
  get agentVersions() { return this.agentVersionsMock.agentVersions }
  set agentVersions(value: AgentVersionsMock['agentVersions']) { this.agentVersionsMock.agentVersions = value }
  get sleepPolicy() { return this.agentVersionsMock.sleepPolicy }
  set sleepPolicy(value: AgentVersionsMock['sleepPolicy']) { this.agentVersionsMock.sleepPolicy = value }

  // background-tasks.ts
  get stoppedTasks() { return this.backgroundMock.stoppedTasks }
  get interrupts() { return this.backgroundMock.interrupts }

  // apps.ts
  get heldViews() { return this.appsMock.heldViews }
  get restarts() { return this.appsMock.restarts }
  get appRunReads() { return this.appsMock.appRunReads }
  set appRunReads(value: AppsMock['appRunReads']) { this.appsMock.appRunReads = value }
  get appRunsProvider() { return this.appsMock.appRunsProvider }
  set appRunsProvider(value: AppsMock['appRunsProvider']) { this.appsMock.appRunsProvider = value }
  get removedApps() { return this.appsMock.removedApps }
  get openedViews() { return this.appsMock.openedViews }
  get closedViews() { return this.appsMock.closedViews }
  get viewMessages() { return this.appsMock.viewMessages }
  get reopenedViews() { return this.appsMock.reopenedViews }
  get inlineInstanceProvider() { return this.appsMock.inlineInstanceProvider }
  set inlineInstanceProvider(value: AppsMock['inlineInstanceProvider']) { this.appsMock.inlineInstanceProvider = value }
  get openViewProvider() { return this.appsMock.openViewProvider }
  set openViewProvider(value: AppsMock['openViewProvider']) { this.appsMock.openViewProvider = value }
  get viewFrameProvider() { return this.appsMock.viewFrameProvider }
  set viewFrameProvider(value: AppsMock['viewFrameProvider']) { this.appsMock.viewFrameProvider = value }
  get appToolCalls() { return this.appsMock.appToolCalls }
  get appToolHandler() { return this.appsMock.appToolHandler }
  set appToolHandler(value: AppsMock['appToolHandler']) { this.appsMock.appToolHandler = value }
  get appResources() { return this.appsMock.appResources }
  get appResourceReads() { return this.appsMock.appResourceReads }

  // app-builder.ts
  get appAttachments() { return this.appBuilderMock.appAttachments }
  get reachAsks() { return this.appBuilderMock.reachAsks }
  get errorSends() { return this.appBuilderMock.errorSends }
  get errorReads() { return this.appBuilderMock.errorReads }
  set errorReads(value: AppBuilderMock['errorReads']) { this.appBuilderMock.errorReads = value }
  get sendErrorGate() { return this.appBuilderMock.sendErrorGate }
  set sendErrorGate(value: AppBuilderMock['sendErrorGate']) { this.appBuilderMock.sendErrorGate = value }
  get createdApps() { return this.appBuilderMock.createdApps }
  get builderAsks() { return this.appBuilderMock.builderAsks }

  // app-settings.ts
  get secretWrites() { return this.appSettingsMock.secretWrites }
  get sharedWrites() { return this.appSettingsMock.sharedWrites }
  get appQuestionList() { return this.appSettingsMock.appQuestionList }
  set appQuestionList(value: AppSettingsMock['appQuestionList']) { this.appSettingsMock.appQuestionList = value }
  get answeredQuestions() { return this.appSettingsMock.answeredQuestions }
  get appPermissions() { return this.appSettingsMock.appPermissions }
  get appUsage() { return this.appSettingsMock.appUsage }
  get forgottenPermissions() { return this.appSettingsMock.forgottenPermissions }

  // app-imports.ts
  get importSources() { return this.appImportsMock.importSources }
  get importRefusals() { return this.appImportsMock.importRefusals }
  get appReviews() { return this.appImportsMock.appReviews }
  get importPrepares() { return this.appImportsMock.importPrepares }
  get importCommits() { return this.appImportsMock.importCommits }
  get importCancels() { return this.appImportsMock.importCancels }
  get enabledApps() { return this.appImportsMock.enabledApps }
  get appVersions() { return this.appImportsMock.appVersions }
  get restoredVersions() { return this.appImportsMock.restoredVersions }

  // projects.ts
  get takenPaths() { return this.projectsMock.takenPaths }
  set takenPaths(value: ProjectsMock['takenPaths']) { this.projectsMock.takenPaths = value }
  get createProjectCalls() { return this.projectsMock.createProjectCalls }
  get nextCloneError() { return this.projectsMock.nextCloneError }
  set nextCloneError(value: ProjectsMock['nextCloneError']) { this.projectsMock.nextCloneError = value }
  get gitStatusCalls() { return this.projectsMock.gitStatusCalls }
  set gitStatusCalls(value: ProjectsMock['gitStatusCalls']) { this.projectsMock.gitStatusCalls = value }
  get trustCalls() { return this.projectsMock.trustCalls }

  // machines.ts
  get machinesList() { return this.machinesMock.machinesList }
  set machinesList(value: MachinesMock['machinesList']) { this.machinesMock.machinesList = value }
  get sshConfig() { return this.machinesMock.sshConfig }
  set sshConfig(value: MachinesMock['sshConfig']) { this.machinesMock.sshConfig = value }
  get probeAnswers() { return this.machinesMock.probeAnswers }
  set probeAnswers(value: MachinesMock['probeAnswers']) { this.machinesMock.probeAnswers = value }

  // git.ts
  get gitDiffCalls() { return this.gitMock.gitDiffCalls }
  get gitState() { return this.gitMock.gitState }
  set gitState(value: GitMock['gitState']) { this.gitMock.gitState = value }

  // files.ts
  get fileOps() { return this.filesMock.fileOps }
  get sessionFiles() { return this.filesMock.sessionFiles }
  get watchedDirs() { return this.filesMock.watchedDirs }
  set watchedDirs(value: FilesMock['watchedDirs']) { this.filesMock.watchedDirs = value }
  get trashed() { return this.filesMock.trashed }
  get trashedProjects() { return this.filesMock.trashedProjects }
  get revealed() { return this.filesMock.revealed }
  get revealedImages() { return this.filesMock.revealedImages }

  // terminals.ts
  get terminalState() { return this.terminalsMock.terminalState }
  set terminalState(value: TerminalsMock['terminalState']) { this.terminalsMock.terminalState = value }

  // commands.ts
  get commandRuns() { return this.commandsMock.commandRuns }
  set commandRuns(value: CommandsMock['commandRuns']) { this.commandsMock.commandRuns = value }

  // system.ts
  get nextPickedDirectory() { return this.systemMock.nextPickedDirectory }
  set nextPickedDirectory(value: SystemMock['nextPickedDirectory']) { this.systemMock.nextPickedDirectory = value }
  get nextPickedFile() { return this.systemMock.nextPickedFile }
  set nextPickedFile(value: SystemMock['nextPickedFile']) { this.systemMock.nextPickedFile = value }
  get pickedFileAsks() { return this.systemMock.pickedFileAsks }
  get pickFails() { return this.systemMock.pickFails }
  set pickFails(value: SystemMock['pickFails']) { this.systemMock.pickFails = value }
  get notifications() { return this.systemMock.notifications }
  get opened() { return this.systemMock.opened }
  get openedUrls() { return this.systemMock.openedUrls }
  get badge() { return this.systemMock.badge }
  set badge(value: SystemMock['badge']) { this.systemMock.badge = value }
  get windowDrags() { return this.systemMock.windowDrags }
  set windowDrags(value: SystemMock['windowDrags']) { this.systemMock.windowDrags = value }
  get windowAppearance() { return this.systemMock.windowAppearance }
  set windowAppearance(value: SystemMock['windowAppearance']) { this.systemMock.windowAppearance = value }
  get alerts() { return this.systemMock.alerts }
  set alerts(value: SystemMock['alerts']) { this.systemMock.alerts = value }

  // keeper.ts
  get strayProcesses() { return this.keeperMock.strayProcesses }
  set strayProcesses(value: KeeperMock['strayProcesses']) { this.keeperMock.strayProcesses = value }
  get backgroundOn() { return this.keeperMock.backgroundOn }
  set backgroundOn(value: KeeperMock['backgroundOn']) { this.keeperMock.backgroundOn = value }
  get relaunchCheck() { return this.keeperMock.relaunchCheck }
  set relaunchCheck(value: KeeperMock['relaunchCheck']) { this.keeperMock.relaunchCheck = value }
  get relaunches() { return this.keeperMock.relaunches }
  set relaunches(value: KeeperMock['relaunches']) { this.keeperMock.relaunches = value }
  get relaunchFails() { return this.keeperMock.relaunchFails }
  set relaunchFails(value: KeeperMock['relaunchFails']) { this.keeperMock.relaunchFails = value }

  // updates.ts
  get registryVersion() { return this.updatesMock.registryVersion }
  set registryVersion(value: UpdatesMock['registryVersion']) { this.updatesMock.registryVersion = value }
  get updateChecks() { return this.updatesMock.updateChecks }
  set updateChecks(value: UpdatesMock['updateChecks']) { this.updatesMock.updateChecks = value }
  get updateFails() { return this.updatesMock.updateFails }
  set updateFails(value: UpdatesMock['updateFails']) { this.updatesMock.updateFails = value }
  get applyAnswers() { return this.updatesMock.applyAnswers }
  set applyAnswers(value: UpdatesMock['applyAnswers']) { this.updatesMock.applyAnswers = value }
  get applyReports() { return this.updatesMock.applyReports }
  set applyReports(value: UpdatesMock['applyReports']) { this.updatesMock.applyReports = value }

  // themes.ts
  get themeFiles() { return this.themesMock.themeFiles }
  set themeFiles(value: ThemesMock['themeFiles']) { this.themesMock.themeFiles = value }
  get themeImportSources() { return this.themesMock.themeImportSources }
  set themeImportSources(value: ThemesMock['themeImportSources']) { this.themesMock.themeImportSources = value }
  get revealedThemes() { return this.themesMock.revealedThemes }

  // preferences.ts
  get workspaceSnapshot() { return this.preferencesMock.workspaceSnapshot }
  set workspaceSnapshot(value: PreferencesMock['workspaceSnapshot']) { this.preferencesMock.workspaceSnapshot = value }
  get uiPrefs() { return this.preferencesMock.uiPrefs }
  set uiPrefs(value: PreferencesMock['uiPrefs']) { this.preferencesMock.uiPrefs = value }

  // rules.ts
  get searchResults() { return this.rulesMock.searchResults }
  set searchResults(value: RulesMock['searchResults']) { this.rulesMock.searchResults = value }
  get rulesList() { return this.rulesMock.rulesList }
  set rulesList(value: RulesMock['rulesList']) { this.rulesMock.rulesList = value }
  get consentsList() { return this.rulesMock.consentsList }
  set consentsList(value: RulesMock['consentsList']) { this.rulesMock.consentsList = value }

  requestApproval(...args: Parameters<ApprovalsMock['requestApproval']>): ReturnType<ApprovalsMock['requestApproval']> { return this.approvalsMock.requestApproval(...args) }
  replaceApprovalUnseen(...args: Parameters<ApprovalsMock['replaceApprovalUnseen']>): ReturnType<ApprovalsMock['replaceApprovalUnseen']> { return this.approvalsMock.replaceApprovalUnseen(...args) }
  saveProposal(...args: Parameters<ProposalsMock['saveProposal']>): ReturnType<ProposalsMock['saveProposal']> { return this.proposalsMock.saveProposal(...args) }
  setInstalledVersions(...args: Parameters<AgentVersionsMock['setInstalledVersions']>): ReturnType<AgentVersionsMock['setInstalledVersions']> { return this.agentVersionsMock.setInstalledVersions(...args) }
  askAppQuestion(...args: Parameters<AppSettingsMock['askAppQuestion']>): ReturnType<AppSettingsMock['askAppQuestion']> { return this.appSettingsMock.askAppQuestion(...args) }
  emitTerminal(...args: Parameters<TerminalsMock['emitTerminal']>): ReturnType<TerminalsMock['emitTerminal']> { return this.terminalsMock.emitTerminal(...args) }
  emitTerminalExit(...args: Parameters<TerminalsMock['emitTerminalExit']>): ReturnType<TerminalsMock['emitTerminalExit']> { return this.terminalsMock.emitTerminalExit(...args) }
  emitCommandOutput(...args: Parameters<CommandsMock['emitCommandOutput']>): ReturnType<CommandsMock['emitCommandOutput']> { return this.commandsMock.emitCommandOutput(...args) }
  exitCommand(...args: Parameters<CommandsMock['exitCommand']>): ReturnType<CommandsMock['exitCommand']> { return this.commandsMock.exitCommand(...args) }
  openAppLink(...args: Parameters<SystemMock['openAppLink']>): ReturnType<SystemMock['openAppLink']> { return this.systemMock.openAppLink(...args) }
  setHostBusy(...args: Parameters<KeeperMock['setHostBusy']>): ReturnType<KeeperMock['setHostBusy']> { return this.keeperMock.setHostBusy(...args) }
  agentApply(...args: Parameters<UpdatesMock['agentApply']>): ReturnType<UpdatesMock['agentApply']> { return this.updatesMock.agentApply(...args) }
  offerUpdate(...args: Parameters<UpdatesMock['offerUpdate']>): ReturnType<UpdatesMock['offerUpdate']> { return this.updatesMock.offerUpdate(...args) }
  writeThemeFile(...args: Parameters<ThemesMock['writeThemeFile']>): ReturnType<ThemesMock['writeThemeFile']> { return this.themesMock.writeThemeFile(...args) }
  setConnectionState(...args: Parameters<EventBus['setConnectionState']>): ReturnType<EventBus['setConnectionState']> { return this.bus.setConnectionState(...args) }
  dispose(...args: Parameters<EventBus['dispose']>): ReturnType<EventBus['dispose']> { return this.bus.dispose(...args) }
  setExternalApps(...args: Parameters<AppRegistry['setExternalApps']>): ReturnType<AppRegistry['setExternalApps']> { return this.registry.setExternalApps(...args) }
  recordAppError(...args: Parameters<AppRegistry['recordAppError']>): ReturnType<AppRegistry['recordAppError']> { return this.registry.recordAppError(...args) }
  machineRow(...args: Parameters<MachinesMock['machineRow']>): ReturnType<MachinesMock['machineRow']> { return this.machinesMock.machineRow(...args) }

  /** Lays one file down in the mock and builds the whole path up to it (#104) — see `MemoryFs.place` */
  placeFile(path: string, text: string): void {
    this.filesMock.memoryFs.place(path, text)
  }
}

export function createMockPlatform(opts?: MockOptions): MockPlatform {
  return new MockPlatform(opts)
}
