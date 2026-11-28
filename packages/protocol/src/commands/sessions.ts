import { z } from 'zod'
import {
  AppId,
  ApprovalDetail,
  BackgroundTask,
  Interruption,
  PermissionPreset,
  Question,
  SessionActivity,
  SessionGoal,
  SessionId,
  SessionState,
  TokenUsage,
  ToolName,
} from '../entities.js'
import { machineField } from './machine-fields.js'

/** A session's role: one marker, so no reader judges it from `projectId === null` */
export const SessionKind = z.enum(['worker', 'orchestrator', 'coordinator', 'assistant'])
export type SessionKind = z.infer<typeof SessionKind>

/**
 * Whether a kind is the Assistant: sent as `'assistant'` since #2532, and as `'orchestrator'` by a linked machine of
 * beta.57 to beta.84, which a hub still connects (docs/plans/assistant-rename.md §3.4). Readers ask this (lint:
 * `guard/assistant-kind`).
 */
export function isAssistantKind(kind: unknown): boolean {
  return kind === 'orchestrator' || kind === 'assistant'
}

/** The Assistant or a coordinator: the seats that carry role text and are not shown to a hub */
export function isAssistantOrCoordinator(kind: unknown): boolean {
  return isAssistantKind(kind) || kind === 'coordinator'
}

/** The Assistant's kind as this build sends it: every release from beta.54 on parses it, and a link to an older one is refused (`MIN_SUPPORTED_VERSION`) */
export const ASSISTANT_KIND = 'assistant' satisfies SessionKind

