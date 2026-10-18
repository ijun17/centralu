import type {
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
  ToolStatus,
  ModelOption,
  QuestionAnswer,
  AgentVersions,
  SleepPolicy,
} from '@cc/protocol'
import type { Unsubscribe, ConnectionState, MachineRef } from './common.js'

export interface AgentPort {
  createSession(params: CreateSessionParams): Promise<SessionInfo>
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
  /** Saves a pasted image and returns its path (so base64 does not end up in the conversation record) */
  saveAttachment(sessionId: string, name: string, mime: string, dataBase64: string): Promise<Attachment>
  respondApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    /** The pattern that "always allow" targets (computed by core) */
    matcher?: string,
  ): Promise<void>
  /** Answers the options (AskUserQuestion) — the answer goes to the model as that tool's result */
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<void>
  interrupt(sessionId: string): Promise<void>
  /** Stops one background task the session listed as stoppable (#290); its ending arrives as an event */
  stopBackgroundTask(sessionId: string, taskId: string): Promise<void>
  /** Takes the ended background tasks off the session's list (#290) */
  clearBackgroundTasks(sessionId: string): Promise<void>
  /** Sidebar order (the person sets it by dragging). Sends the whole order at once */
  reorderSessions(projectId: string, orderedIds: string[]): Promise<SessionInfo[]>
  /**
   * The app's one and only orchestrator. **Calling it creates one if it does not exist.**
   * It does not belong to a project, so projectId is null.
   */
  orchestrator(): Promise<SessionInfo>
  /**
   * Returns it if it exists, and **does not create one if it does not** (#63). Used by
   * whichever screen is opening — creation happens in orchestrator(), at the moment the
   * person asks the first question (lazy startup).
   */
  orchestratorPeek(): Promise<SessionInfo | null>
  /** The tool the central orchestrator runs on (#63, the card choice on the intro screen). Only meaningful before it is created */
  configureOrchestrator(tool: ToolName): Promise<void>
  /**
   * Grid layout — sessions and apps, in order (#288). Adding, removing and reordering all come
   * through this one call; the answer is the list as stored (unknown sessions left out).
   */
  grid(): Promise<GridPanel[]>
  setGridView(panels: GridPanel[]): Promise<GridPanel[]>
  /** The models available to pick and each model's reasoning strength (what the tool reports through its official API) */
  models(tool: ToolName, machine?: MachineRef): Promise<{ supported: boolean; reason?: string; models: ModelOption[] }>
  /** Restarts only the agent attached to the session (the conversation stays as is) */
  restartSession(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }>
  /**
   * Moves the session to the trash (#204) — nothing is destroyed here; `TrashPort` is the way out.
   * `deleteWorktree` and `deleteExternal` choose what goes with it when it is deleted for good from the trash:
   * the worktree, and the tool's own conversation file (codex rollout, claude JSONL). Both stay until then.
   */
  deleteSession(sessionId: string, deleteWorktree?: boolean, deleteExternal?: boolean): Promise<void>
  /** The material needed to ask the person whether it is fine to delete. Null if it is not a worktree session */
  worktreeStatus(
    sessionId: string,
  ): Promise<{ path: string; branch: string; dirty: boolean; changedFiles: number; more?: boolean; unknown?: boolean } | null>
  /**
   * A dead-agent handoff record (#78) — the host creates it without calling that session's
   * tool. The host writes it to the notes location in the data folder and returns the
   * absolute path (#102, #142); text is for the preview.
   */
  exportHandoffRecord(sessionId: string, toTool?: ToolName): Promise<{ text: string; path: string }>
  /**
   * The note for a live handoff (#142) — the first human message after afterSeq (the last seq
   * right before the request) is the request, and the host puts the agent's last answer after
   * that in the same spot.
   * Null means "not yet": either a turn is running, or there is no answer.
   */
  exportHandoffNote(sessionId: string, afterSeq: number): Promise<{ text: string; path: string } | null>
  /** The orchestrator's list of proposed MCP servers (propose_mcp_server → the ones waiting for approval) */
  mcpProposals(): Promise<{ proposals: { name: string; command: string; args: string[]; why?: string }[] }>
  /** The person's answer to a proposal — if approved, the app registers it and restarts the orchestrator */
  resolveMcpProposal(name: string, approve: boolean): Promise<void>
  /** The orchestrator's list of proposed skills (#71 — propose_skill → the ones waiting for approval) */
  skillProposals(): Promise<{ proposals: { name: string; content: string; why?: string }[] }>
  /** The person's answer to a skill proposal — if approved, saves it to the DB and restarts the orchestrator */
  resolveSkillProposal(name: string, approve: boolean): Promise<void>
  /** The list of approved skills — viewed and deleted from Settings (a skill that cannot be deleted is worse than none) */
  orchestratorSkills(): Promise<{ skills: { name: string; content: string }[] }>
  deleteOrchestratorSkill(name: string): Promise<void>
  /**
   * Previous sessions the tool has kept (including ones created from the terminal).
   * If supported=false, a reason comes with it — even an older tool version does not block
   * "new session".
   */
  listExternalSessions(
    projectId: string,
    tool: ToolName,
    limit?: number,
  ): Promise<{ supported: boolean; reason?: string; sessions: ExternalSession[] }>
  /**
   * Revives a dead session (FR-10). If resumed=false, a reason comes with it.
   * If `lockedElsewhere`, "fork and continue" can be offered without even reading the reason.
   */
  resumeSession(
    sessionId: string,
  ): Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }>
  /**
   * Forks off a locked conversation and continues it as this session.
   * Leaves the original as is — does not take away a conversation another app was using.
   */
  forkConversation(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }>
  /**
   * Switches the session's agent (claude ↔ codex).
   * **The conversation does not carry over** — the new tool does not know the old conversation.
   * The record stays in our own store.
   */
  switchTool(sessionId: string, tool: ToolName): Promise<SessionInfo>
  /**
   * Changes model, permissions and reasoning strength mid-conversation (FR-7).
   * The fields are defined by the protocol — restating them here would let a later-added field
   * silently drop out.
   */
  updateSettings(sessionId: string, settings: Omit<UpdateSettingsParams, 'sessionId'>): Promise<UpdateSettingsResult>
  rename(sessionId: string, name: string): Promise<void>
  markRead(sessionId: string, seq: number): Promise<void>
  listSessions(): Promise<SessionInfo[]>
  loadMessages(sessionId: string, limit?: number, beforeSeq?: number): Promise<StoredMessage[]>
  /**
   * The steps of the native subagent one card launched (#222), oldest first, paging forward from `afterSeq`. Asked only
   * when the person opens that card's steps — they are never part of `loadMessages`.
   */
  loadSubagentMessages(sessionId: string, parentCallId: string, afterSeq?: number, limit?: number): Promise<StoredMessage[]>
  /**
   * How many of one launch card's steps are in the trash (#418), so the card says they were moved there rather than
   * that none were recorded. A host before it does not answer.
   */
  subagentTrashed(sessionId: string, parentCallId: string): Promise<{ steps: number }>
  /**
   * A local image one of this session's replies names, read by the host the session runs on (`messages.image`). The
   * window cannot load a file path itself; the host reads only a path a reply wrote, only a real PNG, JPEG, GIF or WebP,
   * and at most 10 MB, and says why when it does not (docs/security-boundaries.md, "Images a reply names").
   */
  messageImage(sessionId: string, path: string): Promise<MessageImage>
  capabilities(tool: ToolName, machine?: MachineRef): Promise<AdapterCapabilities>
  /**
   * This session's slash commands (skills).
   * ready=false does not mean "none" — it means the tool is not ready yet.
   */
  commands(sessionId: string): Promise<{ ready: boolean; commands: CommandInfo[] }>
  /**
   * Account usage and limits (FR-9). Handles only subscription limits. Also what the prompt cache did lately, as that
   * machine's host counted it (`cache`, absent from a host that predates it).
   * `sameAccountAsHub`: for a linked machine, the limits are this computer's because both are logged in to one account (#726)
   */
  usage(
    tool: ToolName,
    machine?: MachineRef,
  ): Promise<{ supported: boolean; reason?: string; usage: UsageSnapshot | null; cache?: CacheStats; sameAccountAsHub?: boolean }>
  detect(machine?: MachineRef): Promise<ToolStatus[]>
  /**
   * The agent CLIs installed now, and whether idle sessions move to a newer one by themselves (#297). `force: false`
   * (the window gaining focus) takes a reading from moments ago.
   */
  versions(force?: boolean, machine?: MachineRef): Promise<AgentVersions>
  /** "Move idle sessions to a newly installed agent CLI" on or off (#297) */
  setAutoApplyVersions(enabled: boolean, machine?: MachineRef): Promise<AgentVersions>
  /** Restarts every idle session that runs an older CLI on the installed one; the busy ones are listed (#297) */
  applyVersions(machine?: MachineRef): Promise<{ restarted: string[]; busy: string[] }>
  /** When idle sessions go to sleep (#568): this host's setting */
  sleepPolicy(): Promise<SleepPolicy>
  /** "Put idle sessions to sleep after" (#568); null never */
  setSleepPolicy(afterMinutes: number | null): Promise<SleepPolicy>
  /** Event stream — receives events from the moment of subscription onward */
  subscribe(handler: (event: NormalizedEvent) => void): Unsubscribe
  onConnectionChange(handler: (state: ConnectionState) => void): Unsubscribe
}
