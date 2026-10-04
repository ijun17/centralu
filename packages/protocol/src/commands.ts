import { z } from 'zod'
import {
  AdapterCapabilities,
  AppId,
  ApprovalDecision,
  ApprovalDetail,
  ApprovalScope,
  Attachment,
  GitBranch,
  GitCommit,
  GitDiff,
  ExternalSession,
  ExternalAppInfo,
  AppErrorBundle,
  AppPermission,
  AppUsage,
  AppQuestion,
  AppRun,
  AppReview,
  AppVersions,
  UsageSnapshot,
  GitFileStatus,
  GridPanel,
  ModelOption,
  PermissionPreset,
  Question,
  QuestionAnswer,
  SessionActivity,
  SessionGoal,
  BackgroundTask,
  SessionId,
  ProjectId,
  SessionState,
  TokenUsage,
  ToolName,
  ToolStatus,
  UiPreferences,
  UiPreferencesPatch,
  UpdateStatus,
} from './entities.js'
import { ThemeFileContent, ThemeFileEntry, ThemeId } from './theme.js'

/** UI → host RPC. Maps one-to-one to the port interface (platform/ports) (docs/protocol.md §3) */

export const CreateSessionParams = z.object({
  projectId: ProjectId,
  cwd: z.string(),
  tool: ToolName,
  model: z.string().optional(),
  effort: z.string().optional(),
  /** Response length (codex's model_verbosity). Which tiers are supported is stated by the adapter's capability declaration (#54) */
  verbosity: z.string().optional(),
  /** Response speed (codex's service_tier). Which tiers are supported is stated by the model list (ModelOption.tiers) */
  serviceTier: z.string().optional(),
  permissionPreset: PermissionPreset.default('normal'),
  initialPrompt: z.string().optional(),
  /**
   * The handoff note this session inherited (#102) — enters as a **record**, not as the first
   * message.
   *
   * A note the agent wrote is the one piece of material that cannot be recreated once its
   * author is gone. Once the first message came to carry only a path, that text had nowhere to
   * live in the conversation, so it is pinned as a marker on the session instead (the file
   * after that point is a pure derivative and can be deleted at any time).
   */
  handoff: z
    .object({
      from: z.string(),
      note: z.string(),
      /**
       * The id of the predecessor session (#106). Despite the name, this is **the name of a
       * file** — the note lives at `<data>/handoff/<project id>/<predecessor session id>.md`
       * (#142), and the host needs this value to tell a "note that still has an owner" apart
       * from an orphan, and to open that folder for the successor to read. It is optional for
       * old frames and for calls made outside a handoff: without it, the note is claimed by
       * nobody.
       */
      fromSessionId: SessionId.optional(),
    })
    .optional(),
  resumeExternalId: z.string().optional(),
  /** When resuming, also restore the prior conversation on screen (used together with resumeExternalId) */
  importHistory: z.boolean().optional(),
  /**
   * Run only this session **in a git worktree** (FR-2's lower-priority option).
   *
   * The default is to work directly in the original directory — a worktree is never forced.
   * Only someone who wants to eliminate file conflicts outright, when several sessions share a
   * directory, turns this on.
   */
  worktree: z.boolean().optional(),
  /**
   * The worktree branch name (#69). If omitted, an automatic name is used
   * (`centralu/<first 8 characters of the id>`).
   *
   * The branch name doubles as the session name and the worktree directory name — since it is
   * effectively permanent (changing it later means recreating the tree), the person has to be
   * able to choose it here. Validation is done by the host (`git check-ref-format` — we do not
   * re-implement that rule ourselves).
   */
  worktreeBranch: z.string().optional(),
  /**
   * Where to branch off from (the person pointed this out on 2026-09-07: "when creating a
   * worker, there is no way to pick which branch to pull from").
   *
   * If omitted, this is the project's trunk (the baseBranch the manager set), and if that is
   * also missing, the current HEAD. Even someone who has set a trunk sometimes needs "just this
   * one time, from that other branch," and if the only workaround were swapping branches in the
   * original folder, there would be no reason left to use a worktree.
   */
  worktreeBase: z.string().optional(),
})
export type CreateSessionParams = z.infer<typeof CreateSessionParams>

/**
 * Change a session's settings. **The reason this has its own name** is so the port can use this
 * exact type too.
 *
 * The port used to re-declare `{ model?, permissionPreset? }` by hand, and when `effort` was
 * added later it was left out there. It still worked anyway — because when the store passes it
 * as a **variable**, TypeScript does not check for excess properties. A field the type said did
 * not exist was flowing through in practice.
 */
export const UpdateSettingsParams = z.object({
  sessionId: SessionId,
  model: z.string().nullable().optional(),
  /** Reasoning effort. Carried as a raw string since supported tiers differ by model */
  effort: z.string().nullable().optional(),
  /** Response length. Carried as a raw string under the same rule as effort (#54) */
  verbosity: z.string().nullable().optional(),
  /** Response speed. Same rule — which tiers are supported is stated by the model list */
  serviceTier: z.string().nullable().optional(),
  permissionPreset: PermissionPreset.optional(),
})
export type UpdateSettingsParams = z.infer<typeof UpdateSettingsParams>

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
   * The project this session belongs to. **Only the orchestrator has null here** — it is a
   * session that crosses projects, so it is not attached to any one of them (attaching it would
   * mean it dies along with that project when the project is deleted).
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
   * means. This line decides which list shows the session: an app that is running shows its own
   * sessions, and the sidebar only carries project sessions. If the app is turned off or removed,
   * the sidebar takes it over — this is how the rule that a session must stay reachable even with
   * its app off (the demotion principle) is kept.
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
  pendingQuestions: z.array(z.object({ requestId: z.string(), questions: z.array(Question) })).default([]),
  activity: SessionActivity.nullable().default(null),
  limit: z
    .object({ resumeAt: z.string().optional(), usedPercent: z.number().optional(), windowMins: z.number().optional() })
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
    .object({ used: z.number(), window: z.number(), exactness: z.enum(['exact', 'estimate']) })
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
  }
}

/**
 * A single saved shell command (#44, the alias was requested by the person on 2026-09-06).
 * `command` is the identity — the run ledger (commandRuns), the host's PTY registry and the log
 * buffer all key off this string. `label` is display-only, and wherever it is shown, the command
 * is always shown alongside it (to prevent the name from drifting into secretly meaning a
 * different command).
 */
export const SavedCommand = z.object({
  command: z.string(),
  label: z.string().optional(),
})
export type SavedCommand = z.infer<typeof SavedCommand>

/**
 * The values last chosen for one tool (#107).
 *
 * verbosity and serviceTier are not here — they have never been remembered as a project
 * default (there is no column for them either), and there is no reason to invent that memory now.
 * If they are added, they go into the same envelope.
 */
export const ToolDefaults = z.object({
  model: z.string().nullable().default(null),
  effort: z.string().nullable().default(null),
})
export type ToolDefaults = z.infer<typeof ToolDefaults>