export const SessionInfo = z.object({
  id: z.string(),
  /** Null for a session of no project (docs/domain-model.md §2.1); the Assistant's would go with a deleted project */
  projectId: z.string().nullable(),
  kind: SessionKind.default('worker'),
  tool: ToolName,
  externalId: z.string().nullable(),
  name: z.string(),
  autoNamed: z.boolean(),
  state: SessionState,
  lastReadSeq: z.number().default(0),
  lastSeq: z.number().default(0),
  createdAt: z.number(),
  waitingSince: z.number().nullable().default(null),
  /** False: the conversation continues only after a resume */
  live: z.boolean().default(true),
  model: z.string().nullable().default(null),
  /** Null when the model has no effort setting */
  effort: z.string().nullable().default(null),
  /** Null: the tool's default. Applies at the next wake: codex's turn/start has no slot for it (measured) */
  verbosity: z.string().nullable().default(null),
  /** Null: codex's default; applies at the next wake, as verbosity */
  serviceTier: z.string().nullable().default(null),
  permissionPreset: PermissionPreset.default('normal'),
  /** The conversation an imported session inherited; can differ from externalId, as the tool issues a new id on resume */
  importedFrom: z.string().nullable().default(null),
  /** Null: the project directory. Held so a resume returns to the same worktree, never silently unisolated */
  worktree: z
    .object({
      path: z.string(),
      branch: z.string(),
      /** HEAD at creation, the merge baseline: keeps a fresh branch from reading as merged */
      base: z.string().optional(),
    })
    .nullable()
    .default(null),
  /** Judged from git, not stored; a squash or rebase merge is invisible locally (measured), so it can stay false */
  worktreeMerged: z.boolean().default(false),
  /** Null: unknown (no gh, offline), not none. Read through gh, not stored; it sees the squash merges git cannot */
  worktreePr: z
    .object({ number: z.number(), state: z.enum(['open', 'merged', 'closed']), url: z.string() })
    .nullable()
    .default(null),
  /** Not stored: after a restart codex is asked again (thread/goal/get), and claude reports it at its next judgment */
  goal: SessionGoal.nullable().default(null),
  /** Running tasks, then ended ones with how they ended. Live-only: the tool process holds them, a new one has none */
  backgroundTasks: z.array(BackgroundTask).default([]),
  /**
   * The agent CLI version the session's process runs, null with no process or unknown. Claude reports it in its init
   * (`claude_code_version`), the Codex app-server in its `initialize` answer; until then, and for a process the keeper
   * kept, it is the version installed at start. Compared with `AgentVersions.installed`.
   */
  agentVersion: z.string().nullable().default(null),
  /** A coordinator's view allowlist; the host enforces it, not app code, which can be turned off */
  scopeSessionIds: z.array(z.string()).nullable().default(null),
  /** Role text pinned at creation, on the row so restart and resume reapply it (as systemPromptAppend) */
  roleAppend: z.string().nullable().default(null),
  /**
   * The app that created this session: the host sets it from the calling app's registered id, never the app. Where a
   * session with no project stands in the sidebar: docs/apps/views.md "Pinned, in the main area".
   */
  appId: AppId.nullable().default(null),
  /**
   * The manager this session hangs under; null is top-level. A worktree session always has one, against orphaned
   * worktrees (Vibe Kanban's top documented failure). On the row, so the link outlives the tool's conversation.
   */
  parentSessionId: z.string().nullable().default(null),
  /**
   * The same-project session that started this one (`start_agent`); a cross-project ask keeps its asker in the
   * conversation's `from`. What an older peer reads: docs/protocol.md §3.3 ("Fields whose meaning moved").
   */
  askedBy: z.string().nullable().optional(),
  /** The session this one was forked from (a busy session's copy of its conversation); the sidebar hangs it there */
  forkedFrom: z.string().nullable().optional(),
  /** Started by a session on a linked computer (`CreateSessionParams.fromHub`): row and header show its preset */
  startedFromHub: z.boolean().optional(),
  ...machineField,
  /**
   * The hub could not reach this session's machine and answered from what it last heard. `live` is then last-known,
   * so the UI neither drops nor wakes the session; it waits for that machine's `machine_resync`.
   */
  unreachable: z.boolean().optional(),
  /**
   * Live-only, from host memory. Without it a list read after a reconnect shows waiting_approval with no card and no
   * requestId, and the agent stays blocked (measured). After a host restart the fact is gone, so the default is right.
   */
  pendingApproval: z.object({ requestId: z.string(), detail: ApprovalDetail }).nullable().default(null),
  /** Stored, except `reconnecting` (the running process); a value this build cannot read drops alone, not the row */
  interruption: Interruption.nullable().optional().catch(null),
  pendingQuestions: z.array(z.object({ requestId: z.string(), questions: z.array(Question) })).default([]),
  activity: SessionActivity.nullable().default(null),
  limit: z
    .object({
      resumeAt: z.string().optional(),
      usedPercent: z.number().optional(),
      windowMins: z.number().optional(),
      /** A Codex credits or spend limit: it does not reset with time, so Centralu never continues it by itself */
      credits: z.boolean().optional(),
    })
    .nullable()
    .default(null),
  usage: TokenUsage.nullable().default(null),
  /** Stored, unlike the live-only fields: it describes the conversation, which outlives the process; null: never reported */
  context: z
    .object({
      used: z.number(),
      /** The model's full window when known (`capped` absent), else the tool's own reading of it (`contextShare`) */
      window: z.number(),
      exactness: z.enum(['exact', 'estimate']),
      /** `window` is a floor under the model's window, not the window itself */
      capped: z.boolean().optional(),
      /** The size in tokens at which the session's process compacts by itself, when Centralu's control started it */
      compactAt: z.number().optional(),
    })
    .nullable()
    .default(null),
})
export type SessionInfo = z.infer<typeof SessionInfo>

/** The fields the state rule writes (`applySessionState`), also read from a hub's copy of a linked machine's sessions */
export const LiveStateFields = SessionInfo.pick({ state: true, waitingSince: true, pendingApproval: true, pendingQuestions: true, activity: true, limit: true })
export type LiveStateFields = z.infer<typeof LiveStateFields>

/**
 * How a settings change reached the running process: `restarted` (an idle session's process was replaced),
 * `after_turn` (replaced once the running turn ends), `saved` (no process, or it already runs with these values).
 */
export const SettingsApplied = z.enum(['restarted', 'after_turn', 'saved'])
export type SettingsApplied = z.infer<typeof SettingsApplied>
export const UpdateSettingsResult = SessionInfo.extend({ applied: SettingsApplied.optional() })
export type UpdateSettingsResult = z.infer<typeof UpdateSettingsResult>

/** The live-only fields' initial values, one list so an added field cannot be left out at one spot that builds a row */
export function sessionLiveDefaults(): Pick<
  SessionInfo,
  | 'pendingApproval'
  | 'pendingQuestions'
  | 'activity'
  | 'limit'
  | 'usage'
  | 'context'
  | 'worktreeMerged'
  | 'worktreePr'
  | 'goal'
  | 'backgroundTasks'
  | 'agentVersion'
