import type {
  UsageHistory,
  UsageHistoryBy,
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalScope,
  Attachment,
  CreateSessionParams,
  CommandInfo,
  ExternalSession,
  UpdateSettingsParams,
  UpdateSettingsResult,
  GridPanel,
  NormalizedEvent,
  SessionInfo,
  StoredMessage,
  MessageImage,
  UsageSnapshot,
  CacheStats,
  ToolName,
  ToolSetup,
  ToolStatus,
  ModelOption,
  QuestionAnswer,
  AgentVersions,
  SleepPolicy,
} from '@cc/protocol/client'

export type UsageAnswer = {
  supported: boolean
  reason?: string
  notReported?: boolean
  provisional?: boolean
  usage: UsageSnapshot | null
  cache?: CacheStats
  sameAccountAsHub?: boolean
}
import type { Unsubscribe, ConnectionState, MachineRef } from './common.js'

/** docs/protocol.md §3 holds the contracts not noted here */
export interface AgentPort {
  createSession(params: CreateSessionParams): Promise<SessionInfo>
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
  /** Saves a pasted image and returns its path, so base64 stays out of the conversation record */
  saveAttachment(sessionId: string, name: string, mime: string, dataBase64: string): Promise<Attachment>
  respondApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    /** The pattern "always allow" targets, computed by core */
    matcher?: string,
  ): Promise<void>
  /** Answers AskUserQuestion; the answers go to the model as that tool's result */
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<void>
  interrupt(sessionId: string): Promise<void>
  stopBackgroundTask(sessionId: string, taskId: string): Promise<void>
  clearBackgroundTasks(sessionId: string): Promise<void>
  reorderSessions(projectId: string, orderedIds: string[]): Promise<SessionInfo[]>
  /** Creates the one Assistant if it does not exist; its projectId is null */
  assistant(): Promise<SessionInfo>
  /** Never creates it (#63): creation waits for the person's first question */
  assistantPeek(): Promise<SessionInfo | null>
  /** Only meaningful before the Assistant is created (#63) */
  configureAssistant(tool: ToolName): Promise<void>
  grid(): Promise<GridPanel[]>
  setGridView(panels: GridPanel[]): Promise<GridPanel[]>
  models(tool: ToolName, machine?: MachineRef): Promise<{ supported: boolean; reason?: string; models: ModelOption[] }>
  /** Restarts only the agent; the conversation stays */
  restartSession(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }>
  /**
   * Moves the session to the session archive (#204); `TrashPort` is the way out. The flags choose what goes when it is
   * deleted for good from there: the worktree, and the tool's own conversation file.
   */
  deleteSession(sessionId: string, deleteWorktree?: boolean, deleteExternal?: boolean): Promise<void>
  /**
   * Archives only when nothing would be lost and the session is at rest (#1512); otherwise `asks` lists what would be
   * lost (empty when it was only busy).
   */
  archiveIfAtRest(sessionId: string, deleteExternal?: boolean): Promise<{ archived: true } | { archived: false; asks: string[] }>
  /** Read only: what archiving would lose that Undo does not bring back (#1595), worktree included */
  archiveLosses(sessionId: string): Promise<string[]>
  /** Where the agent compacts next time its process starts, as its host decides (#1376) */
  autoCompact(sessionId: string): Promise<{ controlled: boolean; share: number; tokens: number | null }>
  /** Null when it is not a worktree session */
  worktreeStatus(
    sessionId: string,
  ): Promise<{ path: string; branch: string; dirty: boolean; changedFiles: number; more?: boolean; unknown?: boolean } | null>
  /** A dead agent's handoff (#78), made without its tool; written to the data folder's notes (absolute `path`) */
  exportHandoffRecord(sessionId: string, toTool?: ToolName): Promise<{ text: string; path: string }>
  /**
   * A live handoff (#142): the first human message after `afterSeq` is the request, and the agent's answer after it is
   * the note. Null: not yet (a turn is running, or no answer).
   */
  exportHandoffNote(sessionId: string, afterSeq: number): Promise<{ text: string; path: string } | null>
  mcpProposals(): Promise<{ proposals: { name: string; command: string; args: string[]; why?: string }[] }>
  /** Approving registers it and restarts the Assistant */
  resolveMcpProposal(name: string, approve: boolean): Promise<void>
  skillProposals(): Promise<{ proposals: { name: string; content: string; why?: string }[] }>
  /** Approving saves it and restarts the Assistant */
  resolveSkillProposal(name: string, approve: boolean): Promise<void>
  assistantSkills(): Promise<{ skills: { name: string; content: string }[] }>
  deleteAssistantSkill(name: string): Promise<void>
  /** The tool's kept sessions, terminal ones included; `supported: false` comes with a reason */
  listExternalSessions(
    projectId: string,
    tool: ToolName,
    limit?: number,
  ): Promise<{ supported: boolean; reason?: string; sessions: ExternalSession[] }>
  /** Revives a dead session (FR-10). `lockedElsewhere`: offer "fork and continue" without reading the reason */
  resumeSession(
    sessionId: string,
  ): Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }>
  /** Continues a locked conversation as a fork; the original, which another app may use, is left as is */
  forkConversation(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }>
  /** The conversation does not carry over to the new tool; the record stays in the store */
  switchTool(sessionId: string, tool: ToolName): Promise<SessionInfo>
  /** FR-7. The fields come from the protocol, so a field added there cannot drop out here */
  updateSettings(sessionId: string, settings: Omit<UpdateSettingsParams, 'sessionId'>): Promise<UpdateSettingsResult>
  rename(sessionId: string, name: string): Promise<void>
  markRead(sessionId: string, seq: number): Promise<void>
  /**
   * An error session goes idle, read up to `seq` (#1549); the error line stays. `cleared: false` when a newer row
   * exists (`newer`: a later error), left for the person.
   */
  clearError(sessionId: string, seq: number): Promise<{ cleared: boolean; newer: boolean }>
  /** Leaves to the person the stop Centralu would continue by itself (#1415); `stopped: false` when nothing waited */
  stopContinue(sessionId: string): Promise<{ stopped: boolean }>
  listSessions(): Promise<SessionInfo[]>
  loadMessages(sessionId: string, limit?: number, beforeSeq?: number): Promise<StoredMessage[]>
  /** One launch card's native subagent steps (#222), oldest first from `afterSeq`; never in `loadMessages` */
  loadSubagentMessages(sessionId: string, parentCallId: string, afterSeq?: number, limit?: number): Promise<StoredMessage[]>
  subagentTrashed(sessionId: string, parentCallId: string): Promise<{ steps: number }>
  /** docs/security-boundaries/desktop.md "Images a reply names" */
  messageImage(sessionId: string, path: string): Promise<MessageImage>
  capabilities(tool: ToolName, machine?: MachineRef): Promise<AdapterCapabilities>
  /** `ready: false` means the tool is not ready yet, not that there are none */
  commands(sessionId: string): Promise<{ ready: boolean; commands: CommandInfo[] }>
  usage(tool: ToolName, machine?: MachineRef, opts?: { settle?: boolean }): Promise<UsageAnswer>
  usageHistory(
    range: { from: string; to: string; groupBy: 'day' | 'hour'; by: UsageHistoryBy; tool?: ToolName },
    machine?: MachineRef,
  ): Promise<UsageHistory>
  detect(machine?: MachineRef): Promise<ToolStatus[]>
  installTool(tool: ToolName, machine?: MachineRef): Promise<ToolSetup>
  cancelInstallTool(tool: ToolName, machine?: MachineRef): Promise<ToolSetup>
  signInTool(tool: ToolName): Promise<ToolSetup>
  cancelSignInTool(tool: ToolName): Promise<ToolSetup>
  versions(force?: boolean, machine?: MachineRef): Promise<AgentVersions>
  setAutoApplyVersions(enabled: boolean, machine?: MachineRef): Promise<AgentVersions>
  applyVersions(machine?: MachineRef): Promise<{ restarted: string[]; busy: string[] }>
  sleepPolicy(): Promise<SleepPolicy>
  setSleepPolicy(afterMinutes: number | null): Promise<SleepPolicy>
  /**
   * Events from the moment of subscribing. `id` is the same in every window of this host (#2168), so they agree on
   * which tells the person; none where the host names none
   */
  subscribe(handler: (event: NormalizedEvent, id?: string) => void): Unsubscribe
  onConnectionChange(handler: (state: ConnectionState) => void): Unsubscribe
}
