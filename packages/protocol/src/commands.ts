import { z } from 'zod'
import { AppReach } from './app-drag.js'
import { ATTACHMENT_MAX_BASE64, FsEntry, FsFile, MessageImage } from './commands/files.js'
import { machineField, machineParam } from './commands/machine-fields.js'
import { CommandInfo, CommandRunInfo, ProjectInfo, SavedCommand, TerminalInfo } from './commands/projects.js'
import {
  CreateSessionParams,
  SUBAGENT_STEPS_PAGE,
  SessionInfo,
  StoredMessage,
  TrashedSession,
  UpdateSettingsParams,
  UpdateSettingsResult,
} from './commands/sessions.js'
import {
  AdapterCapabilities,
  AgentVersions,
  AppErrorBundle,
  AppId,
  AppPermission,
  AppQuestion,
  AppReview,
  AppRun,
  AppUsage,
  AppVersions,
  ApprovalDecision,
  ApprovalScope,
  Attachment,
  CacheStats,
  ExternalAppInfo,
  ExternalSession,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileStatus,
  GitSource,
  GridPanel,
  ModelOption,
  ProjectConsent,
  ProjectConsentKind,
  ProjectId,
  QuestionAnswer,
  SessionId,
  SleepPolicy,
  ToolName,
  ToolStatus,
  UiPreferences,
  UiPreferencesPatch,
  UpdateStatus,
  UsageSnapshot,
} from './entities.js'
import {
  HostActivity,
  HostReadSessionResult,
  HostRecallHit,
  HostSessionRow,
  MachineAutostartResult,
  MachineId,
  MachineInfo,
  MachineInstallResult,
  MachineProbe,
  MachineUninstallResult,
  RemoteShell,
  SshHostList,
} from './machines.js'
import { ThemeFileContent, ThemeFileEntry, ThemeId } from './theme.js'
import { parseTolerant } from './tolerant.js'

/** UI → host RPC. Maps one-to-one to the port interface (platform/ports) (docs/protocol.md §3) */

export * from './commands/sessions.js'
export * from './commands/projects.js'
export * from './commands/files.js'

const AppHomeViewResult = z.object({
  instanceId: z.string(),
  tool: z.string(),
  resourceUri: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
  toolResult: z.looseObject({ content: z.array(z.record(z.string(), z.unknown())) }),
  runId: z.string(),
})

