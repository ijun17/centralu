import { z } from 'zod'
import {
  AdapterCapabilities,
  AgentVersions,
  CacheStats,
  UsageHistory,
  ExternalSession,
  ModelOption,
  SleepPolicy,
  ToolSetup,
  ToolStatus,
  UsageSnapshot,
} from '../../entities.js'
import { MessageImage } from '../files.js'
import { CommandInfo, ProjectInfo } from '../projects.js'
import {
  SessionInfo,
  StoredMessage,
  TrashedRun,
  SubagentStepsHeld,
  TrashedSession,
  TrashedSubagentSteps,
  UpdateSettingsResult,
} from '../sessions.js'

/** The results of the `sessions` methods, which a client reads through `parseRpcResult`. Their parameters, and what each method is for: ./sessions.params.ts */
export const sessionsResults = {
  'agents.createSession': SessionInfo,
  'agents.send': z.object({ ok: z.literal(true) }),
  'agents.reportOwed': z.object({
    owed: z.object({ callerId: z.string(), callerName: z.string() }).nullable(),
  }),
  'agents.respondApproval': z.object({ ok: z.literal(true) }),
  'agents.answerQuestion': z.object({ ok: z.literal(true) }),
  'agents.interrupt': z.object({ ok: z.literal(true) }),
  'agents.stopBackgroundTask': z.object({ ok: z.literal(true) }),
  'agents.clearBackgroundTasks': z.object({ ok: z.literal(true) }),
  'agents.deleteSession': z.object({ ok: z.literal(true) }),
  'agents.archiveIfAtRest': z.union([
    z.object({ archived: z.literal(true) }),
    z.object({ archived: z.literal(false), asks: z.array(z.string()) }),
  ]),
  'agents.archiveLosses': z.object({ asks: z.array(z.string()) }),
  'agents.deleteAgentChild': z.object({
    worktree: z.enum(['removed', 'kept', 'none']),
    path: z.string().optional(),
    branch: z.string().optional(),
    why: z.string().optional(),
    note: z.string().optional(),
  }),
  'agents.mcpProposals': z.object({
    proposals: z.array(
      z.object({
        name: z.string(),
        command: z.string(),
        args: z.array(z.string()),
        why: z.string().optional(),
      }),
    ),
  }),
  'agents.resolveMcpProposal': z.object({ ok: z.literal(true) }),
  'agents.skillProposals': z.object({
    proposals: z.array(z.object({ name: z.string(), content: z.string(), why: z.string().optional() })),
  }),
  'agents.resolveSkillProposal': z.object({ ok: z.literal(true) }),
  'agents.orchestratorSkills': z.object({
    skills: z.array(z.object({ name: z.string(), content: z.string() })),
  }),
  'agents.deleteOrchestratorSkill': z.object({ ok: z.literal(true) }),
  'agents.exportHandoffRecord': z.object({ text: z.string(), path: z.string() }),
  'agents.exportHandoffNote': z.object({ text: z.string(), path: z.string() }).nullable(),
  'agents.autoCompact': z.object({
    controlled: z.boolean(),
    share: z.number(),
    tokens: z.number().nullable(),
  }),
  'agents.worktreeStatus': z
    .object({
      path: z.string(),
      branch: z.string(),
      dirty: z.boolean(),
      changedFiles: z.number(),
      /** At least `changedFiles` (the host's count stopped at its cap) */
      more: z.boolean().optional(),
      /** git did not answer: `dirty` is true because clean is not known (#850 review) */
      unknown: z.boolean().optional(),
    })
    .nullable(),
  'agents.restartSession': z.object({
    session: SessionInfo,
    resumed: z.boolean(),
    reason: z.string().optional(),
  }),
  'agents.resumeSession': z.object({
    session: SessionInfo,
    resumed: z.boolean(),
    reason: z.string().optional(),
    /**
     * **Someone else holds** this conversation. The screen decides which fork to offer based
     * on this value alone — it never parses the reason string (doing that would make the
     * wording a contract that breaks silently if it is ever edited).
     */
    lockedElsewhere: z.boolean().optional(),
  }),
  'agents.forkConversation': z.object({
    session: SessionInfo,
    resumed: z.boolean(),
    reason: z.string().optional(),
  }),
  'agents.switchTool': SessionInfo,
  'agents.updateSettings': UpdateSettingsResult,
  'agents.listExternalSessions': z.object({
    supported: z.boolean(),
    reason: z.string().optional(),
    sessions: z.array(ExternalSession),
  }),
  'agents.capabilities': AdapterCapabilities,
  'agents.detect': z.array(ToolStatus),
  'agents.installTool': ToolSetup,
  'agents.cancelInstallTool': ToolSetup,
  'agents.signIn': ToolSetup,
  'agents.cancelSignIn': ToolSetup,
  'agents.versions': AgentVersions,
  'agents.setAutoApplyVersions': AgentVersions,
  'agents.applyVersions': z.object({
    restarted: z.array(z.string()).default([]),
    busy: z.array(z.string()).default([]),
  }),
  'agents.sleepPolicy': SleepPolicy,
  'agents.setSleepPolicy': SleepPolicy,
  'messages.image': MessageImage,
  'messages.search': z.array(z.object({ sessionId: z.string(), seq: z.number(), snippet: z.string() })),
  'sessions.reorder': z.array(SessionInfo),
  'sessions.list': z.array(SessionInfo),
  'sessions.rename': z.object({ ok: z.literal(true) }),
  'sessions.markRead': z.object({ ok: z.literal(true) }),
  'sessions.clearError': z.object({
    ok: z.literal(true),
    cleared: z.boolean(),
    newer: z.boolean().default(false),
  }),
  'messages.load': z.array(StoredMessage),
  'messages.subagent': z.array(StoredMessage),
  'messages.subagentTrashed': z.object({ steps: z.number() }),
  'agents.commands': z.object({ ready: z.boolean(), commands: z.array(CommandInfo) }),
  'agents.models': z.object({
    supported: z.boolean(),
    reason: z.string().optional(),
    models: z.array(ModelOption),
  }),
  'usage.history': UsageHistory,
  'agents.usage': z.object({
    supported: z.boolean(),
    reason: z.string().optional(),
    usage: UsageSnapshot.nullable(),
    /**
     * With `supported: false`: the tool has no way to report limits at all (its adapter has none), as against a read
     * that failed, which also answers `supported: false` (not logged in, a timeout). The screen draws only this one as
     * a plain dimmed ring (#1616); a host that predates it sends neither, and its failed and never answers look alike,
     * so both stay the unknown they were. Absent otherwise.
     */
    notReported: z.boolean().optional(),
    /**
     * Set on the hub's answer for a linked machine when `usage` is this computer's own because both are logged in to
     * the same account (#726); the meter says so. Absent otherwise, and from a host that predates it.
     */
    sameAccountAsHub: z.boolean().optional(),
    /**
     * The prompt cache over the last hours, counted by this host from its sessions' requests (docs/agent-host.md
     * §6.1). Independent of `supported`: a limit the tool would not tell does not hide what the host counted.
     * Absent from a host that predates it.
     */
    cache: CacheStats.optional(),
  }),
  'agents.account': z.object({ loggedIn: z.boolean().nullable(), fingerprint: z.string().nullable() }),
  'trash.list': z.object({
    sessions: z.array(TrashedSession),
    runs: z.array(TrashedRun).default([]),
    bytes: z.number(),
    unreached: z.array(z.object({ machineId: z.string(), name: z.string() })).optional(),
    /**
     * The subagent steps moved to the trash without their session (#418), most recently moved first. Their bytes
     * are in `bytes`. `trash.empty` leaves them: the window deletes each one it listed (`trash.purgeSubagentSteps`).
     * Absent from a host before it.
     */
    subagentSteps: z.array(TrashedSubagentSteps).optional(),
  }),
  'trash.readRun': z.object({
    request: z.string(),
    answer: z.string(),
    output: z.unknown().optional(),
    messages: z.array(StoredMessage),
  }),
  'trash.purgeRuns': z.object({ purged: z.number() }),
  'trash.read': z.array(StoredMessage),
  'trash.restore': z.object({ session: SessionInfo, project: ProjectInfo.nullable() }),
  'trash.purge': z.object({ ok: z.literal(true) }),
  'subagents.usage': z.object({
    sessions: z.array(SubagentStepsHeld),
    unreached: z.array(z.object({ machineId: z.string(), name: z.string() })).optional(),
  }),
  'subagents.trash': z.object({ steps: z.number(), bytes: z.number() }),
  'trash.restoreSubagentSteps': z.object({ ok: z.literal(true) }),
  'trash.purgeSubagentSteps': z.object({ ok: z.literal(true) }),
  'trash.empty': z.object({
    purged: z.number(),
    failed: z.array(z.object({ sessionId: z.string(), name: z.string(), error: z.string() })),
  }),
} as const