export const ProjectInfo = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  /**
   * The tool this project reached for last, if it ever did.
   *
   * It defaulted to `'claude'`, which was the last vendor name left in this package after
   * the tool list became data: a project created on a machine without Claude Code still
   * claimed to prefer it. There is no sensible default here — only the host knows which
   * tools exist — so the absence is now recorded as one, and the screens fall back to
   * whatever the machine actually has.
   */
  defaultTool: ToolName.nullable().default(null),
  /**
   * The last-chosen model and effort — **kept separately per tool** (#107).
   *
   * This used to be one value per project (the scalars `defaultModel` and `defaultEffort`). But
   * a model name is a tool's own vocabulary, so a Codex session started in a project that had
   * once had a Claude model chosen inherited that name wholesale — measured: a project with
   * `default_tool=codex` held `default_model=opus[1m]`, and that session died with a 400 on
   * every turn. The rule "the act of choosing becomes the default" was correct; the storage
   * shape just failed to express it: **a choice is always a choice for some particular tool.**
   */
  defaultModels: z.record(ToolName, ToolDefaults).default({}),
  /**
   * The shell commands saved on this project — what the Run menu offers (issue #44).
   *
   * They arrive **with the project** rather than being asked for when the menu opens. A
   * separate fetch would force the menu to tell "none saved yet" from "not loaded yet"
   * (which is why `agents.commands` carries a `ready` flag), and the project is already
   * in the store in one piece, so there is no reason to invent that distinction here.
   *
   * A row used to be the bare command string so that "there is no label that can drift
   * away from it". The label came back by user request (2026-09-06) — `pnpm dev` reads
   * worse than "Dev server" at a glance — but the drift argument still shapes the rule:
   * every surface that shows the label **also shows the command**, so a name can never
   * silently mean something else. The command string stays the identity everywhere
   * (run ledger, host PTY registry); the label is display-only.
   */
  commands: z.array(SavedCommand).default([]),
  /**
   * Worktree provisioning (#69). A new worktree is an empty workbench — it has only the tracked
   * files, no node_modules, no gitignored .env. Creation order: worktree, then copy files, then
   * setup (the order Vibe Kanban validated). Null means nothing runs — it is never forced.
   * This lives in our own database, not the repo (#50: nothing is ever written into the repo).
   */
  worktreeSetup: z.object({ command: z.string(), copyFiles: z.array(z.string()) }).nullable().default(null),
  /**
   * This project's worktree manager slot and trunk (#76). Null means there is not one yet — the
   * screen then offers "start manager." baseBranch is both where a worktree branches off from
   * and the baseline for merge judgment.
   */
  worktreeManager: z.object({ sessionId: z.string(), baseBranch: z.string() }).nullable().default(null),
  /**
   * Whether this project's code is allowed to run on this machine (M4, plan decision 3) — this
   * one field decides whether apps start and whether project settings are honored. A newly
   * registered project starts as "no" (`projects.setTrusted`). Missing reads as "no" too: if an
   * old host's answer that does not know about trust were filled in as "yes," that would be a
   * silent grant of permission.
   */
  trusted: z.boolean().default(false),
  git: z
    .object({
      branch: z.string(),
      changedFiles: z.number(),
      isRepo: z.boolean(),
      /** The OS blocked access — reported distinctly from "not a repository" (measured in F-1) */
      denied: z.boolean().optional(),
    })
    .nullable()
    .default(null),
})
export type ProjectInfo = z.infer<typeof ProjectInfo>

/** A single slash command (skill) */
export const CommandInfo = z.object({
  name: z.string(),
  description: z.string().default(''),
  /** Argument hint (e.g. "<file>") */
  argumentHint: z.string().default(''),
})
export type CommandInfo = z.infer<typeof CommandInfo>

/** One terminal (listing, creation and restart all return this shape) */
export const TerminalInfo = z.object({
  terminalId: z.string(),
  cwd: z.string(),
  title: z.string(),
  /** Output so far — restores the screen on reattach */
  history: z.string(),
  alive: z.boolean(),
})
export type TerminalInfo = z.infer<typeof TerminalInfo>

/**
 * One run of a frequently used command (#60). Only the **latest run** per command is kept —
 * it is replaced only when that same command runs again (the person's decision; kept for the
 * host's lifetime). The output stream rides the same terminal frame lane: runId takes the place
 * of terminalId.
 */
