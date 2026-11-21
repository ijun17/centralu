import { z } from 'zod'
import {
  ApprovalDecision,
  ApprovalScope,
  Attachment,
  UsageHistoryBy,
  ProjectId,
  QuestionAnswer,
  SessionId,
  ToolName,
} from '../../entities.js'
import { machineParam } from '../machine-fields.js'
import { CreateSessionParams, UpdateSettingsParams } from '../session-params.js'
import { SUBAGENT_STEPS_PAGE } from '../sessions.js'

/** Params of the `sessions` methods, parsed by the host (docs/protocol.md §3). Results: ./sessions.results.ts */
export const sessionsParams = {
  'agents.createSession': CreateSessionParams,
  'agents.send': z.object({
    sessionId: SessionId,
    text: z.string(),
    attachments: z.array(Attachment).optional(),
  }),
  'agents.respondApproval': z.object({
    sessionId: SessionId,
    requestId: z.string(),
    decision: ApprovalDecision,
    scope: ApprovalScope.optional(),
    /** The "always allow" pattern, computed by the core and sent by the UI */
    matcher: z.string().optional(),
  }),
  /**
   * AskUserQuestion: the answers (all of them, when there are several questions) go back to the model as the tool's
   * result. Not an approval: what returns is content, not whether to run.
   */
  'agents.answerQuestion': z.object({
    sessionId: SessionId,
    requestId: z.string(),
    answers: z.array(QuestionAnswer),
  }),
  'agents.interrupt': z.object({ sessionId: SessionId }),
  /** Only asks (docs/protocol.md §3): the task leaves the live set through the next `background_tasks` event */
  'agents.stopBackgroundTask': z.object({ sessionId: SessionId, taskId: z.string() }),
  /** Running tasks stay: they are the tool's to end */
  'agents.clearBackgroundTasks': z.object({ sessionId: SessionId }),
  /**
   * Moves the session to the archive (#204). Nothing is destroyed until `trash.purge` / `trash.empty`; the two flags
   * record what that step removes.
   */
  'agents.deleteSession': z.object({
    sessionId: SessionId,
    /**
     * Kept by default: hours of an agent's work can live there, and a silent delete has no way back. The UI asks first
     * via `agents.worktreeStatus`. The worktree is removed at purge.
     */
    deleteWorktree: z.boolean().default(false),
    /**
     * The tool's own conversation file (measured 550MB for a codex rollout), deleted at purge. Kept by default: it is the
     * tool's, and the last way back into it. If deleting it fails, our deletion stops too: answering "deleted" while
     * the original exists is the worst outcome.
     */
    deleteExternal: z.boolean().default(false),
  }),
  /**
   * Archives as `agents.deleteSession` (worktree and tool file kept) only when the session is at rest and nothing it holds
   * would be lost (the Assistant's `delete_session` rule); otherwise nothing moves and `asks` says what would be lost
   * (empty when it was only busy, or is gone). An older host answers "Unknown method", and the window asks first.
   */
  'agents.archiveIfAtRest': z.object({
    sessionId: SessionId,
    /** As `agents.deleteSession`'s; ignored for a tool that cannot delete its file */
    deleteExternal: z.boolean().default(false),
  }),
  /**
   * Read only: the losses `agents.archiveIfAtRest` would answer in `asks` (`SessionTrash.lossesOf`), so the dialog shows
   * them however the worktree box is ticked. Empty for none, or a session that is gone.
   */
  'agents.archiveLosses': z.object({ sessionId: SessionId }),
  /**
   * agent_session delete of a child a hub's session started here with a worktree: its worktree on `worktreeBranch` goes
   * too when nothing would be lost (nothing uncommitted, every own commit on a remote or the trunk). `kept` says why it
   * stayed; `none`, no worktree. An older host answers "Unknown method", and the hub uses `agents.deleteSession`.
   */
  'agents.deleteAgentChild': z.object({ sessionId: SessionId, worktreeBranch: z.string().min(1) }),
  /** The Assistant's MCP server proposals; approving one registers it and restarts the Assistant */
  'agents.mcpProposals': z.object({}),
  'agents.resolveMcpProposal': z.object({ name: z.string(), approve: z.boolean() }),
  /** Assistant skills: deleting exists because a skill that can only be added is worse than none (#71) */
  'agents.skillProposals': z.object({}),
  'agents.resolveSkillProposal': z.object({ name: z.string(), approve: z.boolean() }),
  'agents.orchestratorSkills': z.object({}),
  'agents.deleteOrchestratorSkill': z.object({ name: z.string() }),
  /*
   * The same two under the role's new name. The window calls the old ones: it may be attached to an older host that
   * lacks these (docs/plans/assistant-rename.md §3.2)
   */
  'agents.assistantSkills': z.object({}),
  'agents.deleteAssistantSkill': z.object({ name: z.string() }),
  /**
   * An ended agent's handoff transcript, built from the store (plus a codex rollout's summary) without its tool. Written to
   * `<data>/handoff/<project id>/<session id>.md`, as `agents.exportHandoffNote`, and the path returned; `text` is for a
   * preview. Never written into the user's repository.
   */
  'agents.exportHandoffRecord': z.object({
    sessionId: SessionId,
    /** The successor's tool, for the transcript header's `codex → claude` */
    toTool: ToolName.optional(),
  }),
  /**
   * The agent's reply as its handoff note, placed by the host where `agents.exportHandoffRecord` writes: outside the
   * repository, which the agent could write only with more permission. The note is the last reply before the next person
   * message after the request, the first after `afterSeq`. Null: not yet (turn running or no reply), ask again.
   */
  'agents.exportHandoffNote': z.object({ sessionId: SessionId, afterSeq: z.number().int().nonnegative() }),
  /**
   * Where the agent will compact itself at its next start, as its host decides (its setting, over the model's window).
   * `tokens` null: nothing passed (off, or the window not read yet). An older host's "Unknown method" reads as not set.
   */
  'agents.autoCompact': z.object({ sessionId: SessionId }),
  /** Asked right before deleting a worktree. Null: not a worktree session */
  'agents.worktreeStatus': z.object({ sessionId: SessionId }),
  /** Restarts only the agent's process; the conversation stays */
  'agents.restartSession': z.object({ sessionId: SessionId }),
  'agents.resumeSession': z.object({ sessionId: SessionId }),
  /**
   * Continues a locked conversation on a copy (codex lets one place write a conversation), without closing the other
   * app. The original is untouched.
   */
  'agents.forkConversation': z.object({ sessionId: SessionId }),
  /**
   * Not part of `agents.updateSettings`: a settings change keeps the conversation, a tool switch cuts it (externalId is
   * per tool).
   */
  'agents.switchTool': z.object({ sessionId: SessionId, tool: ToolName }),
  /** Takes effect from the next turn */
  'agents.updateSettings': UpdateSettingsParams,
  /** The tool's own stored sessions for this project folder; `supported: false` comes with a reason */
  'agents.listExternalSessions': z.object({
    projectId: ProjectId,
    tool: ToolName,
    limit: z.number().default(30),
  }),
  'agents.capabilities': z.object({ tool: ToolName, ...machineParam }),
  'agents.detect': z.object({ ...machineParam }),
  /**
   * docs/protocol.md §3 "tool setup". A second call while one runs joins it; the host never starts one itself (no
   * download at startup).
   */
  'agents.installTool': z.object({ tool: ToolName, ...machineParam }),
  /** What it had downloaded is removed */
  'agents.cancelInstallTool': z.object({ tool: ToolName, ...machineParam }),
  /**
   * This host's machine only (docs/protocol.md §3 "tool setup"): the tool's redirect goes to the loopback of the machine
   * it runs on. Antigravity: ACP `authenticate`, waited up to 5 minutes.
   */
  'agents.signIn': z.object({ tool: ToolName }),
  /** Ends its process, and with it the one-shot listener */
  'agents.cancelSignIn': z.object({ tool: ToolName }),
  /** Cheap either way: an npm CLI's version is read from its `package.json`, no process */
  'agents.versions': z.object({ force: z.boolean().default(false), ...machineParam }),
  'agents.setAutoApplyVersions': z.object({ enabled: z.boolean(), ...machineParam }),
  /**
   * `keepQuiet`: also leave a session that spoke within the last minute, as the automatic move does, so a restart does
   * not land as someone reads an answer. The person's button omits it; the Assistant's `apply_agent_versions` sends it.
   */
  'agents.applyVersions': z.object({ ...machineParam, keepQuiet: z.boolean().optional() }),
  'agents.sleepPolicy': z.object({ ...machineParam }),
  'agents.setSleepPolicy': z.object({
    afterMinutes: z.number().int().positive().nullable(),
    ...machineParam,
  }),
  /**
   * The host reads it: the window cannot load a file path (docs/security-boundaries/desktop.md "Images a reply names").
   * `path` as the reply wrote it; the host resolves `~`, a path relative to the session's folder and a `file://` URL.
   */
  'messages.image': z.object({ sessionId: SessionId, path: z.string().min(1).max(4096) }),
  'messages.search': z.object({ query: z.string(), limit: z.number().optional() }),
  'sessions.reorder': z.object({ projectId: ProjectId, orderedIds: z.array(z.string()) }),
  'sessions.list': z.object({}),
  'sessions.rename': z.object({ sessionId: SessionId, name: z.string() }),
  // The name `sessions.setKind` is not reused (docs/protocol.md §4)
  'sessions.markRead': z.object({ sessionId: SessionId, seq: z.number() }),
  /**
   * Done on a session in `error`: rows up to `seq` are read, and it moves to `idle` (`cleared`) unless a newer row exists
   * (`newer`). Nothing is stopped or retried; the error line stays. The person's alone: an agent may not hide a failure.
   */
  'sessions.clearError': z.object({ sessionId: SessionId, seq: z.number() }),
  /**
   * Don't continue: leaves the stopped turn Centralu would continue (`Interruption.autoContinue`) to the person; `stopped`
   * false when nothing waited. Routed to the session's machine, which holds the wait. The person's alone.
   */
  'sessions.stopContinue': z.object({ sessionId: SessionId }),
  'messages.load': z.object({
    sessionId: SessionId,
    limit: z.number().default(200),
    beforeSeq: z.number().optional(),
  }),
  /** Read only when the person opens the card; `seq` is the step's number within that launch */
  'messages.subagent': z.object({
    sessionId: SessionId,
    parentCallId: z.string(),
    afterSeq: z.number().optional(),
    limit: z.number().default(SUBAGENT_STEPS_PAGE),
  }),
  'messages.subagentTrashed': z.object({ sessionId: SessionId, parentCallId: z.string() }),
  /** `ready: false` means the CLI is still starting, not that there are none */
  'agents.commands': z.object({ sessionId: SessionId }),
  /** What the tool reports through its official API; an older tool answers `supported: false` with a reason */
  'agents.models': z.object({ tool: ToolName, ...machineParam }),
  /** docs/agent-host/usage.md "Usage over time". Each host keeps its own record */
  'usage.history': z.object({
    /** ISO8601, inclusive */
    from: z.string(),
    /** ISO8601, exclusive */
    to: z.string(),
    groupBy: z.enum(['day', 'hour']),
    by: UsageHistoryBy,
    /** Absent: every tool */
    tool: ToolName.optional(),
    ...machineParam,
  }),
  'agents.usage': z.object({
    tool: ToolName,
    /** `false`: cache figures only, so a linked machine on the hub's account starts no reading nobody looks at */
    limits: z.boolean().optional(),
    /** `true`: wait for a read in flight (a `provisional` answer) instead of answering at once, so the screen need not poll */
    settle: z.boolean().optional(),
    ...machineParam,
  }),
  /**
   * Nothing readable leaves the host (no email, no organization id). `fingerprint` null: not logged in with an account,
   * or it does not say which; `loggedIn` null: the tool cannot tell.
   */
  'agents.account': z.object({ tool: ToolName, ...machineParam }),
  /**
   * docs/protocol.md §3 "trash". The Assistant's trash commands make these calls too, a purge only after the person's
   * card. `bytes` is shown because nothing deletes the archive itself. `unreached`: machines not read this time.
   */
  'trash.list': z.object({}),
  /** `machine` as `trash.list` gave it: a linked machine's record is read there */
  'trash.readRun': z.object({
    runId: z.string(),
    limit: z.number().default(200),
    beforeSeq: z.number().optional(),
    ...machineParam,
  }),
  /** All of one machine; the window sends one call per machine */
  'trash.purgeRuns': z.object({ runIds: z.array(z.string()).min(1), ...machineParam }),
  'trash.read': z.object({
    sessionId: SessionId,
    limit: z.number().default(200),
    beforeSeq: z.number().optional(),
  }),
  /** `project` is set when restoring registered a deleted project's folder again, which the screen has not heard of */
  'trash.restore': z.object({ sessionId: SessionId }),
  'trash.purge': z.object({ sessionId: SessionId }),
  'subagents.usage': z.object({}),
  /** A subagent still running goes on writing its new steps under its card */
  'subagents.trash': z.object({ sessionId: SessionId }),
  'trash.restoreSubagentSteps': z.object({ sessionId: SessionId }),
  /** `upTo` (docs/protocol.md §3) is exact: one session's moves are stamped strictly later than the one before */
  'trash.purgeSubagentSteps': z.object({ sessionId: SessionId, upTo: z.number() }),
  /** One that fails stays and is reported. Run records and subagent steps are left to the window (docs/protocol.md §3) */
  'trash.empty': z.object({}),
} as const
