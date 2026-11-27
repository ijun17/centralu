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
import { MessageFile, MessageImage } from '../files.js'
import { UnreachedMachine } from '../../machines.js'
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

/** Results of the `sessions` methods, read through `parseRpcResult`. Params and what each method does: ./sessions.params.ts */
export const sessionsResults = {
  /** `worktreeBase`: where a new worktree forked from, and what could not be done to make it current. Absent from an older host */
  'agents.createSession': SessionInfo.extend({ worktreeBase: z.string().optional() }),
  'agents.send': z.object({ ok: z.literal(true) }),
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
  'agents.assistantSkills': z.object({
    skills: z.array(z.object({ name: z.string(), content: z.string() })),
  }),
  'agents.deleteAssistantSkill': z.object({ ok: z.literal(true) }),
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
      /** git did not answer: `dirty` is true because clean is not known */
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
    /** Someone else holds the conversation. The screen offers the fork on this alone, never by parsing `reason` */
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
  'messages.resolveFile': MessageFile,
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
  'sessions.stopContinue': z.object({ ok: z.literal(true), stopped: z.boolean() }),
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
    /** With `supported: false`: the tool cannot report limits at all, not a failed read (docs/protocol.md §3 "usage") */
    notReported: z.boolean().optional(),
    /**
     * Stands in for a read of the tool's own command still running: `usage` is empty (slower than the host waits) or the
     * old answer with its `totals.asOf`. `settle` waits for the read.
     */
    provisional: z.boolean().optional(),
    /** On the hub's answer for a linked machine: `usage` is the hub's own, both on one account; the meter says so */
    sameAccountAsHub: z.boolean().optional(),
    /** Counted by this host (docs/agent-host/prompt-cache.md), whatever `supported` says. Absent from an older host */
    cache: CacheStats.optional(),
  }),
  'agents.account': z.object({ loggedIn: z.boolean().nullable(), fingerprint: z.string().nullable() }),
  'trash.list': z.object({
    sessions: z.array(TrashedSession),
    runs: z.array(TrashedRun).default([]),
    bytes: z.number(),
    unreached: z.array(UnreachedMachine).optional(),
    /** Steps moved without their session, most recent first, counted in `bytes` (docs/protocol.md §3). Absent from an older host */
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
    unreached: z.array(UnreachedMachine).optional(),
  }),
  'subagents.trash': z.object({ steps: z.number(), bytes: z.number() }),
  'trash.restoreSubagentSteps': z.object({ ok: z.literal(true) }),
  'trash.purgeSubagentSteps': z.object({ ok: z.literal(true) }),
  'trash.empty': z.object({
    purged: z.number(),
    failed: z.array(z.object({ sessionId: z.string(), name: z.string(), error: z.string() })),
  }),
} as const