> {
  return {
    pendingApproval: null,
    pendingQuestions: [],
    activity: null,
    limit: null,
    usage: null,
    context: null,
    worktreeMerged: false,
    worktreePr: null,
    goal: null,
    backgroundTasks: [],
    agentVersion: null,
  }
}

export const StoredMessage = z.object({
  sessionId: z.string(),
  seq: z.number(),
  role: z.enum(['user', 'assistant', 'system']),
  // `app_view`: an app's screen stood up (or was refused) under this tool card; no body, only a placeholder's place
  kind: z.enum(['text', 'tool_call', 'tool_result', 'approval', 'marker', 'image', 'reasoning', 'app_view']),
  payload: z.unknown(),
  ts: z.number(),
})
export type StoredMessage = z.infer<typeof StoredMessage>

/**
 * A subagent's steps per `messages.subagent` page; steps come as cards (`summary` only), so a page is at most a few
 * hundred kilobytes. 251 measured subagent runs averaged 80 tool calls, so most fit in one page.
 */
export const SUBAGENT_STEPS_PAGE = 500

/**
 * A session in the archive, as Settings lists it. The wire keeps "trash" (the protocol only grows); people and agents
 * read "archive". Only Settings, or the Assistant after the person's card, deletes for good. It lists what each one
 * holds, since an archive of names only is a hidden store with no way out (FR-20).
 */
export const TrashedSession = z.object({
  id: SessionId,
  name: z.string(),
  tool: ToolName,
  /** `exists` false: the project was deleted; restoring registers the folder again, and refuses if it is gone */
  project: z
    .object({ id: z.string(), name: z.string(), path: z.string().nullable(), exists: z.boolean() })
    .nullable(),
  deletedAt: z.number(),
  messages: z.number(),
  /** Its messages in the store, and its attachments and handoff note in the data folder */
  bytes: z.number(),
  /** The tool's own file (Claude JSONL, Codex rollout): `remove` if deleting for good deletes it, else `keep`, or `none` */
  conversationFile: z.enum(['remove', 'keep', 'none']),
  /** Kept in place while archived; `remove` if deleting for good removes it */
  worktree: z.object({ path: z.string(), branch: z.string(), remove: z.boolean() }).nullable(),
  ...machineField,
})
export type TrashedSession = z.infer<typeof TrashedSession>

/**
 * An app-agent run's record. A `run_agent` session that ends cleanly with nobody taking part is deleted; this keeps
 * the request, the answer and the whole conversation, self-contained so it outlives the run log line and the project.
 * It goes when the person deletes it or the run log's 30-day retention passes.
 */
export const TrashedRun = z.object({
  runId: z.string(),
  /** `projectName` is null for an app in the user folder */
  app: z.object({
    id: z.string(),
    name: z.string(),
    projectId: z.string().nullable(),
    projectName: z.string().nullable(),
  }),
  /** `<app> · agent HH:MM` */
  sessionName: z.string(),
  tool: ToolName,
  status: z.string(),
  startedAt: z.number(),
  /** When the session was deleted and this record kept */
  keptAt: z.number(),
  durationMs: z.number().nullable(),
  tokens: z.object({ input: z.number(), output: z.number() }).nullable(),
  /** The first few hundred characters of the app's request, to tell the records apart */
  requestPreview: z.string(),
  messages: z.number(),
  bytes: z.number(),
  /** The run, and the delete, happen on the machine where its app runs */
  ...machineField,
})
export type TrashedRun = z.infer<typeof TrashedRun>

/**
 * A session's native subagent steps (Claude Code's `Agent`, Codex's `spawn_agent`): often most of a store (measured:
 * 46 MB of 237 MB, from one session in use), so Settings shows them per session and archives them alone.
 * `runs` counts the launch cards, `steps` every run's steps, `bytes` their size in the store.
 */
export const SubagentStepsHeld = z.object({
  sessionId: SessionId,
  name: z.string(),
  tool: ToolName,
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  runs: z.number(),
  steps: z.number(),
  bytes: z.number(),
  ...machineField,
})
export type SubagentStepsHeld = z.infer<typeof SubagentStepsHeld>

/** A staying session's archived subagent steps; `deletedAt` is the latest move, and only Settings deletes for good */
export const TrashedSubagentSteps = SubagentStepsHeld.extend({ deletedAt: z.number() })
export type TrashedSubagentSteps = z.infer<typeof TrashedSubagentSteps>
