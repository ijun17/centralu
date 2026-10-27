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
import { SendIntent, SUBAGENT_STEPS_PAGE } from '../sessions.js'

/** The parameters of the `sessions` methods, which the host validates (docs/protocol.md §3). Their results: ./sessions.results.ts */
export const sessionsParams = {
  'agents.createSession': CreateSessionParams,
  'agents.send': z.object({
    sessionId: SessionId,
    text: z.string(),
    attachments: z.array(Attachment).optional(),
    /*
     * What the message means to a delegation report the session owes (#1377), when the person chose: `ask` (the default,
     * "Just asking": the person's own turn, not reported), `task` ("Add to the task": its turn is the delegated work's,
     * noted as the person's addition), `takeover` ("Take it over": the report closes and the caller is told once)
     */
    intent: SendIntent.optional(),
  }),
  /**
   * The delegation report a session owes (#1377), for the composer's "Working for <caller>" choice: who is waiting for
   * its work, here or on a linked machine. `null` when it owes none.
   */
  'agents.reportOwed': z.object({ sessionId: SessionId }),
  'agents.respondApproval': z.object({
    sessionId: SessionId,
    requestId: z.string(),
    decision: ApprovalDecision,
    scope: ApprovalScope.optional(),
    /** The target pattern for "always allow." Computed by the core and sent by the UI */
    matcher: z.string().optional(),
  }),
  /**
   * Answers a set of choices (AskUserQuestion). The answer returns to the model as that tool's
   * result.
   *
   * Kept separate from approval because what goes back is different — an approval is whether to
   * run at all, while this is **content**. If there are several questions, several answers
   * arrive together.
   */
  'agents.answerQuestion': z.object({
    sessionId: SessionId,
    requestId: z.string(),
    answers: z.array(QuestionAnswer),
  }),
  'agents.interrupt': z.object({ sessionId: SessionId }),
  /**
   * Stops one background task of the session (#290) — only one the adapter marked `stoppable`. Claude stops it with
   * `stopTask`, Codex by interrupting the child thread's own turn. The task leaves the live set through the session's
   * next `background_tasks` event, with its ending, as for any other ending; this only asks.
   */
  'agents.stopBackgroundTask': z.object({ sessionId: SessionId, taskId: z.string() }),
  /** Takes the ended tasks off the session's list (#290). Running ones stay; they are the tool's to end */
  'agents.clearBackgroundTasks': z.object({ sessionId: SessionId }),
  /**
   * Moves a session to the trash (#204). Nothing is destroyed here: the rows, the attachments, the handoff note, the
   * tool's conversation file and the worktree all stay until the person deletes it for good in Settings
   * (`trash.purge` / `trash.empty`). The two flags only record what that later step removes.
   *
   * There used to be an archive ahead of this (hiding a session from the list only). It was
   * discontinued on 2026-09-02: it had a door in (the inbox's `d`) and no door out, so to the
   * person it was indistinguishable from deletion. The trash is that shape with its exits built in the same change: list, read, restore.
   */
  'agents.deleteSession': z.object({
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
  /**
   * The archive the window offers for a session that looks idle (#1512), decided by the host at the last moment: it moves the
   * session (as `agents.deleteSession` with the worktree and the tool's file kept) only when nothing it holds would be lost,
   * the same rule as the orchestrator's `delete_session` (reports owed to or by it, waits and cards on it, what the person
   * allowed it, unfinished mail threads) and it is at rest in the step that moves it. Otherwise nothing moves and `asks` says
   * what would be lost, for the window's dialog (empty when the session was only busy, or is gone). A build from before it
   * answers "Unknown method", and the window asks first as it always did.
   */
  'agents.archiveIfAtRest': z.object({
    sessionId: SessionId,
    /** As `agents.deleteSession`'s: the tool's conversation file goes when the session is deleted for good (the dialog's default); ignored for a tool that cannot delete it */
    deleteExternal: z.boolean().default(false),
  }),
  /**
   * What archiving the session would lose that restoring does not bring back (#1595), read only: the lines `agents.archiveIfAtRest`
   * would answer in `asks` (`SessionTrash.lossesOf`), so the archive dialog can show them whichever way the worktree box is
   * ticked, also when the session leaves with its worktree, which `archiveIfAtRest` never does. Empty for a session with none,
   * and for one that is gone. A build from before it answers "Unknown method", and the dialog goes on as it did before.
   */
  'agents.archiveLosses': z.object({ sessionId: SessionId }),
  /**
   * agent_session delete of a child a hub's session started here with a worktree (#1161 item 3): the session goes to the
   * trash, and the worktree Centralu made for it on `worktreeBranch` goes too when nothing would be lost (nothing
   * uncommitted, every commit of its own on a remote or the trunk). `kept` says why it stayed; `none`, the session had
   * no worktree. A build from before it answers "Unknown method", and the hub deletes the session as `agents.deleteSession`.
   */
  'agents.deleteAgentChild': z.object({ sessionId: SessionId, worktreeBranch: z.string().min(1) }),
  /**
   * The material needed to judge whether a worktree can be deleted. The UI asks this right
   * before deleting. `null` means this is not a worktree session — there is nothing to ask.
   */
  /**
   * The orchestrator's MCP server proposal flow (propose_mcp_server, then the person's one-click
   * approval, then the app registers it and restarts the orchestrator). The proposal list is
   * fetched by query, and the answer goes through resolve.
   */
  'agents.mcpProposals': z.object({}),
  'agents.resolveMcpProposal': z.object({ name: z.string(), approve: z.boolean() }),
  /**
   * Orchestrator skills (#71) — fetching and answering proposals, plus listing and deleting
   * approved skills. The reason deletion exists: a skill that can only be added and never
   * removed is worse than not having one at all (the decision recorded on the issue).
   */
  'agents.skillProposals': z.object({}),
  'agents.resolveSkillProposal': z.object({ name: z.string(), approve: z.boolean() }),
  'agents.orchestratorSkills': z.object({}),
  'agents.deleteOrchestratorSkill': z.object({ name: z.string() }),
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
  'agents.exportHandoffRecord': z.object({
    sessionId: SessionId,
    /** The tool that will be the successor — used for the transcript header's `codex → claude`. Omit if unknown. */
    toTool: ToolName.optional(),
  }),
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
  'agents.exportHandoffNote': z.object({ sessionId: SessionId, afterSeq: z.number().int().nonnegative() }),
  /**
   * Where this session's agent will compact by itself the next time its process starts (#1376), as the host that runs the
   * session decides it: its setting, over the model's window. `tokens` is null when nothing will be passed (the control is
   * off, or the model's window has not been read yet). A linked machine answers for itself; one from before this answers
   * "Unknown method", which a window reads as "not set by Centralu there".
   */
  'agents.autoCompact': z.object({ sessionId: SessionId }),
  'agents.worktreeStatus': z.object({ sessionId: SessionId }),
  /**
   * Restarts only the agent attached to the session (the conversation history stays untouched).
   * A way to swap out only the process when a tool acts up, without creating a whole new session.
   */
  'agents.restartSession': z.object({ sessionId: SessionId }),
  'agents.resumeSession': z.object({ sessionId: SessionId }),
  /**
   * **Forks away** from a locked conversation and continues on this session instead.
   *
   * For a tool (codex) where only one place can hold write access to a conversation, this is the
   * only way to keep going without closing the other app. The original is left untouched; a copy
   * is made and this session is pointed at the copy.
   */
  'agents.forkConversation': z.object({ sessionId: SessionId }),
  /**
   * Switches a session's agent (claude, codex).
   *
   * **Why it is kept separate** from updateSettings: model and permissions change while the same
   * conversation continues, but switching tools means the conversation does not continue
   * (externalId is a tool-specific id, so it has to be cut off). Calling two different-outcome
   * operations through the same door would let a caller use it without knowing the difference.
   */
  'agents.switchTool': z.object({ sessionId: SessionId, tool: ToolName }),
  /** Changes the model and permissions mid-conversation (takes effect from the next turn) */
  'agents.updateSettings': UpdateSettingsParams,
  /**
   * Prior sessions the tool has stored for this project directory (an extension of FR-10).
   * If supported=false, a reason comes with it — "new session" still works even on an older tool.
   */
  'agents.listExternalSessions': z.object({
    projectId: ProjectId,
    tool: ToolName,
    limit: z.number().default(30),
  }),
  'agents.capabilities': z.object({ tool: ToolName, ...machineParam }),
  'agents.detect': z.object({ ...machineParam }),
  /**
   * Installs a tool Centralu manages itself (#59: Antigravity's agent, `ToolSetup.install: centralu`) on the machine named:
   * the version this build pins, its archive checked against the pinned sha256 before it is unpacked, put in place whole or
   * not at all. Answers at once with the setup as it stands (`installing`); progress and the end come as `tool_setup`
   * events. A second call while one runs joins it. Never started by the host on its own (no download at startup)
   */
  'agents.installTool': z.object({ tool: ToolName, ...machineParam }),
  /** Stops an install that runs; what it had downloaded is removed. Answers the setup as it stands after */
  'agents.cancelInstallTool': z.object({ tool: ToolName, ...machineParam }),
  /**
   * Starts a tool's sign-in inside Centralu (`ToolSetup.signIn: centralu`): the host opens the browser on the machine it
   * runs on and waits for the tool (Antigravity: ACP `authenticate`, up to 5 minutes). Answers at once (`signing_in`); the
   * end comes as a `tool_setup` event. **This host's machine only**: there is no `machine` parameter, since the tool's
   * redirect goes to the loopback of the machine it runs on (a linked machine's line says to sign in there)
   */
  'agents.signIn': z.object({ tool: ToolName }),
  /** Ends a sign-in that waits (its process, and with it the one-shot listener). Answers the setup as it stands after */
  'agents.cancelSignIn': z.object({ tool: ToolName }),
  /**
   * The agent CLIs installed now (#297). `force: false` (the window gaining focus) answers with what is known when it
   * was read moments ago; `force: true` reads again. Reading costs no process where the CLI came from npm (its
   * `package.json` says the version), so this is cheap either way.
   */
  'agents.versions': z.object({ force: z.boolean().default(false), ...machineParam }),
  /** "Move idle sessions to a newly installed agent CLI" on or off (#297). On by default */
  'agents.setAutoApplyVersions': z.object({ enabled: z.boolean(), ...machineParam }),
  /**
   * Restarts every session that runs an older CLI than the one installed and is fully idle, on the installed one
   * (#297) — the session header's one app-wide action. A session that is working, waiting on the person, or running
   * background tasks is left as it is and listed in `busy`; with `autoApply` on it moves once it is idle.
   *
   * `keepQuiet` (additive, #1219): also leave a session that said something within the last minute, as the automatic move
   * does, so a restart does not land the moment someone reads an answer and starts typing the next message. The person's own
   * button asks for none of that wait (it is absent); the orchestrator's `apply_agent_versions` is not the person's own.
   */
  'agents.applyVersions': z.object({ ...machineParam, keepQuiet: z.boolean().optional() }),
  /** When idle sessions go to sleep (#568): this host's setting */
  'agents.sleepPolicy': z.object({ ...machineParam }),
  /** "Put idle sessions to sleep after" (#568). `afterMinutes: null` never; 15 by default */
  'agents.setSleepPolicy': z.object({
    afterMinutes: z.number().int().positive().nullable(),
    ...machineParam,
  }),
  /**
   * A local image an agent wrote into a reply as Markdown (`![alt](/path/to/shot.png)`). The window cannot load
   * a file path itself (its origin is the app, and its CSP takes images from `data:` and `blob:` only), so the host
   * reads it: wherever it is on that machine, but only a path that appears in one of this session's own replies, only
   * PNG, JPEG, GIF or WebP by their bytes, and at most `IMAGE_PREVIEW_MAX_BYTES` (docs/security-boundaries.md,
   * "Images a reply names"). `path` is the string as the reply wrote it: `~`, a path relative to the session's folder
   * and a `file://` URL are resolved by the host.
   */
  'messages.image': z.object({ sessionId: SessionId, path: z.string().min(1).max(4096) }),
  'messages.search': z.object({ query: z.string(), limit: z.number().optional() }),
  'sessions.reorder': z.object({ projectId: ProjectId, orderedIds: z.array(z.string()) }),
  'sessions.list': z.object({}),
  'sessions.rename': z.object({ sessionId: SessionId, name: z.string() }),
  /*
   * sessions.setKind, which used to be here (the promote/demote from #13), was discontinued
   * (2026-09-01). There is now only one orchestrator per app (the central one), and the role
   * that directs sessions inside a project is the worktree manager (#69) instead — a role is not
   * chosen; it comes from the relationship.
   */
  'sessions.markRead': z.object({ sessionId: SessionId, seq: z.number() }),
  /**
   * Done on a session in `error` (#1549): it moves to `idle` and what the person saw is read, so the sidebar's mark and the
   * inbox row go. `seq` is the newest row the window had: the error is cleared only when nothing newer exists (a later error
   * the person has not seen stays), and rows up to `seq` are read either way. `cleared` says whether the state moved, `newer` that it stayed `error` because a newer row exists. A session
   * not in `error` keeps its state (its rows up to `seq` are read). Nothing is stopped, retried or continued, and the error
   * line stays in the conversation. The person's alone (the window): an agent's script may not hide a failure.
   */
  'sessions.clearError': z.object({ sessionId: SessionId, seq: z.number() }),
  'messages.load': z.object({
    sessionId: SessionId,
    limit: z.number().default(200),
    beforeSeq: z.number().optional(),
  }),
  /**
   * The steps of the native subagent one card launched (#222), oldest first, `afterSeq` paging forward. `seq` here is
   * the step's number within that launch, not a conversation number.
   *
   * Only asked for when the person opens that card's steps: they are not in `messages.load`, and nothing else reads
   * them. Tool calls and results come as their cards (`summary`), the same as a history page (#221).
   */
  'messages.subagent': z.object({
    sessionId: SessionId,
    parentCallId: z.string(),
    afterSeq: z.number().optional(),
    limit: z.number().default(SUBAGENT_STEPS_PAGE),
  }),
  /**
   * How many of one launch card's steps are in the trash (#418), so the card says they were moved there rather than
   * that none were recorded. Asked with the first page of `messages.subagent`; an older host does not know it.
   */
  'messages.subagentTrashed': z.object({ sessionId: SessionId, parentCallId: z.string() }),
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
  'agents.commands': z.object({ sessionId: SessionId }),
  /**
   * Account usage and limits (FR-9). Only covers subscription limits.
   * If supported=false, a reason comes with it — distinguishing what the tool cannot give from
   * what we failed to read.
   */
  /**
   * The list of selectable models. Carries exactly what the tool reports through its official
   * API. An older tool may not know this, so it comes back as supported=false plus a reason.
   */
  'agents.models': z.object({ tool: ToolName, ...machineParam }),
  /**
   * Limit readings and tokens over time, as this host stored them (docs/agent-host.md §6.2): each window's percent per
   * tool and account, and the hourly token buckets summed by day or hour and by session, project, model or tool.
   * Read-only. The hub asks a linked machine with `machine`; each host keeps its own record.
   */
  'usage.history': z.object({
    /** ISO8601, inclusive */
    from: z.string(),
    /** ISO8601, exclusive */
    to: z.string(),
    groupBy: z.enum(['day', 'hour']),
    by: UsageHistoryBy,
    /** Only this tool's readings and requests; absent: every tool */
    tool: ToolName.optional(),
    ...machineParam,
  }),
  'agents.usage': z.object({
    tool: ToolName,
    /**
     * `false`: answer the prompt cache figures only and do not read the account's limits (#726). The hub asks a
     * linked machine this when it shows its own limits for it (same account), so that machine does not start a
     * reading of limits nobody will look at. Absent: read them.
     */
    limits: z.boolean().optional(),
    /**
     * `true`: when a read of the tool's own command is in flight (an answer marked `provisional`), wait for it instead of
     * answering at once (#1623). The screen asks once more with this when the first answer was provisional, so it
     * receives the result when the command finishes and does not poll. Absent: answer at once.
     */
    settle: z.boolean().optional(),
    ...machineParam,
  }),
  /**
   * Which account a tool is logged in to on this host, as an opaque fingerprint (#726). The hub compares its own with a
   * linked machine's to know the two share one account's limits. Nothing readable leaves the host: not the email, not
   * the organisation id. `fingerprint` is null when the tool is not logged in with an account, or does not say which.
   * `loggedIn` is null when the tool cannot tell.
   */
  'agents.account': z.object({ tool: ToolName, ...machineParam }),
  /**
   * The session archive (#204; "trash" is the old name, kept in the method names because the protocol only grows).
   * The person reaches these: the RPC is the UI's channel, and the central orchestrator's trash
   * commands make the same calls (#1219), its deletes for good only after the person's card. No other agent tool and
   * not the apps' broker has a trash or purge verb. `agents.deleteSession` is the way in.
   *
   * `bytes` is the total of every session's `bytes` — shown because nothing deletes the archive on its own. `runs` are
   * the records of deleted app-agent sessions (#378), which `bytes` counts too, each on the machine its app ran on
   * (`machine`, as a session's); a host older than #378 sends none.
   * `unreached`: the linked machines whose trash could not be read this time (#841 item 4), so the list says it is
   * not the whole trash. Absent when every machine answered, and from a host before it.
   */
  'trash.list': z.object({}),
  /**
   * An app-agent run's record (#378), read-only: the request and the answer as the app's run saw them, the structured
   * output when the app gave a schema, and a page of the conversation in the same shape as `trash.read`. `machine` is
   * the record's, as `trash.list` gave it: a linked machine's record is read there
   */
  'trash.readRun': z.object({
    runId: z.string(),
    limit: z.number().default(200),
    beforeSeq: z.number().optional(),
    ...machineParam,
  }),
  /**
   * Deletes app-agent run records for good (#378): one, every record of one app, or every one listed, all of one
   * machine (`machine`, as `trash.readRun`); the window sends one call per machine.
   */
  'trash.purgeRuns': z.object({ runIds: z.array(z.string()).min(1), ...machineParam }),
  /** A trashed conversation, read-only — the same page shape as `messages.load` */
  'trash.read': z.object({
    sessionId: SessionId,
    limit: z.number().default(200),
    beforeSeq: z.number().optional(),
  }),
  /**
   * Brings a session back as it was. `project` is set when its project had been deleted and restoring registered
   * the folder again — the screen has not heard of that project yet.
   */
  'trash.restore': z.object({ sessionId: SessionId }),
  /** Deletes one session in the trash for good, with what the person chose to remove with it */
  'trash.purge': z.object({ sessionId: SessionId }),
  /**
   * The subagent steps each live session holds (#418), largest first; a session with none is not listed, and one in
   * the trash is counted in its own trash entry. Settings shows them beside the trash, where what the store holds is said.
   * `unreached` as in `trash.list`.
   */
  'subagents.usage': z.object({}),
  /**
   * Moves a live session's subagent steps to the trash (#418); the conversation and its launch cards stay. A subagent
   * still running goes on writing its new steps under its card. Answers what was moved.
   */
  'subagents.trash': z.object({ sessionId: SessionId }),
  /** Puts a session's trashed subagent steps back under their cards (#418) */
  'trash.restoreSubagentSteps': z.object({ sessionId: SessionId }),
  /**
   * Deletes a session's trashed subagent steps for good (#418); the session and its steps not in the trash stay.
   *
   * `upTo` is the entry's `deletedAt` as the window listed it: only steps moved to the trash at or before it go, so steps
   * moved there after the list was read (from another window, or while a machine was not reached) are not deleted
   * unseen. Moves of one session are stamped strictly later than the one before, so the bound is exact.
   */
  'trash.purgeSubagentSteps': z.object({ sessionId: SessionId, upTo: z.number() }),
  /**
   * Deletes every session in the trash for good. One that fails stays in the trash and is reported; the rest go on.
   * The app-agent run records (#378) are not touched: the window deletes the ones it listed with `trash.purgeRuns`, so
   * emptying across linked machines never takes records nobody was shown. Nor are the subagent steps in the trash (#418),
   * for the same reason: the window deletes each one it listed with `trash.purgeSubagentSteps` and its `upTo`.
   */
  'trash.empty': z.object({}),
} as const
