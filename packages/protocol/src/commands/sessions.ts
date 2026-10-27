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

/**
 * A session's role (#13).
 *
 * The judgment that `projectId === null` means orchestrator used to be scattered across six
 * places, and this field gathers that scattering into a single marker. Once the project
 * orchestrator was discontinued (2026-09-01), the two judgments became equivalent again, but the
 * marker stays — having the judgment live in one place is still better, and a migration to
 * revert it would carry risk with nothing to gain.
 */
export const SessionKind = z.enum(['worker', 'orchestrator', 'coordinator'])
export type SessionKind = z.infer<typeof SessionKind>

export const SessionInfo = z.object({
  id: z.string(),
  /**
   * The project this session belongs to. Null for a session that belongs to none: the orchestrator
   * (it crosses projects, and attached to one it would die along with that project when the
   * project is deleted), a coordinator, the builder and agent sessions of a user-folder app, and a
   * session in the trash (its project is kept in the trash record). docs/domain-model.md §2.1.
   */
  projectId: z.string().nullable(),
  /** Whether this is a worker or an orchestrator. Defaults to worker — old frames do not have this field */
  kind: SessionKind.default('worker'),
  tool: ToolName,
  externalId: z.string().nullable(),
  name: z.string(),
  autoNamed: z.boolean(),
  state: SessionState,
  lastReadSeq: z.number().default(0),
  lastSeq: z.number().default(0),
  createdAt: z.number(),
  /** When waiting began — used for inbox ordering and showing elapsed time (FR-12/15) */
  waitingSince: z.number().nullable().default(null),
  /** Whether the process is alive. If false, resuming is required to continue the conversation (FR-10) */
  live: z.boolean().default(true),
  /** Can be changed mid-conversation (FR-7) — chosen from the session header */
  model: z.string().nullable().default(null),
  /** Reasoning effort. Null if the model does not support it */
  effort: z.string().nullable().default(null),
  /**
   * Response length (#54). Null means the tool's default.
   *
   * Unlike effort, this takes effect **the next time the session wakes up** — codex's
   * turn/start has no slot for it, it only flows through the thread config (confirmed absent
   * from generated/v2/TurnStartParams.ts — measured). The manager's drift restart already knows
   * that path, so the plumbing is the same as for effort.
   */
  verbosity: z.string().nullable().default(null),
  /** Response speed (same plumbing as #54). Null means codex's default. Like verbosity, it applies the next time the session wakes up */
  serviceTier: z.string().nullable().default(null),
  permissionPreset: PermissionPreset.default('normal'),
  /**
   * The identifier of the prior conversation this session inherited (only for sessions created
   * by importing). Can differ from externalId, since the tool issues a new identifier when it
   * resumes.
   */
  importedFrom: z.string().nullable().default(null),
  /**
   * The worktree this session runs in. Null means it runs directly in the project directory
   * (the default).
   *
   * Why the path is held here: on resume, the session must return to **the same worktree**.
   * Falling back to the project path would silently break isolation — the person would still
   * believe it is isolated.
   */
  worktree: z
    .object({
      path: z.string(),
      branch: z.string(),
      /** The HEAD sha at creation time (#69) — the baseline for merge detection. Keeps a freshly created branch from reading as merged. */
      base: z.string().optional(),
    })
    .nullable()
    .default(null),
  /**
   * Whether this worktree branch's work has fully landed in the project trunk (#69).
   *
   * Not stored, since it is a fact derived from git — it is re-judged on startup and whenever
   * the project's git state is refreshed. Squash and rebase merges cannot be detected locally
   * (measured), so this value can stay false even after the work has landed. The cost of that is
   * a single badge: the person can always delete it manually regardless.
   */
  worktreeMerged: z.boolean().default(false),
  /**
   * The pull request for this worktree branch (#76 stage 3). Null means "unknown," not "none."
   *
   * Not stored, since it is a derived fact measured through the gh CLI (same principle as
   * worktreeMerged). The reason this field exists is the blind spot above: squash and rebase
   * merges cannot be detected locally, and squash is the dominant outcome for a GitHub PR. A
   * PR's MERGED state is a fact recorded by the server, so it has no such blind spot. If gh is
   * missing or the machine is offline, this value simply stays null — it is only the basis for
   * one badge.
   */
  worktreePr: z
    .object({ number: z.number(), state: z.enum(['open', 'merged', 'closed']), url: z.string() })
    .nullable()
    .default(null),
  /**
   * The goal set on the session (2026-09-07). Not stored, since it is a derived fact judged by
   * the tool — after a restart, codex re-asks via thread/goal/get, and claude learns it again at
   * the next judgment.
   */
  goal: SessionGoal.nullable().default(null),
  /**
   * The agent's background work (#290): every running task, then the ended ones still listed with how they ended.
   * Live-only like `goal` — the tool process holds these tasks, and a new process starts with none.
   */
  backgroundTasks: z.array(BackgroundTask).default([]),
  /**
   * The version of the agent CLI this session's process runs (#297), or null when it has no process or the version is
   * not known. Claude reports it in its init message (`claude_code_version`), the Codex app-server in its `initialize`
   * answer; until then, and for a process the keeper kept, it is the version installed when the process was started.
   * Live-only, like `goal`: a new process reports its own. Compared with `AgentVersions.installed` to say a session runs
   * an older CLI than the one installed.
   */
  agentVersion: z.string().nullable().default(null),
  /**
   * A coordinating session's view allowlist (#80, #81 — unnamed core handle #1).
   *
   * The sessions visible to the orchestrator tool of a session with kind='coordinator'. The host
   * enforces this (enforcement does not live in app code, which can be turned off). There is no
   * concept of "task" in the core — this is purely the physical fact of visibility.
   */
  scopeSessionIds: z.array(z.string()).nullable().default(null),
  /**
   * The role text pinned at creation time (#80, #81 — unnamed core handle #2).
   *
   * Lives on the row because it must be reapplied on restart or resume. The core does not know
   * what the content means — only the app does. The core just carries it as systemPromptAppend
   * when spawning.
   */
  roleAppend: z.string().nullable().default(null),
  /**
   * The app that created this session (#81 — unnamed core handle #3, requested by the person on
   * 2026-09-09).
   *
   * All the core knows is **a single id line naming the owner**; only the app knows what it
   * means. A session of a project stands in that project's sidebar list whatever this says; a
   * session with no project stands under the row of the user-folder app this names, whether that
   * app is running or not (docs/apps.md §6.2). One that names no listed app has no sidebar row and
   * is reached through search, the palette and the inbox.
   *
   * An app cannot write this itself: the value comes from the registered id of the app that
   * called the tool.
   */
  appId: AppId.nullable().default(null),
  /**
   * The manager session this session hangs off of (#69). Null means top-level (the usual case).
   *
   * A worktree session must always stand under a manager — without that attachment, the
   * number-one documented failure in this category happens (an orphaned worktree: Vibe Kanban
   * #1764/#2335/#1571). A manager is not a new kind of session, just an ordinary session with
   * children, and the sidebar tree is drawn entirely from this one field.
   *
   * Why it lives on the row rather than in the conversation: the attachment must outlive the
   * session process. Even if the tool-side conversation disappears (deleted externally), this
   * link remains and the relationship is restored.
   */
  parentSessionId: z.string().nullable().default(null),
  /**
   * The same-project session that started this agent (`start_agent`, #561). Person-created and app
   * sessions have no owner. Cross-project tasks keep their asking session in the conversation's
   * `from` instead (#614).
   *
   * **The meaning moved, the field did not (#844).** Until #614 it named the session of another
   * project that asked for this one through ask_project (#371), and store step v48 copied a former
   * worktree manager's `parent_session_id` into it. Store step v55 clears the cross-project rows
   * (the host start did until #844). A window of beta.20 or before reads a start_agent child as
   * "asked by" its parent, which is now what it means; a host of beta.20 or before still writes the
   * old meaning, and a row it writes after v55 keeps it (agent-host.md §5.1).
   */
  askedBy: z.string().nullable().optional(),
  /**
   * The session whose conversation this one was forked from (#677): another session asked a busy session for work and
   * chose a fork, a sub-session starting from a copy of its conversation. The sidebar hangs it under that session;
   * the requester is `askedBy`. Absent from a host that predates it.
   */
  forkedFrom: z.string().nullable().optional(),
  /**
   * A session on a linked computer (this host's hub) started this one (#1273, `CreateSessionParams.fromHub`): the
   * sidebar row and the header show its preset, here and on that computer. Absent from a host that predates it.
   */
  startedFromHub: z.boolean().optional(),
  ...machineField,
  /**
   * The hub could not reach this session's machine, and answered from what it last heard (#82): the
   * headers mirror. `live` is then the last-known value, not a fact, so the UI must neither drop the
   * session nor try to wake it; it waits for that machine's `machine_resync`.
   */
  unreachable: z.boolean().optional(),
  /**
   * **Facts valid only while the process is alive** — these come from the host's memory, not
   * the database.
   *
   * While these fields were missing, refetching the list after a reconnect or app restart could
   * show state=waiting_approval with **no payload to draw the card from**, so the approval card
   * never appeared, and with no requestId there was no way to respond — the agent stayed blocked
   * forever (measured). If the host process itself restarts, the fact really is gone, so the
   * default (null/[]) is correct.
   */
  pendingApproval: z.object({ requestId: z.string(), detail: ApprovalDetail }).nullable().default(null),
  /**
   * Why the last turn did not run to its end (#698), until the session works again. Stored (`sessions.interruption`,
   * store v53) except for `reconnecting`, which describes the running process. Absent from a host that predates it;
   * a value this build cannot read is dropped rather than failing the whole row.
   */
  interruption: Interruption.nullable().optional().catch(null),
  pendingQuestions: z.array(z.object({ requestId: z.string(), questions: z.array(Question) })).default([]),
  activity: SessionActivity.nullable().default(null),
  limit: z
    .object({
      resumeAt: z.string().optional(),
      usedPercent: z.number().optional(),
      windowMins: z.number().optional(),
    })
    .nullable()
    .default(null),
  usage: TokenUsage.nullable().default(null),
  /**
   * How full the conversation's context is — **the one above that survives a restart** (#48).
   *
   * It sits with the live-only fields because it arrives the same way (an event, once a turn),
   * but it is not a fact about our process: it describes the conversation, which belongs to the
   * tool and outlives us. So the store writes it down and reads it back (schema v17), and
   * `null` here means "this session has never reported one" rather than "we forgot".
   */
  context: z
    .object({
      used: z.number(),
      /** The model's full window when known (`capped` absent), else the tool's own reading of it (#1553, `contextShare`) */
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

/**
 * When a settings change reached the running process (#164) — so the screen can say exactly
 * what happened.
 *
 *   restarted    The tool process was just replaced (an idle session)
 *   after_turn   The running turn is not interrupted — the process is replaced once this turn ends (working, waiting_approval)
 *   saved        Only saved — either there is no running process (this value appears when the session wakes up) or it is already running with the same values
 */
export const SettingsApplied = z.enum(['restarted', 'after_turn', 'saved'])
export type SettingsApplied = z.infer<typeof SettingsApplied>
export const UpdateSettingsResult = SessionInfo.extend({ applied: SettingsApplied.optional() })
export type UpdateSettingsResult = z.infer<typeof UpdateSettingsResult>

/**
 * The initial values for the live-only fields. Used when assembling a SessionInfo from a store
 * row or a new session — listing them by hand risks a build that still compiles with one spot
 * left out whenever a field is added.
 */
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
    // Merge status (#69) also lives here — it is a fact derived from git, re-judged on startup
    worktreeMerged: false,
    // PR status (#76 stage 3) follows the same principle — measured again through gh
    worktreePr: null,
    // The goal (2026-09-07) follows the same principle — the tool tells us again
    goal: null,
    // Background tasks (#290) live in the tool process, and a new one starts with none
    backgroundTasks: [],
    // The CLI version (#297) belongs to the process too; a new one reports its own
    agentVersion: null,
  }
}

export const StoredMessage = z.object({
  sessionId: z.string(),
  seq: z.number(),
  role: z.enum(['user', 'assistant', 'system']),
  /*
   * `app_view`: the fact that some app's screen stood up (or was refused) under this tool card
   * (M4 B-1). There is no body — this is only the basis for a reopened UI to plant a placeholder
   * there (`app_view` in events.ts).
   */
  kind: z.enum(['text', 'tool_call', 'tool_result', 'approval', 'marker', 'image', 'reasoning', 'app_view']),
  payload: z.unknown(),
  ts: z.number(),
})
export type StoredMessage = z.infer<typeof StoredMessage>

/**
 * How many of a subagent's steps one `messages.subagent` page carries (#222). A launch card's steps come as cards
 * (`summary` only), so a page is at most a few hundred kilobytes: 251 measured subagent runs averaged 80 tool calls
 * each, so most fit in one page.
 */
export const SUBAGENT_STEPS_PAGE = 500

/**
 * A session in the session archive (#204), as Settings lists it. The concept was called "the trash" until #1404;
 * the names `Trashed*` and `trash.*` stay because the protocol only grows. Say "archive" in anything a person or an
 * agent reads.
 *
 * Archiving a session moves it here instead of destroying it; only Settings deletes it for good (or the orchestrator, after the person's card, #1219). The list says what
 * each one still holds and what goes with it, because an archive that shows names but not contents is the hidden store
 * the retired hide-a-session feature was (FR-20): it had a way in and no way out, and nobody could see what it kept.
 */
export const TrashedSession = z.object({
  id: SessionId,
  name: z.string(),
  tool: ToolName,
  /**
   * Where it came from, null for a session that had no project. `exists` is false when that project has been
   * deleted since: restoring then registers the folder again, and refuses if the folder is gone too.
   */
  project: z
    .object({ id: z.string(), name: z.string(), path: z.string().nullable(), exists: z.boolean() })
    .nullable(),
  deletedAt: z.number(),
  messages: z.number(),
  /** What it takes on this machine: its messages in the store, and its attachments and handoff note in the data folder */
  bytes: z.number(),
  /**
   * The tool's own conversation file (Claude JSONL, Codex rollout), which stays where the tool keeps it while the
   * session is in the trash: `remove` if deleting for good deletes it too, as the person chose; `keep` if it stays
   * in the tool; `none` if the session never had one.
   */
  conversationFile: z.enum(['remove', 'keep', 'none']),
  /** The session's worktree, kept in place while it is in the trash; `remove` if deleting for good removes it */
  worktree: z.object({ path: z.string(), branch: z.string(), remove: z.boolean() }).nullable(),
  ...machineField,
})
export type TrashedSession = z.infer<typeof TrashedSession>

/**
 * An app-agent run kept in the trash (#378), as Settings lists it.
 *
 * A session an app stood up with `run_agent` is deleted once its run ends cleanly and nobody took part in it; what it
 * did stays here as the run's record: the app's request, the answer, and the whole conversation with its tool calls
 * (owner decision, 2026-10-06). The record is self-contained, so it outlives the app's run log line and the project.
 * It leaves the store when the person deletes it here, or when the run log's 30-day retention passes.
 */
export const TrashedRun = z.object({
  runId: z.string(),
  /** The app that asked; `projectName` is null for an app in the user folder */
  app: z.object({
    id: z.string(),
    name: z.string(),
    projectId: z.string().nullable(),
    projectName: z.string().nullable(),
  }),
  /** The name the deleted session had (`<app> · agent HH:MM`) */
  sessionName: z.string(),
  tool: ToolName,
  status: z.string(),
  /** When the run started, and when its session was deleted and the record kept */
  startedAt: z.number(),
  keptAt: z.number(),
  durationMs: z.number().nullable(),
  tokens: z.object({ input: z.number(), output: z.number() }).nullable(),
  /** The first few hundred characters of the app's request, to tell the records apart */
  requestPreview: z.string(),
  messages: z.number(),
  bytes: z.number(),
  /** The linked machine whose record it is (#378 review): the run, and the delete, happened where its app runs */
  ...machineField,
})
export type TrashedRun = z.infer<typeof TrashedRun>

/**
 * What one session's subagent steps take (#418): the steps the native subagents it launched took (Claude Code's
 * `Agent`, Codex's `spawn_agent`), kept under their launch cards (#222). They are often most of what a long session
 * holds (the measured case: 46 MB of a 237 MB store, all from one session still in use), so Settings shows them per
 * session and lets them go to the trash without the conversation.
 *
 *   runs    the launch cards whose steps these are
 *   steps   the steps, every run together
 *   bytes   their size in the store
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

/**
 * A session's subagent steps in the trash (#418), while the session itself stays. `deletedAt` is the latest move: steps
 * moved there twice are one entry. Restoring puts them back under their cards; deleting them for good is the trash's
 * rule, as for a session (only the person, from Settings, one at a time or by emptying the trash).
 */
export const TrashedSubagentSteps = SubagentStepsHeld.extend({ deletedAt: z.number() })
export type TrashedSubagentSteps = z.infer<typeof TrashedSubagentSteps>

/**
 * What a message means to a delegation report the session owes (#1377): `ask` ("Just asking", the default), `task` ("Add
 * to the task": its turn is the delegated work's, noted as the person's addition) or `takeover` ("Take it over": the
 * report closes and the caller is told once)
 */
export const SendIntent = z.enum(['ask', 'task', 'takeover'])
export type SendIntent = z.infer<typeof SendIntent>