/*
 * One literal on purpose (#850): it is the table of every method, and its key order is observable
 * (`scripts/smoke-schemas.mts` calls the methods in this order). The shapes it carries live in commands/ and
 * entities/.
 */
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
  'agents.worktreeStatus': {
    params: z.object({ sessionId: SessionId }),
    result: z
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
  'agents.capabilities': { params: z.object({ tool: ToolName, ...machineParam }), result: AdapterCapabilities },
  'agents.detect': {
    params: z.object({ ...machineParam }),
    result: z.array(ToolStatus),
  },
  /**
   * The agent CLIs installed now (#297). `force: false` (the window gaining focus) answers with what is known when it
   * was read moments ago; `force: true` reads again. Reading costs no process where the CLI came from npm (its
   * `package.json` says the version), so this is cheap either way.
   */
  'agents.versions': {
    params: z.object({ force: z.boolean().default(false), ...machineParam }),
    result: AgentVersions,
  },
  /** "Move idle sessions to a newly installed agent CLI" on or off (#297). On by default */
  'agents.setAutoApplyVersions': {
    params: z.object({ enabled: z.boolean(), ...machineParam }),
    result: AgentVersions,
  },
  /**
   * Restarts every session that runs an older CLI than the one installed and is fully idle, on the installed one
   * (#297) — the session header's one app-wide action. A session that is working, waiting on the person, or running
   * background tasks is left as it is and listed in `busy`; with `autoApply` on it moves once it is idle.
   */
  'agents.applyVersions': {
    params: z.object({ ...machineParam }),
    result: z.object({ restarted: z.array(z.string()).default([]), busy: z.array(z.string()).default([]) }),
  },
  /** When idle sessions go to sleep (#568): this host's setting */
  'agents.sleepPolicy': { params: z.object({ ...machineParam }), result: SleepPolicy },
  /** "Put idle sessions to sleep after" (#568). `afterMinutes: null` never; 15 by default */
  'agents.setSleepPolicy': {
    params: z.object({ afterMinutes: z.number().int().positive().nullable(), ...machineParam }),
    result: SleepPolicy,
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
    result: z.array(FsEntry),
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
    result: FsFile,
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
  /**
   * A local image an agent wrote into a reply as Markdown (`![alt](/path/to/shot.png)`). The window cannot load
   * a file path itself (its origin is the app, and its CSP takes images from `data:` and `blob:` only), so the host
   * reads it: wherever it is on that machine, but only a path that appears in one of this session's own replies, only
   * PNG, JPEG, GIF or WebP by their bytes, and at most `IMAGE_PREVIEW_MAX_BYTES` (docs/security-boundaries.md,
   * "Images a reply names"). `path` is the string as the reply wrote it: `~`, a path relative to the session's folder
   * and a `file://` URL are resolved by the host.
   */
  'messages.image': {
    params: z.object({ sessionId: SessionId, path: z.string().min(1).max(4096) }),
    result: MessageImage,
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
  'projects.add': { params: z.object({ path: z.string(), ...machineParam }), result: ProjectInfo },
  /**
   * Makes a new project (#515): an **empty** folder named `name` (no git init, no template) inside `parent`, or
   * `~/Centralu` (`PROJECTS_DIR`) of the machine the project lives on when `parent` is absent, then registers it as `projects.add` does.
   * The machine's own host makes it. Refused with one sentence when the name is not one folder name, when `parent` is
   * not a full path to a folder, or when anything of that name is already there: nothing existing is reused.
   *
   * With `source` the folder is a **clone** of that repository instead of empty, made by that machine's own git with
   * its own saved sign-ins, never asking for one (a repository that needs a password it does not have is refused with
   * one sentence). An empty `name` is then the repository's own (`repoNameOf`). A failed clone leaves nothing: the
   * folder it made is removed and no project is registered. Submodules are not cloned.
   */
  'projects.create': {
    params: z.object({ name: z.string().max(255), parent: z.string().max(4096).optional(), source: GitSource.optional(), ...machineParam }),
    result: ProjectInfo,
  },
  /**
   * Where `projects.create` would make the folder, without making anything (#515): the dialog shows it as the person
   * types. `parent` is the resolved location (that machine's `~/Centralu` when none is given). With an empty name, `path` and `error`
   * are null; otherwise exactly one of them is set, `error` being the sentence `projects.create` would refuse with.
   */
  'projects.createPreview': {
    params: z.object({ name: z.string().max(255), parent: z.string().max(4096).optional(), source: GitSource.optional(), ...machineParam }),
    result: z.object({ parent: z.string(), path: z.string().nullable(), error: z.string().nullable() }),
  },
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
  /**
   * Sets the project's worktree trunk (#76): where a new worktree forks from by default and what "merged" is measured
   * against. Since the worktree manager was folded into ordinary sessions (#561 part 3), `worktrees.createManager` is
   * refused and this is how the trunk is chosen; `ProjectInfo.worktreeManager.baseBranch` still carries it.
   */
  'worktrees.setTrunk': {
    params: z.object({ projectId: ProjectId, baseBranch: z.string() }),
    result: z.object({ ok: z.literal(true) }),
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
   * What an open screen instance shows, for a hub that serves it in its own window (#82, remote hub phase 2,
   * docs/plans/remote-hub.md §11). A host asks this of a linked machine; the UI never needs it.
   *
   * The instance decides the app, as everywhere: the answer names it, the resource it reads, and the origin method
   * its manifest asks for. `resource` is the app's MCP `resources/read` answer as is: the hub reads the view out of it
   * and applies its own CSP, sandbox and origin rules, so nothing that decides a view's reach is taken from the other
   * machine as finished text. An instance that is not open there fails with a reason. Additive: an older host answers
   * "Unknown method", and the hub's window says that view cannot open until the versions are aligned.
   */
  'apps.viewDocument': {
    params: z.object({ instanceId: z.string() }),
    result: z.object({
      appId: AppId,
      projectId: z.string().nullable(),
      uri: z.string(),
      origin: z.enum(['opaque', 'app']),
      resource: z.looseObject({ contents: z.array(z.unknown()) }),
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
   * (not trusted, or failed to start), this fails with a reason and leaves no live screen behind. A
   * keyed open keeps only a failure reservation during the lease grace period, without holding the app. If
   * the app itself answered with a failure, this still opens — drawing a failure is also the
   * screen's job.
   *
   * `machine` (#82, additive) names a linked machine for its user-folder app, which has no project id to say so; the
   * hub opens it there and hands back the instance qualified. Ignored with a project, whose id already names its
   * machine. Absent: this host's own app, as before.
   */
  'apps.openView': {
    // openKey: one client-chosen UUID per logical open. Repeats reuse the instance and home outcome,
    // including after a planned host handover, so a lost answer never runs the home tool twice.
    /*
     * `lease` (#392, additive): the view belongs to this window's connection. Once the connection ends, the host waits
     * a few minutes for a window to claim it (`apps.holdViews`) and then closes it, so a reloaded or closed window does
     * not hold its apps open for good. Without it (an older window, or a linked machine's view) the view lives until
     * `apps.closeView`.
     */
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, lease: z.boolean().optional(), openKey: z.string().uuid().optional() }),
    result: AppHomeViewResult,
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
  /** Reclaims a keyed home open after losing its answer; never calls the home tool. */
  'apps.recoverView': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, lease: z.boolean().optional(), openKey: z.string().uuid() }),
    result: AppHomeViewResult,
  },
  /**
   * A window claims the pinned screens it shows (#392), after every reconnect: each leased instance
   * named becomes this connection's again and stops waiting to be closed. `missing` lists the ids
   * that are not open any more (the window was away longer than the host waited); the window opens
   * those again. An instance opened without a lease is left as it is.
   */
  'apps.holdViews': {
    params: z.object({ instanceIds: z.array(z.string()).max(1000) }),
    result: z.object({ missing: z.array(z.string()) }),
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
   * A screen calls an app tool (M4 A-4).
   *
   * An app is unique per (project, id), so `projectId` distinguishes it (null or absent = a
   * user-folder app). The caller is recorded **as a screen**, and only tools open to a screen
   * (with `app` in `visibility`) can be called. `result` is exactly the app's own answer (the
   * shape the screen's AppBridge receives). If `status` is `rejected`, the host never sent it to
   * the app at all — the reason is in `text`.
   *
   * This door once also served the compiled-in apps (#81); they were removed in #372.
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
  /**
   * Discovered external apps (M4 A-2) — project apps and user-folder apps. Apps from an
   * untrusted project and apps with a broken manifest are listed too, with a reason (`status`,
   * `error`): hiding them would leave nowhere to ask why they do not show up.
   */
  'apps.list': { params: z.object({}), result: z.array(ExternalAppInfo) },
  /**
   * Lets a stopped (`failed`) external app be started again — clears the run of consecutive
   * failures, and takes it down if it happens to be up. **Does not start it**: whatever calls
   * next starts it (the same principle: it starts only the first time it is actually needed).
   */
  /** The run history of one external app, most recent first (M4 A-6 — read by the run history screen B-7) */
  'apps.runs': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, limit: z.number().int().min(1).max(500).default(100) }),
    result: z.array(AppRun),
  },
  'apps.restart': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
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
    /** `machine` (#82, additive): a linked machine's user-folder app, removed on that machine; this host's app of the same id is untouched */
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
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
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
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
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
    result: z.object({ latest: AppErrorBundle.nullable(), recent: z.array(AppErrorBundle) }),
  },
  /**
   * Whether a session can use one app's tools right now, and if not, why (#308). Asked when an item
   * dragged out of that app's view is dropped on the session's composer: the link goes in either
   * way, and a session that cannot reach the app gets a notice saying what would fix it. Decided by
   * the host from the same rule that attaches apps (apps.md §9.1) and from what the session's live
   * agent actually has (a Codex thread keeps the servers it started with). A session that is not
   * running counts as reachable when the rule gives it the app: it attaches the app when it wakes.
   */
  'apps.reach': {
    params: z.object({ sessionId: SessionId, appId: AppId, projectId: ProjectId.nullable() }),
    result: AppReach,
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
  /**
   * Every remembered cross-project consent (#371): which project may reach which, and how ('delegate' — ask_project
   * starts a session there; 'apps' — its apps attach to the caller). Listed in Settings, newest first, with the
   * project names as they are now. Refetched whenever `project_consents_changed` arrives.
   */
  'projectConsents.list': { params: z.object({}), result: z.array(ProjectConsent) },
  /** Revokes one remembered consent (#371) — the next reach from that project to that one asks again */
  'projectConsents.revoke': {
    params: z.object({ fromProjectId: ProjectId, toProjectId: ProjectId, kind: ProjectConsentKind }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** The remembered capability answers for one app (M4 D-4) — shown next to the run history panel (B-7) and can be forgotten there */
  'apps.permissions': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
    result: z.array(AppPermission),
  },
  /** Forgets one remembered answer (M4 D-4) — the next attempt to use that capability asks again */
  'apps.forgetPermission': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, capability: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * How much agent use one app requested (M4 D-5) — how many times, for how long, how many
   * tokens. Read by the run history panel. Even for an app whose folder is gone, this is still
   * readable as long as the record remains.
   */
  'apps.usage': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
    result: AppUsage,
  },
  'apps.createBuilder': {
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, tool: ToolName.optional() }),
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
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, at: z.number() }),
    result: z.object({ sessionId: SessionId }),
  },
  'apps.askBuilder': {
    params: z.object({
      appId: AppId,
      projectId: ProjectId.nullable(),
      ...machineParam,
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
   * Shares a project app with the person's other projects, or stops sharing it (#371 part A). Off by
   * default: a project app is that project's own. A shared app can be found and attached by a session
   * in another project (`find_apps`, `attach_app`), after the person allows that pair of projects once.
   * Turning it off detaches it from every session that attached it. A user-folder app is the person's
   * own and available everywhere already, so it has no such switch (refused).
   */
  'apps.setShared': {
    params: z.object({ appId: AppId, projectId: ProjectId, shared: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
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
      ...machineParam,
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
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam }),
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
    params: z.object({ appId: AppId, projectId: ProjectId.nullable(), ...machineParam, id: z.string() }),
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
    params: z.object({ tool: ToolName, ...machineParam }),
    result: z.object({
      supported: z.boolean(),
      reason: z.string().optional(),
      models: z.array(ModelOption),
    }),
  },
  'agents.usage': {
    params: z.object({
      tool: ToolName,
      /**
       * `false`: answer the prompt cache figures only and do not read the account's limits (#726). The hub asks a
       * linked machine this when it shows its own limits for it (same account), so that machine does not start a
       * reading of limits nobody will look at. Absent: read them.
       */
      limits: z.boolean().optional(),
      ...machineParam,
    }),
    result: z.object({
      supported: z.boolean(),
      reason: z.string().optional(),
      usage: UsageSnapshot.nullable(),
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
  },
  /**
   * Which account a tool is logged in to on this host, as an opaque fingerprint (#726). The hub compares its own with a
   * linked machine's to know the two share one account's limits. Nothing readable leaves the host: not the email, not
   * the organisation id. `fingerprint` is null when the tool is not logged in with an account, or does not say which.
   * `loggedIn` is null when the tool cannot tell.
   */
  'agents.account': {
    params: z.object({ tool: ToolName, ...machineParam }),
    result: z.object({ loggedIn: z.boolean().nullable(), fingerprint: z.string().nullable() }),
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
    params: z.object({ ...machineParam }),
    result: z.array(z.object({ pid: z.number(), command: z.string(), cwd: z.string() })),
  },
  /** Stops the chosen ones (SIGTERM). The host re-measures the condition right before killing them */
  'processes.stop': {
    params: z.object({ pids: z.array(z.number()), ...machineParam }),
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
   * "Apply updates automatically when idle" on or off (#352). The host holds it for the same
   * reason as `updates.setAuto`: the host is what installs. Turning it on with a newer version
   * already known starts the install at once; the window applies it once nothing is busy.
   */
  'updates.setAutoApply': {
    params: z.object({ enabled: z.boolean() }),
    result: UpdateStatus,
  },
  /**
   * Install the newer version. Asked for by the person, or by `autoApply` (#352) when a check
   * finds a newer version — never otherwise.
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
   * A window's answer to `update_apply_request` (#665): whether its "Apply now" could relaunch into the installed build
   * right now, and why not. The first window that is ready gets a ticket; every other answer, and any answer after the
   * host stopped asking, gets null.
   */
  'updates.answerApply': {
    params: z.object({ requestId: z.string(), ready: z.boolean(), reason: z.string().optional(), version: z.string().optional() }),
    result: z.object({ ticket: z.string().nullable() }),
  },
  /**
   * The picked window's outcome (#665): `started` right before it relaunches, then with `error` when it did not, or
   * with neither once the shell accepted the relaunch. A relaunching window may close before that last report; the
   * host reads its connection ending as the relaunch only after `started`.
   */
  'updates.reportApply': {
    params: z.object({ requestId: z.string(), ticket: z.string(), started: z.boolean().optional(), error: z.string().optional() }),
    result: z.object({}),
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
        /** A rule of a linked machine (#82): its `id` is then folded into a negative number the hub maps back */
        ...machineField,
      }),
    ),
  },
  /**
   * Linked machines (#82, docs/plans/remote-hub.md). The hub's own: these are never forwarded.
   * Adding one is the consent for this computer to reach that machine (plan §3.2): the person can
   * already open an SSH connection to it. The link uses the person's own `ssh` and keys
   * (`BatchMode`), and expects `centralu serve` running there (docs/agent-host.md §4.7).
   */
  'machines.list': { params: z.object({}), result: z.array(MachineInfo) },
  'machines.add': {
    params: z.object({
      name: z.string().min(1).max(64),
      sshTarget: z.string().min(1).max(255),
      shell: RemoteShell.default('posix'),
      wslDistro: z.string().max(64).nullable().optional(),
      command: z.string().max(1024).nullable().optional(),
    }),
    result: MachineInfo,
  },
  /**
   * The concrete `Host` aliases of the ssh config of the computer this host runs on (#514): `~/.ssh/config`
   * and what it `Include`s, read by the host (never the window), each resolved by `ssh -G`, with the
   * machines already linked through it. Pattern-only entries and `Match` blocks are left out. Nothing
   * is connected to and no key file is opened. Additive
   */
  'machines.sshHosts': { params: z.object({}), result: SshHostList },
  /**
   * One BatchMode ssh to a target, to tell what runs there before it is linked (#514): a Unix shell, or
   * Windows with its default shell and WSL distros. Never a password or host-key prompt; a target that
   * cannot be reached answers `reachable: false` with ssh's reason. Nothing there is changed. Additive
   */
  'machines.probe': { params: z.object({ sshTarget: z.string().min(1).max(255) }), result: MachineProbe },
  /** Unlinks a machine: its sessions and projects leave this computer's lists. Nothing on the machine changes */
  'machines.remove': { params: z.object({ machineId: MachineId }), result: z.object({ ok: z.literal(true) }) },
  /** Tries the link again now instead of waiting out its backoff */
  'machines.reconnect': { params: z.object({ machineId: MachineId }), result: MachineInfo },
  /**
   * Connects although the two sides run different versions of one protocol: the person declined to
   * align them (plan §4). Remembered for this pair of versions only; when either side moves, the
   * question comes again. Refused when the protocols differ.
   */
  'machines.acceptVersions': { params: z.object({ machineId: MachineId }), result: MachineInfo },
  /**
   * Installs this hub's version on a linked machine over its ssh (docs/plans/remote-hub.md §10.2):
   * the pinned Node and the npm packages, checked against the release's pin and the registry's
   * signed metadata, beside what is there, with `current` switched to it and `previous` kept. A
   * host running there is not touched; the next start runs the new version (`machines.update` stops
   * and starts it in order). Refused by a development hub (its version is not on npm) and for
   * a machine that runs a command of its own; answers when the install is done or refused
   */
  'machines.install': { params: z.object({ machineId: MachineId }), result: MachineInstallResult },
  /**
   * Updates a linked machine to this hub's version (docs/plans/remote-hub.md §10.5): installs it beside
   * the running one, stops the running host in order (`centralu serve --stop`; without a keeper its
   * agents end and resume on the new host, a turn in progress is lost), switches `current`, starts it
   * (`serve --detach`) and waits at most 30 s for a hello from the new version. When none comes, the
   * old version is put back and started, and the call fails with the end of the new host's log. On
   * success only the current and previous versions are kept. Progress is the machine's `operation`
   * in `machine_status`. Refused like `machines.install`
   */
  'machines.update': { params: z.object({ machineId: MachineId }), result: MachineInstallResult },
  /**
   * Switches a machine back to the version the hub installed before (`previous`), stopping and starting
   * its host as `machines.update` does and checking the same way. One step only: `previous` is cleared,
   * so a second rollback is not offered (a store migrated twice may not read on the older build)
   */
  'machines.rollback': { params: z.object({ machineId: MachineId }), result: MachineInstallResult },
  /**
   * Stops the host there and removes what the hub installed (`<data>/remote/`), keeping the machine's
   * data and an npm install of its own. The machine stays linked
   */
  'machines.uninstall': { params: z.object({ machineId: MachineId }), result: MachineUninstallResult },
  /**
   * Starts a linked machine's host at boot, or stops doing that, or (without `on`) reads whether it
   * does (docs/plans/remote-hub.md §10.4, owner decision 4: per machine, off by default). The
   * Centralu there writes its own entry (`centralu serve --autostart`): a systemd user unit with
   * lingering on Linux, a scheduled task at sign-in on Windows and for WSL. A host running there is
   * neither started nor stopped. Refused by a machine that predates it or offers none (macOS)
   */
  'machines.autostart': { params: z.object({ machineId: MachineId, on: z.boolean().optional() }), result: MachineAutostartResult },
  /**
   * What would stop on a linked machine if its host stopped now (`host.activity`, asked of it), for the
   * "Update <machine>" prompt. Null when the machine cannot say (unreachable, other protocol, older)
   */
  'machines.activity': { params: z.object({ machineId: MachineId }), result: z.object({ activity: HostActivity.nullable() }) },
  /** What would stop if this host stopped now (the `hostBusy` rule); for a hub's `machines.activity` */
  'host.activity': { params: z.object({}), result: HostActivity },
  /**
   * What a hub's orchestrator reads about this host's sessions (docs/plans/remote-hub.md §12): the sessions a hub's
   * window shows (not this host's orchestrator or coordinators), one conversation, and a search over them. Asked of a
   * linked machine by the hub directly, never routed; this host's own window has no use for them. A read is capped at
   * 200 lines and a search at 50 hits
   */
  'host.sessions': { params: z.object({}), result: z.array(HostSessionRow) },
  'host.readSession': {
    params: z.object({
      sessionId: SessionId,
      limit: z.number().int().positive().optional(),
      /** A `seq` `host.recall` gave: reads around it rather than the end */
      around: z.number().int().optional(),
      /** Tool calls in full rather than one line each */
      tools: z.boolean().optional(),
    }),
    result: HostReadSessionResult,
  },
  'host.recall': { params: z.object({ query: z.string(), limit: z.number().int().positive().optional() }), result: z.array(HostRecallHit) },
  /**
   * An instruction from a hub's orchestrator to one of this host's sessions (docs/plans/remote-hub.md §12, phase 4
   * step 2): delivered as the orchestrator's `send_to_session` is here, recorded as sent by `from.name`. Only a session
   * a hub is shown (not this host's orchestrator or coordinators). Asked by the hub directly, never routed
   */
  'host.send': {
    params: z.object({ sessionId: SessionId, text: z.string(), from: z.object({ name: z.string() }) }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Stops this host the way a signal would: agents, terminals, command runs and app processes
   * stopped in order, the store closed, then exit. For `centralu serve --stop` (docs/agent-host.md
   * §4.7): on Windows a launcher can only be killed, and killing it ends the host without its
   * shutdown. Answers before the host starts to leave. Refused by a host under the app's keeper,
   * which the app stops (and which would only start the host again).
   */
  'host.stop': { params: z.object({}), result: z.object({ ok: z.literal(true) }) },
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

/**
 * A host's answer to `method`, as the receiving client holds it: through the method's result schema, so every field
 * the protocol added with a default has that default even when an older host never sent it (#280 lets a window
 * attach to an older host). Tolerant, not strict — see `parseTolerant`. Call it once, at the client's boundary.
 */
export function parseRpcResult<M extends RpcMethodName>(method: M, raw: unknown): RpcResult<M> {
  return parseTolerant(RpcMethods[method].result, raw) as RpcResult<M>
}