export const CommandRunInfo = z.object({
  command: z.string(),
  /** A fresh id per run — the basis for the screen to switch which output stream it follows */
  runId: z.string(),
  running: z.boolean(),
  /** Null means either still running, or the process never even started (history states the reason) */
  exitCode: z.number().nullable(),
  startedAt: z.number(),
})
export type CommandRunInfo = z.infer<typeof CommandRunInfo>

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
 * A session in the trash (#204), as Settings lists it.
 *
 * Deleting a session moves it here instead of destroying it; only Settings deletes it for good. The list says what
 * each one still holds and what goes with it, because a trash that shows names but not contents is the hidden store
 * the retired archive was (FR-20): it had a way in and no way out, and nobody could see what it kept.
 */
export const TrashedSession = z.object({
  id: SessionId,
  name: z.string(),
  tool: ToolName,
  /**
   * Where it came from, null for a session that had no project. `exists` is false when that project has been
   * deleted since: restoring then registers the folder again, and refuses if the folder is gone too.
   */
  project: z.object({ id: z.string(), name: z.string(), path: z.string().nullable(), exists: z.boolean() }).nullable(),
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
})
export type TrashedSession = z.infer<typeof TrashedSession>

/**
 * The cap on a single attachment (#94) — counted in base64 characters. A 32MiB original comes
 * out to this length.
 *
 * There used to be no cap here at all. The overall total is capped at 500MB by
 * `sweepAttachments`, but that cleanup never looks at files arriving through this path, so this
 * is the only thing stopping a single call from filling the disk. On top of that, the string is
 * held whole in the host's memory before it ever becomes a file — a rejection only means
 * anything if it happens before the write. 32MiB was chosen as comfortably larger than a pasted
 * screenshot (a few MB), while still not large enough to bring down the host in one call.
 */
export const ATTACHMENT_MAX_BASE64 = Math.ceil((32 * 1048576) / 3) * 4

export const RpcMethods = {
  'agents.createSession': { params: CreateSessionParams, result: SessionInfo },
  'agents.send': {
    params: z.object({ sessionId: SessionId, text: z.string(), attachments: z.array(Attachment).optional() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'agents.respondApproval': {
    params: z.object({
      sessionId: SessionId,
      requestId: z.string(),
      decision: ApprovalDecision,
      scope: ApprovalScope.optional(),
      /** The target pattern for "always allow." Computed by the core and sent by the UI */
      matcher: z.string().optional(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Answers a set of choices (AskUserQuestion). The answer returns to the model as that tool's
   * result.
   *
   * Kept separate from approval because what goes back is different — an approval is whether to
   * run at all, while this is **content**. If there are several questions, several answers
   * arrive together.
   */
  'agents.answerQuestion': {
    params: z.object({
      sessionId: SessionId,
      requestId: z.string(),
      answers: z.array(QuestionAnswer),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'agents.interrupt': { params: z.object({ sessionId: SessionId }), result: z.object({ ok: z.literal(true) }) },
  /**
   * Stops one background task of the session (#290) — only one the adapter marked `stoppable`. Claude stops it with
   * `stopTask`, Codex by interrupting the child thread's own turn. The task leaves the live set through the session's
   * next `background_tasks` event, with its ending, as for any other ending; this only asks.
   */
  'agents.stopBackgroundTask': {
    params: z.object({ sessionId: SessionId, taskId: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Takes the ended tasks off the session's list (#290). Running ones stay; they are the tool's to end */
  'agents.clearBackgroundTasks': { params: z.object({ sessionId: SessionId }), result: z.object({ ok: z.literal(true) }) },
  /**
   * Moves a session to the trash (#204). Nothing is destroyed here: the rows, the attachments, the handoff note, the
   * tool's conversation file and the worktree all stay until the person deletes it for good in Settings
   * (`trash.purge` / `trash.empty`). The two flags only record what that later step removes.
   *
   * There used to be an archive ahead of this (hiding a session from the list only). It was
   * discontinued on 2026-09-02: it had a door in (the inbox's `d`) and no door out, so to the
   * person it was indistinguishable from deletion. The trash is that shape with its exits built in the same change: list, read, restore.
   */
  'agents.deleteSession': {
    params: z.object({
      sessionId: SessionId,
      /**
       * Only meaningful for a worktree session. **The default is to keep it** — hours of an
       * agent's work can live there, and deleting it silently leaves no way back. The UI asks
       * first via `agents.worktreeStatus`, and sends whatever the person decided here.
       * The worktree stays in place while the session is in the trash; this marks it for removal when it is purged.
       */
      deleteWorktree: z.boolean().default(false),
      /**
       * Also delete the tool-side conversation itself (dogfooding "actually delete" — measured
       * at 550MB for a codex rollout, plus claude JSONL). The default is to keep it here too:
       * that file belongs to the tool, and keeping it around is the last way back into that tool
       * if the deletion is regretted. Only turned on when the person explicitly checks the box.
       * If deleting the original fails, our own deletion stops too — because answering "deleted"
       * while the original still exists would be the worst outcome.
       * Since #204 the file is deleted when the session is purged from the trash, not here; the rule above holds there.
       */
      deleteExternal: z.boolean().default(false),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * The material needed to judge whether a worktree can be deleted. The UI asks this right
   * before deleting. `null` means this is not a worktree session — there is nothing to ask.
   */
  /**
   * The orchestrator's MCP server proposal flow (propose_mcp_server, then the person's one-click
   * approval, then the app registers it and restarts the orchestrator). The proposal list is
   * fetched by query, and the answer goes through resolve.
   */
  'agents.mcpProposals': {
    params: z.object({}),
    result: z.object({
      proposals: z.array(
        z.object({
          name: z.string(),
          command: z.string(),
          args: z.array(z.string()),
          why: z.string().optional(),
        }),
      ),
    }),
  },
  'agents.resolveMcpProposal': {
    params: z.object({ name: z.string(), approve: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Orchestrator skills (#71) — fetching and answering proposals, plus listing and deleting
   * approved skills. The reason deletion exists: a skill that can only be added and never
   * removed is worse than not having one at all (the decision recorded on the issue).
   */
  'agents.skillProposals': {
    params: z.object({}),
    result: z.object({
      proposals: z.array(z.object({ name: z.string(), content: z.string(), why: z.string().optional() })),
    }),
  },
  'agents.resolveSkillProposal': {
    params: z.object({ name: z.string(), approve: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'agents.orchestratorSkills': {
    params: z.object({}),
    result: z.object({ skills: z.array(z.object({ name: z.string(), content: z.string() })) }),
  },
  'agents.deleteOrchestratorSkill': {
    params: z.object({ name: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * The handoff transcript for a dead agent (#78). Built by the host from the raw store data
   * (plus a compact summary of a codex rollout) without calling that session's tool.
   *
   * **The result is a file** (#102): the host writes it to the note's spot in the data folder
   * (`<data>/handoff/<project id>/<session id>.md`, #142) and returns its absolute path — the
   * **same spot** used by the mode that receives a note from the agent
   * (`agents.exportHandoffNote`), so the first message the successor receives has the same
   * shape either way. text is also returned so the caller can pull out a short preview to put in
   * the first message. Nothing is ever written into the user's own repository.
   */
  'agents.exportHandoffRecord': {
    params: z.object({
      sessionId: SessionId,
      /** The tool that will be the successor — used for the transcript header's `codex → claude`. Omit if unknown. */
      toTool: ToolName.optional(),
    }),
    result: z.object({ text: z.string(), path: z.string() }),
  },
  /**
   * The note from a live handoff (#142) — the host places the note the agent wrote **as its
   * reply** at the same spot as the transcript mode.
   *
   * The agent does not write the file itself: since the note's spot is outside the repository,
   * letting it write directly would mean granting both tools more permission than they need.
   * afterSeq is the last seq right before the request was sent — the first person message after
   * it is the request, and the last reply before the next person message after that is the note.
   * **Null means "not yet"**: either the turn is still running, or there is no reply yet. The
   * caller waits and asks again.
   */
  'agents.exportHandoffNote': {
    params: z.object({ sessionId: SessionId, afterSeq: z.number().int().nonnegative() }),
    result: z.object({ text: z.string(), path: z.string() }).nullable(),
  },
  /**
   * Creates a coordinating session with a restricted view (#80, #81 physics). The
   * opinions (task, foreman) belong to the app; this only creates the underlying capability of
   * "an orchestrator-shaped session that can only see a member list."
   */
  'agents.createCoordinator': {
    params: z.object({
      name: z.string(),
      memberSessionIds: z.array(z.string()).min(1),
      roleAppend: z.string(),
      tool: ToolName,
      model: z.string().optional(),
      effort: z.string().optional(),
    }),
    result: SessionInfo,
  },
  'agents.worktreeStatus': {
    params: z.object({ sessionId: SessionId }),
    result: z
      .object({ path: z.string(), branch: z.string(), dirty: z.boolean(), changedFiles: z.number() })
      .nullable(),
  },
  /**
   * Restarts only the agent attached to the session (the conversation history stays untouched).
   * A way to swap out only the process when a tool acts up, without creating a whole new session.
   */
  'agents.restartSession': {
    params: z.object({ sessionId: SessionId }),
    result: z.object({ session: SessionInfo, resumed: z.boolean(), reason: z.string().optional() }),
  },
  'agents.resumeSession': {
    params: z.object({ sessionId: SessionId }),
    result: z.object({
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
  },
  /**
   * **Forks away** from a locked conversation and continues on this session instead.
   *
   * For a tool (codex) where only one place can hold write access to a conversation, this is the
   * only way to keep going without closing the other app. The original is left untouched; a copy
   * is made and this session is pointed at the copy.
   */
  'agents.forkConversation': {
    params: z.object({ sessionId: SessionId }),
    result: z.object({ session: SessionInfo, resumed: z.boolean(), reason: z.string().optional() }),
  },
  /**
   * Switches a session's agent (claude, codex).
   *
   * **Why it is kept separate** from updateSettings: model and permissions change while the same
   * conversation continues, but switching tools means the conversation does not continue
   * (externalId is a tool-specific id, so it has to be cut off). Calling two different-outcome
   * operations through the same door would let a caller use it without knowing the difference.
   */
  'agents.switchTool': {
    params: z.object({ sessionId: SessionId, tool: ToolName }),
    result: SessionInfo,
  },
  /** Changes the model and permissions mid-conversation (takes effect from the next turn) */
  'agents.updateSettings': {
    params: UpdateSettingsParams,
    result: UpdateSettingsResult,
  },
  /**
   * Prior sessions the tool has stored for this project directory (an extension of FR-10).
   * If supported=false, a reason comes with it — "new session" still works even on an older tool.
   */
  'agents.listExternalSessions': {
    params: z.object({ projectId: ProjectId, tool: ToolName, limit: z.number().default(30) }),
    result: z.object({
      supported: z.boolean(),
      reason: z.string().optional(),
      sessions: z.array(ExternalSession),
    }),
  },
  'agents.capabilities': { params: z.object({ tool: ToolName }), result: AdapterCapabilities },
  'agents.detect': {
    params: z.object({}),
    result: z.array(ToolStatus),
  },
  'git.status': { params: z.object({ projectId: ProjectId }), result: z.array(GitFileStatus) },
  'git.diff': {
    params: z.object({ projectId: ProjectId, path: z.string(), staged: z.boolean().optional() }),
    result: GitDiff,
  },
  'git.log': { params: z.object({ projectId: ProjectId, limit: z.number().optional() }), result: z.array(GitCommit) },
  'git.commitDetail': {
    params: z.object({ projectId: ProjectId, sha: z.string() }),
    result: z.object({ files: z.array(z.string()), diff: z.string(), truncated: z.boolean() }),
  },
  'git.branches': { params: z.object({ projectId: ProjectId }), result: z.array(GitBranch) },
  /**
   * The things git ignores (#76) — the list of things that will **not** exist in a new worktree.
   *
   * Offered as candidates for "what to copy" by the worktree setup window. bytes only assists
   * and can be null (measuring it is abandoned if it takes too long) — the list itself is the
   * answer, and the size is only material for the decision.
   */
  'git.ignoredEntries': {
    params: z.object({ projectId: ProjectId }),
    result: z.array(z.object({ path: z.string(), bytes: z.number().nullable() })),
  },
  'git.checkout': {
    params: z.object({ projectId: ProjectId, branch: z.string(), dryRun: z.boolean().optional() }),
    result: z.object({ ok: z.boolean(), conflicts: z.array(z.string()), message: z.string().optional() }),
  },
  'git.stage': {
    params: z.object({ projectId: ProjectId, paths: z.array(z.string()), unstage: z.boolean().optional() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'git.commit': {
    params: z.object({ projectId: ProjectId, message: z.string() }),
    result: z.object({ ok: z.boolean(), message: z.string().optional() }),
  },
  'git.push': {
    params: z.object({ projectId: ProjectId }),
    result: z.object({ ok: z.boolean(), message: z.string().optional() }),
  },
  /** The host saves a pasted image as a file (so base64 never goes into the database) */
  'attachments.save': {
    params: z.object({
      sessionId: SessionId,
      name: z.string(),
      mime: z.string(),
      dataBase64: z.string().max(ATTACHMENT_MAX_BASE64, 'This attachment is too large'),
    }),
    result: Attachment,
  },
  'fs.listDir': {
    params: z.object({ projectId: ProjectId, path: z.string() }),
    result: z.array(z.object({ name: z.string(), path: z.string(), isDir: z.boolean(), ignored: z.boolean() })),
  },
  /**
   * The full set of directories to watch in this project (#34). **Received as the complete
   * whole every time** — same syntax as projects.reorder, for the same reason: the set of
   * expanded rows on screen is exactly the watch set, so exchanging it as "add this, drop that"
   * would let the two sides drift apart with no error at all.
   * Changes arrive as `fs_changed` events. If watched is smaller than the count sent, it was
   * truncated by the cap.
   */
  'fs.watch': {
    params: z.object({ projectId: ProjectId, paths: z.array(z.string()) }),
    result: z.object({ watched: z.number() }),
  },
  'fs.readFile': {
    params: z.object({ projectId: ProjectId, path: z.string() }),
    result: z.object({
      text: z.string(),
      truncated: z.boolean(),
      binary: z.boolean(),
      bytes: z.number(),
      image: z.object({ mime: z.string(), data: z.string() }).optional(),
      previewError: z.string().optional(),
    }),
  },
  /**
   * Move a file or folder into another folder of the same project (#19).
   *
   * The destination is a **folder**, not a full path: the gesture is a drop onto a row, and
   * the new name is always the old one. `moved: false` means it landed where it already was.
   */
  'fs.move': {
    params: z.object({ projectId: ProjectId, from: z.string(), toDir: z.string() }),
    result: z.object({ path: z.string(), moved: z.boolean() }),
  },
  /**
   * Put a file dragged in from the desktop into the project (#19).
   *
   * Bytes, not a source path — the webview never tells the page where a dropped file lives,
   * which is the same reason attachments travel this way.
   */
  'fs.importFile': {
    params: z.object({ projectId: ProjectId, toDir: z.string(), name: z.string(), dataBase64: z.string() }),
    result: z.object({ path: z.string() }),
  },
  /**
   * The absolute path of a project file, for the desktop shell's own OS calls
   * (revealing it in the file manager, moving it to the trash).
   *
   * The host is the only side that knows the project root, so it is the only side allowed
   * to build one — and it refuses paths that leave the project, or that are not there.
   */
  'fs.resolve': {
    params: z.object({ projectId: ProjectId, path: z.string() }),
    result: z.object({ path: z.string() }),
  },
  'messages.search': {
    params: z.object({ query: z.string(), limit: z.number().optional() }),
    result: z.array(z.object({ sessionId: z.string(), seq: z.number(), snippet: z.string() })),
  },
  'workspace.save': {
    params: z.object({ layout: z.record(z.string(), z.unknown()) }),
    result: z.object({ ok: z.literal(true) }),
  },
  'approvals.deleteRule': {
    params: z.object({ id: z.number() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.load': { params: z.object({}), result: z.record(z.string(), z.unknown()).nullable() },
  'projects.add': { params: z.object({ path: z.string() }), result: ProjectInfo },
  /**
   * **Deletes** a project — not just removing it from the list, but erasing it from this app's
   * records entirely (its sessions, conversations, search index, approval rules, even usage
   * attribution).
   *
   * **It never touches the folder.** Discarding files only ever happens through the OS trash,
   * which is the shell's (Rust's) job, and the caller finishes that before this command runs.
   * This is also why there is no `deleteFiles` switch here — the host has no hand that can
   * discard files, so accepting one would just be a promise it cannot keep.
   */
  'projects.delete': {
    params: z.object({ projectId: ProjectId }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Whether this project's code is allowed to run on this machine (M4 A-2, plan decision 3).
   *
   * The default is "no" — simply opening a repository someone handed over must not let the app
   * server inside it run with the user's own permissions. Turning it off brings that project's
   * apps down immediately.
   */
  'projects.setTrusted': {
    params: z.object({ projectId: ProjectId, trusted: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Reorders the sidebar. **Receives the entire order as a whole** — exchanging it as
   * "move this one there" would drift out of sync if the list changed in the meantime.
   */
  'projects.reorder': {
    params: z.object({ orderedIds: z.array(z.string()) }),
    result: z.array(ProjectInfo),
  },
  /**
   * Replace this project's saved shell commands (issue #44).
   *
   * The **whole list**, like `projects.reorder` above and for the same reason: it is a
   * short list a person edits by hand, so "make it look like this" states every edit —
   * adding, deleting and (one day) reordering all arrive through one door instead of three.
   *
   * Nothing on the way through inspects the commands. These are the user's own, the same
   * as typing into the terminal below; the approval system is for what an *agent* wants to
   * run, and asking permission for what the person just typed would teach them to wave the
   * prompt through where it matters.
   *
   * Answers with the stored list rather than the project so that saving a command does not
   * cost a `git status` — the caller already has everything else about the project.
   */
  'projects.setCommands': {
    params: z.object({ projectId: ProjectId, commands: z.array(SavedCommand) }),
    result: z.array(SavedCommand),
  },
  /**
   * Creates the worktree manager slot (#76) — even when it will have no children yet.
   *
   * baseBranch is this project's **trunk**: both where a worktree branches off from and the
   * baseline for measuring whether it has merged. The host never invents a default for it —
   * which branch is the trunk differs by repository, and a wrong default only shows up once a
   * worktree has already branched off from the wrong place. If the slot already exists, it is
   * returned as-is and only the trunk is rewritten (this is how the trunk gets changed).
   */
  'worktrees.createManager': {
    params: z.object({ projectId: ProjectId, baseBranch: z.string() }),
    result: SessionInfo,
  },
  /** Saves worktree provisioning settings (#69) — edited by the worktree section of the new-session window */
  'projects.setWorktreeSetup': {
    params: z.object({
      projectId: ProjectId,
      setup: z.object({ command: z.string(), copyFiles: z.array(z.string()) }).nullable(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'sessions.reorder': {
    params: z.object({ projectId: ProjectId, orderedIds: z.array(z.string()) }),
    result: z.array(SessionInfo),
  },
  /**
   * The app's single orchestrator. **Calling this creates one if it does not exist.**
   * Creating it ahead of time would leave a session nobody uses holding onto a tool process.
   */
  'orchestrator.get': { params: z.object({}), result: SessionInfo },
  /**
   * Returns it if it exists, and **does not create one if it does not** (#63).
   *
   * Once onboarding started showing the orchestrator screen first, "opening the screen" and
   * "creating the process" had to split apart — the screen only asks via this, and creation
   * happens through `orchestrator.get` at the moment the person actually asks their first
   * question. Creating it any earlier would leave a tool process running for a person who never
   * even asked (the lazy-startup principle).
   */
  'orchestrator.peek': { params: z.object({}), result: SessionInfo.nullable() },
  /**
   * Which tool the central orchestrator will **run on top of** (#63, the card chosen on the
   * intro screen). This setting is only for before a session exists — once one does, switching
   * the Agent in session settings takes over.
   */
  'orchestrator.configure': {
    params: z.object({ tool: ToolName }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * The orchestrator tool — **the path a separate process (the bridge) uses to call back into
   * the host**.
   *
   * Claude attaches in-process, so it does not need this door. Codex can only attach a stdio
   * server through its per-thread config (HTTP did not work when measured), so it needs a
   * bridge, and the bridge makes no judgments itself — it only passes along a name and
   * arguments, and every rule stays in the host.
   */
  /**
   * The address at which an app's screen is served (M4 B-3). The host builds the sandbox proxy
   * address for it. That address's path sits behind a secret segment generated fresh on every
   * run, so only whoever knows the address can raise the screen. The secret only ever leaves
   * through this response (to a side already authenticated with the WebSocket token).
   *
   * A screen instance is created by a single tool call. The instance decides which app's screen
   * it is; `appId` and `projectId` are only checked against it. `hostOrigin` is the calling
   * screen's own origin (`location.origin`). It has to be on the same allowlist as the
   * WebSocket, and the proxy only exchanges messages with that origin.
   */
  'apps.viewFrame': {
    params: z.object({
      appId: AppId,
      projectId: ProjectId.nullable().default(null),
      instanceId: z.string(),
      hostOrigin: z.string(),
    }),
    result: z.object({
      url: z.string(),
      allow: z.string(),
      sandbox: z.object({
        csp: z.object({
          connectDomains: z.array(z.string()),
          resourceDomains: z.array(z.string()),
          frameDomains: z.array(z.string()),
          baseUriDomains: z.array(z.string()),
        }),
        permissions: z.record(z.string(), z.object({})),
      }),
    }),
  },
  /**
   * Opens the pinned screen (M4 B-2). The host calls the manifest's `home` tool **as the screen
   * caller** (the one path used for this: visibility scope, run history), then opens a screen
   * instance at the `_meta.ui.resourceUri` that tool declared. The response has everything
   * AppFrame needs: the instance, and that call's input and result (the spec's tool-input,
   * tool-result).
   *
   * If there is no `home`, or that tool did not declare a screen, or the app cannot be reached
   * (not trusted, or failed to start), this fails with a reason and leaves no instance behind. If
   * the app itself answered with a failure, this still opens — drawing a failure is also the
   * screen's job.
   */
  'apps.openView': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable() }),
    result: z.object({
      instanceId: z.string(),
      tool: z.string(),
      resourceUri: z.string(),
      toolInput: z.record(z.string(), z.unknown()),
      toolResult: z.looseObject({ content: z.array(z.record(z.string(), z.unknown())) }),
      runId: z.string(),
    }),
  },
  /**
   * Closes the pinned screen (M4 B-2). Releases the app the instance was holding on to — an app
   * with no open screen counts down toward idle (A-3). An instance that is already closed is
   * passed over silently (closing twice yields the same result).
   */
  'apps.closeView': {
    params: z.object({ instanceId: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Reopens an inline conversation screen that had been collapsed (M4 B-1) — the "Reopen" for a
   * screen that fell out of virtual scroll or was pushed into a placeholder by the cap. **Does
   * not call the tool again**: the host opens a new instance and returns the input and outcome
   * (a result, or the cancellation reason) of that same call it was still holding — AppFrame
   * renders it again exactly to spec. If the call is still running, it arrives with no outcome
   * yet, and once it finishes, `app_view`'s result and cancelled fields arrive as usual.
   *
   * The host holds the input and result only in memory, size-capped (inline-views.ts). If it is
   * no longer holding them (too large, discarded for age, or the host restarted), this fails
   * with a reason, and the placeholder then only offers a way to open the app instead. Opening
   * this re-enforces the cap on live screens per conversation — the other, longest-open screen
   * may get closed with `closed`.
   */
  'apps.inlineReopen': {
    params: z.object({ sessionId: SessionId, callId: z.string() }),
    result: z.object({
      instanceId: z.string(),
      appId: AppId,
      projectId: z.string().nullable(),
      tool: z.string(),
      toolInput: z.record(z.string(), z.unknown()),
      toolResult: z.looseObject({ content: z.array(z.unknown()) }).optional(),
      cancelled: z.string().optional(),
    }),
  },
  /**
   * The inline conversation screens the host is holding for one conversation (M4 B-1) — asked by
   * a freshly reopened UI when it plants placeholders for past cards. If `kept` is true,
   * "Reopen" opens that screen without calling the tool again. If `instanceId` is present, that
   * instance is still open — since the freshly reopened UI does not know that frame, it closes
   * it to release the app. The body (input, result) is not carried here. If the host itself has
   * restarted, this comes back empty (what it was holding lived only in memory).
   */
  'apps.inlineViews': {
    params: z.object({ sessionId: SessionId }),
    result: z.array(
      z.object({
        callId: z.string(),
        appId: AppId,
        projectId: z.string().nullable(),
        tool: z.string(),
        kept: z.boolean(),
        instanceId: z.string().nullable(),
      }),
    ),
  },
  /**
   * An app screen's `ui/message` (M4 B-1, B-4) — called by the UI only after a person reads it
   * and chooses to send.
   *
   * The app is decided by **the instance** (#93, #94: the string that was validated is the one
   * that is used). Where it goes depends on where the screen lives:
   *   inline screen   the conversation that screen stands in. `sessionId` is only checked against
   *                   it and is rejected if it names a different conversation.
   *   pinned screen   since it does not belong to a conversation, the conversation is whatever
   *                   the person chose (the UI asks first). Rejected unless it is an open instance.
   * Either way it lands in the conversation as text the app sent (`user_message.fromApp`), and
   * what goes to the agent is the shape the host wraps as "app text" — for a pinned screen, it
   * also states that this came from outside the conversation.
   */
  'apps.viewMessage': {
    params: z.object({ sessionId: SessionId, instanceId: z.string(), text: z.string().min(1).max(64_000) }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * A screen reads its own app's resource (M4 B-3, the bridge's `onreadresource`). The response
   * is exactly the result of MCP's `resources/read`. The spec's shape is known to the screen and
   * the app; this layer only carries it. If `instanceId` is given, it must match that screen's app.
   */
  'apps.readResource': {
    params: z.object({
      appId: AppId,
      projectId: ProjectId.nullable().default(null),
      uri: z.string(),
      instanceId: z.string().optional(),
    }),
    result: z.looseObject({ contents: z.array(z.looseObject({ uri: z.string() })) }),
  },
  /**
   * App state (#81). One JSON document plus an enabled flag per app — no per-app protocol is
   * ever built. Only the app knows what the document means; the core and the protocol only carry it.
   */
  'apps.state': {
    params: z.object({ appId: AppId }),
    result: z.object({ doc: z.unknown().nullable(), enabled: z.boolean() }),
  },
  'apps.setState': {
    params: z.object({ appId: AppId, doc: z.unknown() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * A screen calls an app tool — **built-in and external apps use the same door** (#81, M4 A-4).
   *
   * Built-in app (no `projectId`, and its id is on the built-in roster): treated as though the
   * person called it — instead of a profile judgment, only "is this that app's tool" is checked.
   * caller.sessionId=null means a person.
   *
   * External app: an app is unique per (project, id), so `projectId` distinguishes it (null =
   * a user-folder app). The caller is recorded **as a screen**, and only tools open to a screen
   * (with `app` in `visibility`) can be called. `result` is exactly the app's own answer (the
   * shape the screen's AppBridge receives). If `status` is `rejected`, the host never sent it to
   * the app at all — the reason is in `text`.
   *
   * Why there is no separate door for each: to the caller (a screen), built-in and external are
   * the same operation. Two doors would force the UI to know which one it is dealing with, and
   * that distinction is a fact only the host knows.
   */
  'apps.invoke': {
    params: z.object({
      appId: AppId,
      name: z.string(),
      args: z.record(z.string(), z.unknown()),
      projectId: ProjectId.nullable().optional(),
      /** The calling screen's instance — the caller's own screen is the one that skips the "changed" event (`external_app_state_changed.cause`) this call produces */
      instanceId: z.string().optional(),
    }),
    result: z.object({
      text: z.string(),
      isError: z.boolean().optional(),
      status: z.enum(['ok', 'error', 'cancelled', 'rejected']).optional(),
      runId: z.string().optional(),
      result: z.unknown().optional(),
    }),
  },
  'apps.setEnabled': {
    params: z.object({ appId: AppId, enabled: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Discovered external apps (M4 A-2) — project apps and user-folder apps. Apps from an
   * untrusted project and apps with a broken manifest are listed too, with a reason (`status`,
   * `error`): hiding them would leave nowhere to ask why they do not show up. Built-in apps are
   * not here (the built-in roster is compiled in, and A-8 merges the two).
   */
  'apps.list': { params: z.object({}), result: z.array(ExternalAppInfo) },
  /**
   * Lets a stopped (`failed`) external app be started again — clears the run of consecutive
   * failures, and takes it down if it happens to be up. **Does not start it**: whatever calls
   * next starts it (the same principle: it starts only the first time it is actually needed).
   */
  /** The run history of one external app, most recent first (M4 A-6 — read by the run history screen B-7) */
  'apps.runs': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), limit: z.number().int().min(1).max(500).default(100) }),
    result: z.array(AppRun),
  },
  'apps.restart': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Removes an external app in the user folder (M4 A-7) — the way to withdraw an approved MCP
   * server (an app with no screen). Its folder is moved to `app-trash/` in the data folder, and
   * it is detached from any session it was attached to. A project app (one with a `projectId`)
   * is rejected — since it is a file in the repository, git is where it gets withdrawn. The
   * relevant list is `apps.list`'s apps with `projectId: null`.
   */
  'apps.remove': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Creates a new app from a template (M4 C-1b) — called by the "new app" button. The same door
   * as the orchestrator's `create_app`. If `projectId` is given, it is created at
   * `.centralu/apps/<id>/` in that project (only if trusted); if null, it goes in the user
   * folder. `id` is both the folder name and becomes `app-<id>` in a session: lowercase, digits
   * and hyphens, up to 32 characters, may not start with `centralu` or `app-`. An id that
   * already exists, an untrusted project, or an invalid name fails with a reason and creates
   * nothing. The app is not started — it starts only the first time it is actually needed.
   */
  'apps.create': {
    params: z.object({
      projectId: ProjectId.nullable(),
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      /** The tool for the building session (C-2). If omitted, the project's default tool (for a user-folder app, the orchestrator's tool) */
      tool: ToolName.optional(),
    }),
    /**
     * Creating an app also stands up its building session (C-2). If that session fails to stand
     * up, the app still remains — `builder` is null and `builderError` states why. In that case
     * it can be stood up again with `apps.createBuilder`.
     */
    result: z.object({ app: ExternalAppInfo, builder: SessionInfo.nullable(), builderError: z.string().optional() }),
  },
  /**
   * That app's building session (M4 C-2) — "open the building session for app X." Null if there
   * is none (never stood up, or deleted). A project app's building session has its cwd at the
   * project root; a user-folder app's has it at the app's own folder.
   */
  'apps.builder': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable() }),
    result: SessionInfo.nullable(),
  },
  /**
   * Stands up that app's building session (M4 C-2) — returns the existing one if there already
   * is one (one per app). Used for a hand-made app, or an app whose building session was
   * deleted. An app in an untrusted project is rejected (that app never starts, so it cannot be
   * tested).
   */
  /**
   * The recent error bundles for one external app (M4 C-6) — `latest` is what "send to builder"
   * would send. Only carries bundles from after the host started (they live in memory). Anything
   * that needs to persist longer is the run history's job (`apps.runs`).
   */
  'apps.errors': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable() }),
    result: z.object({ latest: AppErrorBundle.nullable(), recent: z.array(AppErrorBundle) }),
  },
  /**
   * Capability questions raised by a chain that started from a screen (M4 D-4) — the ones still
   * waiting for an answer. Drawn by the pinned screen and the sidebar. A question from a chain
   * that started from a session is not here, since it is that session's own approval card.
   * Refetched whenever `external_app_questions_changed` arrives.
   */
  'apps.questions': { params: z.object({}), result: z.array(AppQuestion) },
  /**
   * Answers a capability question (M4 D-4). The answer is remembered for that app and that
   * capability — whether allowed or denied (it can be forgotten later via `apps.permissions`).
   * A question that is already closed (timed out, or the request was cancelled) is rejected.
   */
  'apps.answerQuestion': {
    params: z.object({ questionId: z.string(), decision: z.enum(['allow', 'deny']) }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** The remembered capability answers for one app (M4 D-4) — shown next to the run history panel (B-7) and can be forgotten there */
  'apps.permissions': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable() }),
    result: z.array(AppPermission),
  },
  /** Forgets one remembered answer (M4 D-4) — the next attempt to use that capability asks again */
  'apps.forgetPermission': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), capability: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * How much agent use one app requested (M4 D-5) — how many times, for how long, how many
   * tokens. Read by the run history panel. Even for an app whose folder is gone, this is still
   * readable as long as the record remains.
   */
  'apps.usage': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable() }),
    result: AppUsage,
  },
  'apps.createBuilder': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), tool: ToolName.optional() }),
    result: SessionInfo,
  },
  /**
   * "Fix this" (M4 C-5) — sends what a person wrote in the composer under an app's screen to
   * that app's building session. The person never leaves the app. The host attaches a header:
   * which app, which screen it came from (`instanceId` — the pinned screen the person was
   * looking at; it must be an open instance of that app), and, if the app is stopped or its
   * latest run failed, that fact (protocol's `builderRequestFrame`). Since a person wrote it, the
   * body goes through as an instruction. Attachments are saved beforehand through the same path
   * as the composer's (`attachments.save`, with the building session's id). Rejected if there is
   * no building session — stand one up first with `apps.createBuilder`.
   */
  /**
   * Sends one error bundle to that app's building session (M4 C-6) — called by the UI only when
   * the person clicks "Send to builder." The host never sends one on its own. The bundle is
   * identified by `at` (that bundle from `apps.errors`). Each bundle can only be sent once — it
   * is rejected if already sent. What reaches the agent is the app's output wrapped in quotes
   * (protocol's `builderErrorFrame`).
   */
  'apps.sendError': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), at: z.number() }),
    result: z.object({ sessionId: SessionId }),
  },
  'apps.askBuilder': {
    params: z.object({
      appId: AppId,
      projectId: ProjectId.nullable(),
      text: z.string().max(64_000),
      attachments: z.array(Attachment).optional(),
      instanceId: z.string().optional(),
    }),
    result: z.object({ sessionId: SessionId }),
  },
  /**
   * Checks an app (M4 C-3) — the same judgment as the building session's `check`. Restarts the
   * app with its current files (waiting for any in-flight call), and actually reads the tool
   * list and the screens the tools point to, returning problems with the manifest, tool names,
   * visibility scope, annotations and home. `text` is one block of text safe to send to an
   * agent. A stopped app is restarted for this too (the same as a normal restart).
   */
  'apps.check': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable() }),
    result: z.object({
      ok: z.boolean(),
      text: z.string(),
      findings: z.array(z.object({ level: z.enum(['problem', 'warning']), where: z.string(), message: z.string() })),
    }),
  },
  /**
   * Sets, changes (`value`) or removes (`null`) one of an app's secret values (M4 E, the secrets
   * field). The value lives only in a 0600 file on this machine — never in the response, the
   * list, logs or run history (the list only says whether each name is present or not,
   * `ExternalAppInfo.secrets`). Only names the manifest declares can be set. A running app is
   * brought down after finishing any in-flight call, and comes back up with the new value the
   * next time it is needed.
   */
  'apps.setSecret': {
    params: z.object({
      appId: AppId,
      projectId: ProjectId.nullable(),
      name: z.string(),
      value: z.string().max(16 * 1024).nullable(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Prepares to import an app (M4 E-3) — moves a folder or .zip on this machine (a path or a
   * `file:` address), or a .zip at an https address, into the host's waiting room, and returns
   * what the person should review (`review`). **This does not admit it yet**: discovery never
   * scans the waiting room, so nothing appears there. If the link points outside the folder, a
   * name escapes it (zip slip), the size cap is exceeded, the id breaks the rule, or the id
   * already exists, this fails with a reason and clears the waiting room. `apps.importCommit`
   * admits it; `apps.importCancel` calls it off (and the waiting room clears itself after 30
   * minutes regardless).
   */
  'apps.importPrepare': {
    params: z.object({ source: z.string().max(4096) }),
    result: z.object({ token: z.string(), review: AppReview }),
  },
  /**
   * Admits the app in the waiting room into the user folder (M4 E-3). An imported app arrives
   * **turned off** (`unconfirmed`). If `enable` is set, the person's confirmation is recorded
   * right after admission — `reviewKey` must then be the key received during preparation (what
   * turns on is exactly what the person reviewed). Rejected if the same id was created in the
   * meantime.
   */
  'apps.importCommit': {
    params: z.object({ token: z.string(), enable: z.boolean().default(false), reviewKey: z.string().optional() }),
    result: ExternalAppInfo,
  },
  'apps.importCancel': {
    params: z.object({ token: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Reviews an admitted app again (M4 E-3) — read by the confirmation window for an imported app
   * that has not been turned on, or one whose `server`/`uses` changed after being turned on and
   * needs to be asked about again. When re-asking, `changed` carries the declaration from when
   * it was turned on. Only accepts apps in the user folder (a project app follows the project's
   * trust setting instead).
   */
  'apps.review': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable() }),
    result: AppReview,
  },
  /**
   * Turns on an imported app (M4 E-3) — the host records this app's confirmation. `reviewKey` is
   * the key from the confirmation window the person saw, and the host checks it against the
   * current manifest: rejected if it has changed in the meantime (review it again, then turn it
   * on). Rejected if this is not an imported app — there is nothing to turn on.
   */
  'apps.enable': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), reviewKey: z.string() }),
    result: ExternalAppInfo,
  },
  /**
   * An app's versions (M4 E-1) — for a user-folder app, host-kept snapshots (most recent first,
   * `current` marking whichever matches the code now); for a project app, the recent commits
   * that touched that app's folder (git is the version history, read-only). If it is not a
   * repository, this returns `repo: false` with an empty list.
   */
  'apps.versions': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable() }),
    result: AppVersions,
  },
  /**
   * Restores a user-folder app to a kept version (M4 E-1). Before overwriting, it takes a
   * snapshot of the current code as a version too (so restoring can itself be undone), then
   * overwrites the files with the target version and restarts the app on that code — waiting for
   * any in-flight call to finish. An open screen reopens on the new code (`codeStamp`). If an
   * imported app's version has a different `server`/`uses`, it is asked about again. A project
   * app is rejected — git is where restoring happens for those.
   */
  'apps.restoreVersion': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), id: z.string() }),
    result: ExternalAppInfo,
  },
  'orchestrator.tools': {
    /** If sessionId is given, filters to that session's tool set (a manager under #69 gets a subset) — used by the bridge */
    params: z.object({ sessionId: SessionId.optional() }),
    result: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown() })),
  },
  'orchestrator.tool': {
    params: z.object({ sessionId: SessionId, name: z.string(), args: z.record(z.string(), z.unknown()) }),
    result: z.object({ text: z.string(), isError: z.boolean().optional() }),
  },
  /**
   * The agent tools of one external app attached to a session (M4 A-5) — called by the bridge
   * of an adapter that cannot attach in-process. The shape is exactly MCP's `Tool` (the bridge
   * hands back what it received, unchanged). Rejected if the app is not attached to that session.
   */
  'apps.sessionTools': {
    params: z.object({ sessionId: SessionId, server: z.string() }),
    result: z.object({ tools: z.array(z.record(z.string(), z.unknown())) }),
  },
  /**
   * A session's agent calls a tool of an attached app (M4 A-5) — called by the bridge. The
   * caller is that session, and it goes through the runtime's single path (visibility scope, run
   * id, history). The result has the shape of MCP's `CallToolResult`.
   *
   * `waitMs`: if a call takes longer than this, the run id and "still running" are returned
   * first (the call itself keeps going). The bridge of a tool with an outside time limit (Codex's
   * 300 seconds) sets this shorter than that limit.
   */
  'apps.sessionCall': {
    params: z.object({
      sessionId: SessionId,
      server: z.string(),
      name: z.string(),
      args: z.record(z.string(), z.unknown()),
      waitMs: z.number().int().min(1_000).max(3_600_000).optional(),
    }),
    result: z.object({
      content: z.array(z.unknown()),
      isError: z.boolean().optional(),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
    }),
  },
  /**
   * The panels placed on the grid, in order — sessions and apps (`GridPanel`, #288).
   *
   * Since this is an auto-flow grid, layout and order are the same single thing. So **adding,
   * removing and reordering are all expressed by this one operation** — "make the list look
   * like this." The answer is the list as stored: a session the host does not know, a duplicate,
   * or an app of a project that is not registered is left out. An app is not checked against the
   * app list, which can lag behind its folder; the screen leaves out one it cannot find.
   *
   * **Expanded, not replaced (protocol.md §4).** Before #288 both methods spoke in bare session
   * ids: `grid.get` answered them, `grid.set` took `{ sessionIds }`. A build that knows panels asks
   * for them (`tagged: true`, `panels`) and gets panels back; a request without them gets the old
   * shape, the sessions only. A newer UI also sends `sessionIds` next to `panels`, so an older host,
   * which strips the field it does not know, still saves the sessions. So a UI and a host one build
   * apart keep working either way, and `PROTOCOL_VERSION` stays where it is. The old fields go one
   * release later.
   */
  'grid.get': {
    params: z.object({ tagged: z.literal(true).optional() }),
    result: z.union([z.array(GridPanel), z.array(z.string())]),
  },
  'grid.set': {
    params: z
      .object({ panels: z.array(GridPanel).max(256).optional(), sessionIds: z.array(z.string()).max(256).optional() })
      .refine((p) => p.panels !== undefined || p.sessionIds !== undefined, 'panels or sessionIds is required'),
    result: z.union([z.array(GridPanel), z.array(z.string())]),
  },
  'projects.list': { params: z.object({}), result: z.array(ProjectInfo) },
  'projects.gitStatus': { params: z.object({ projectId: ProjectId }), result: ProjectInfo },
  'sessions.list': { params: z.object({}), result: z.array(SessionInfo) },
  'sessions.rename': {
    params: z.object({ sessionId: SessionId, name: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /*
   * sessions.setKind, which used to be here (the promote/demote from #13), was discontinued
   * (2026-09-01). There is now only one orchestrator per app (the central one), and the role
   * that directs sessions inside a project is the worktree manager (#69) instead — a role is not
   * chosen; it comes from the relationship.
   */
  'sessions.markRead': {
    params: z.object({ sessionId: SessionId, seq: z.number() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'messages.load': {
    params: z.object({ sessionId: SessionId, limit: z.number().default(200), beforeSeq: z.number().optional() }),
    result: z.array(StoredMessage),
  },
  /**
   * The steps of the native subagent one card launched (#222), oldest first, `afterSeq` paging forward. `seq` here is
   * the step's number within that launch, not a conversation number.
   *
   * Only asked for when the person opens that card's steps: they are not in `messages.load`, and nothing else reads
   * them. Tool calls and results come as their cards (`summary`), the same as a history page (#221).
   */
  'messages.subagent': {
    params: z.object({
      sessionId: SessionId,
      parentCallId: z.string(),
      afterSeq: z.number().optional(),
      limit: z.number().default(SUBAGENT_STEPS_PAGE),
    }),
    result: z.array(StoredMessage),
  },
  /**
   * A project's terminal list.
   *
   * **A terminal's identity is its cwd** — not a session.
   * So switching sessions within the same project keeps the same terminals continuing, and
   * once a git worktree session exists later, it has its own terminals since its cwd differs.
   */
  /**
   * The slash commands (skills) available in this session.
   *
   * ready=false means **the tool is not ready yet**, not that there are none — right after a
   * session is created, the CLI is still starting up and cannot be asked yet.
   * The UI distinguishes this, showing "none" and "loading" differently.
   */
  'agents.commands': {
    params: z.object({ sessionId: SessionId }),
    result: z.object({ ready: z.boolean(), commands: z.array(CommandInfo) }),
  },
  /**
   * Account usage and limits (FR-9). Only covers subscription limits.
   * If supported=false, a reason comes with it — distinguishing what the tool cannot give from
   * what we failed to read.
   */
  /**
   * The list of selectable models. Carries exactly what the tool reports through its official
   * API. An older tool may not know this, so it comes back as supported=false plus a reason.
   */
  'agents.models': {
    params: z.object({ tool: ToolName }),
    result: z.object({
      supported: z.boolean(),
      reason: z.string().optional(),
      models: z.array(ModelOption),
    }),
  },
  'agents.usage': {
    params: z.object({ tool: ToolName }),
    result: z.object({ supported: z.boolean(), reason: z.string().optional(), usage: UsageSnapshot.nullable() }),
  },
  /** File search for `@` autocomplete (within the project only) */
  /**
   * Leftover processes still running under our folder (requested by the person on 2026-09-07).
   *
   * A dev server an agent started via bash has both its parent and its process group detached
   * from ours, so our shutdown procedure cannot catch it (measured). Instead of killing it, this
   * **shows it** and lets the person choose.
   */
  'processes.strays': {
    params: z.object({}),
    result: z.array(z.object({ pid: z.number(), command: z.string(), cwd: z.string() })),
  },
  /** Stops the chosen ones (SIGTERM). The host re-measures the condition right before killing them */
  'processes.stop': {
    params: z.object({ pids: z.array(z.number()) }),
    result: z.object({ stopped: z.number() }),
  },
  'files.search': {
    params: z.object({ projectId: ProjectId, query: z.string(), limit: z.number().default(20) }),
    result: z.array(z.object({ path: z.string(), name: z.string() })),
  },
  'terminal.list': {
    params: z.object({ projectId: ProjectId }),
    result: z.object({ terminals: z.array(TerminalInfo) }),
  },
  /** Opens one more terminal */
  'terminal.create': {
    params: z.object({ projectId: ProjectId, cols: z.number().default(80), rows: z.number().default(24) }),
    result: TerminalInfo,
  },
  /** Closes one terminal (ends the shell and discards its history) */
  'terminal.close': {
    params: z.object({ terminalId: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'terminal.input': {
    params: z.object({ terminalId: z.string(), data: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'terminal.resize': {
    params: z.object({ terminalId: z.string(), cols: z.number(), rows: z.number() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Ends the shell and starts a fresh one (for when it hangs) */
  'terminal.restart': {
    params: z.object({ terminalId: z.string(), cols: z.number().default(80), rows: z.number().default(24) }),
    result: TerminalInfo,
  },
  /** Runs a frequently used command (#60). If the same command is already running, it is killed and restarted */
  'commands.run': {
    params: z.object({ projectId: ProjectId, command: z.string(), cols: z.number().default(100), rows: z.number().default(30) }),
    result: CommandRunInfo,
  },
  /** Stops a dev server. The log remains — an exit is also a result */
  'commands.stop': {
    params: z.object({ projectId: ProjectId, command: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** The status of commands that have run before (for list badges — the log itself comes from commands.log) */
  'commands.state': {
    params: z.object({ projectId: ProjectId }),
    result: z.object({ runs: z.array(CommandRunInfo) }),
  },
  /** The last run of one command, log included. Null if it has never run */
  'commands.log': {
    params: z.object({ projectId: ProjectId, command: z.string() }),
    result: z.object({ run: CommandRunInfo.extend({ history: z.string() }).nullable() }),
  },
  'commands.resize': {
    params: z.object({ projectId: ProjectId, command: z.string(), cols: z.number(), rows: z.number() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Where this install stands against the registry (issue #43).
   *
   * `force` is the difference between "what do you already know" (app start, cheap,
   * no network) and "go look now" (the Check now button). One method rather than two
   * because the answer is the same shape either way, and a caller that wants a fresh
   * answer wants the same fields a stale one has.
   *
   * **This never rejects for a network failure.** A version check that can break the
   * screen it decorates is worse than no version check; what went wrong comes back in
   * `error` instead, where the person who pressed the button can read it.
   */
  'updates.status': {
    params: z.object({ force: z.boolean().default(false) }),
    result: UpdateStatus,
  },
  /**
   * Turn the periodic check on or off.
   *
   * The host holds this, not the UI, because the host is what owns the timer — a
   * preference kept on the other side of the wire from the thing it governs is one
   * that eventually stops governing it.
   */
  'updates.setAuto': {
    params: z.object({ enabled: z.boolean() }),
    result: UpdateStatus,
  },
  /**
   * Install the newer version. **Explicitly asked for — never automatic.**
   *
   * Answers as soon as the work has *started*, not when it has finished: `npm i -g`
   * routinely outruns the 30s RPC deadline, and a call that times out while the
   * install keeps going leaves the screen saying the opposite of what happened.
   * Progress arrives as `update_status` events instead.
   */
  'updates.apply': {
    params: z.object({}),
    result: UpdateStatus,
  },
  /**
   * Reads screen settings (UiPreferences).
   *
   * **Lives on the startup path.** A slow response does not just end up being slow — the
   * composer stands briefly under the old rule and then the rule changes out from under the
   * person's fingers. So this call goes out together with everything else done before the screen
   * appears, and a failure is filled in with defaults.
   */
  'prefs.get': {
    params: z.object({}),
    result: UiPreferences,
  },
  /**
   * Records only what changed. The result is **the entire record, after being written**.
   *
   * This is so the writer uses what it gets back rather than trusting what it sent — the stored
   * shape has to be exactly the shape the screen follows, or a setting that failed to save can
   * end up looking turned on only on the screen.
   */
  'prefs.set': {
    params: z.object({ patch: UiPreferencesPatch }),
    result: UiPreferences,
  },
  /**
   * The theme files in the data folder's `themes/` (#312), as the host read them. A file that
   * does not read cleanly is still listed, with its problems, so Settings can say what is wrong
   * next to it instead of the theme silently vanishing.
   */
  'themes.list': {
    params: z.object({}),
    result: z.array(ThemeFileEntry),
  },
  /**
   * Writes a theme file, atomically (temp file and rename): a watcher, an editor or an agent
   * reading the folder never sees half a file. `id` null creates a new file named after the theme.
   */
  'themes.save': {
    params: z.object({ id: ThemeId.nullable(), content: ThemeFileContent }),
    result: ThemeFileEntry,
  },
  /**
   * Copies a theme file from elsewhere on disk into the folder (Import). The copy is validated
   * like any other file and gets a fresh id if the name is taken.
   */
  'themes.import': {
    params: z.object({ path: z.string() }),
    result: ThemeFileEntry,
  },
  /**
   * The absolute path of a theme file, for the shell to trash or reveal (the same two-step as
   * `fs.resolve`: the host knows the folder, the shell knows the OS).
   */
  'themes.resolve': {
    params: z.object({ id: ThemeId }),
    result: z.object({ path: z.string() }),
  },
  'approvals.rules': {
    params: z.object({ projectId: ProjectId.optional() }),
    result: z.array(
      z.object({
        id: z.number(),
        scope: ApprovalScope,
        matcher: z.string(),
        decision: z.string(),
        createdAt: z.number(),
        /** Which project or session this rule belongs to — the same rule from two different projects used to look like one identical row in Settings (#183) */
        projectId: z.string().nullable().default(null),
        sessionId: z.string().nullable().default(null),
      }),
    ),
  },
  /**
   * The trash (#204). Only the person reaches these: the RPC is the UI's channel, and neither the agents' tools nor
   * the apps' broker has a trash or purge verb. `agents.deleteSession` is the way in.
   *
   * `bytes` is the total of every session's `bytes` — shown because nothing empties the trash on its own.
   */
  'trash.list': {
    params: z.object({}),
    result: z.object({ sessions: z.array(TrashedSession), bytes: z.number() }),
  },
  /** A trashed conversation, read-only — the same page shape as `messages.load` */
  'trash.read': {
    params: z.object({ sessionId: SessionId, limit: z.number().default(200), beforeSeq: z.number().optional() }),
    result: z.array(StoredMessage),
  },
  /**
   * Brings a session back as it was. `project` is set when its project had been deleted and restoring registered
   * the folder again — the screen has not heard of that project yet.
   */
  'trash.restore': {
    params: z.object({ sessionId: SessionId }),
    result: z.object({ session: SessionInfo, project: ProjectInfo.nullable() }),
  },
  /** Deletes one session in the trash for good, with what the person chose to remove with it */
  'trash.purge': {
    params: z.object({ sessionId: SessionId }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Deletes everything in the trash for good. One that fails stays in the trash and is reported; the rest go on */
  'trash.empty': {
    params: z.object({}),
    result: z.object({
      purged: z.number(),
      failed: z.array(z.object({ sessionId: z.string(), name: z.string(), error: z.string() })),
    }),
  },
} as const

export type RpcMethodName = keyof typeof RpcMethods

/**
 * What the **sender** has to provide (`z.input`).
 *
 * Why not the output type: a field with `.default()` is filled in by the parser, so the caller
 * is allowed to omit it. Collapsing the two into one produces spots like `files.search`'s
 * `limit` that insist on being required when they are actually optional — this actually
 * happened once.
 */
export type RpcParams<M extends RpcMethodName> = z.input<(typeof RpcMethods)[M]['params']>

/** What the **receiver** holds in hand (`z.output`) — after defaults have been filled in */
export type RpcResult<M extends RpcMethodName> = z.output<(typeof RpcMethods)[M]['result']>
