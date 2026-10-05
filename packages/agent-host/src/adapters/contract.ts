import type {
  AdapterCapabilities,
  ModelOption,
  UsageSnapshot,
  ApprovalDecision,
  ApprovalScope,
  NormalizedEvent,
  PermissionPreset,
  QuestionAnswer,
  SessionGoal,
  ToolName,
  ToolDescriptor,
} from '@cc/protocol'
import type { Readable, Writable } from 'node:stream'

/**
 * The adapter contract (docs/agent-host.md §2).
 *
 * Rule: an external SDK type must not step even one foot outside adapters/<tool>/ (anti-corruption).
 *
 * There are three axes an adapter deals with. What something is tied to is what decides where it lives:
 *   session   — SessionHandle's methods (conversation, approval, slash commands)
 *   directory — AgentAdapter's methods that take a cwd argument (listing previous sessions)
 *   account   — AgentAdapter's argument-less methods (usage, limits)
 *
 * **Capability is expressed through optional methods.** Do not record the same thing again in
 * capabilities — if the flag and the implementation drift apart, it silently does nothing (we
 * have actually hit this).
 */

/**
 * The tools given only to the orchestrator (FR-11).
 *
 * **This is the boundary of the access scope.** Whatever this interface can give is the entire
 * extent of what the orchestrator can do — there is no way at all to reach outside the sessions
 * this app manages. No files, no projects, no other tools live here.
 *
 * Kept tool-neutral. Claude exposes it through an in-process MCP server; other tools can expose
 * it their own way — SDK types must not step even one foot outside adapters/<tool>/.
 */
export type OrchestratedSession = {
  sessionId: string
  name: string
  project: string
  state: string
  /** Whether the worktree branch has landed on trunk (#69) — how the manager decides "finished" on its own */
  merged?: boolean
  /** The PR for this branch (#76 stage 3) — measured via gh. Distinguishes "waiting on review" from "just in progress" */
  pr?: { number: number; state: 'open' | 'merged' | 'closed' }
  tool: ToolName
  /** One line describing what last happened */
  preview: string
  /** When it last moved — decides which session is the "current conversation" */
  lastActive?: string
}

export type OrchestratorTools = {
  /** Sessions this app currently manages (excludes the orchestrator itself and archived sessions) */
  listSessions(): Promise<OrchestratedSession[]>
  /**
   * Sends work to a session. Returns a reason if the target does not exist — does not fail silently.
   *
   * With `reportBack`, the orchestrator is notified once when that session's turn ends. Off by
   * default, because waking it up on every turn end would create a loop where they wake each
   * other, and would also double the turn cost.
   */
  sendToSession(sessionId: string, text: string, reportBack?: boolean): Promise<{ ok: boolean; error?: string }>
  /**
   * Cleans up a finished worktree-branch session (#76 hard gate) — manager only.
   *
   * The only destructive power, and it is a power rather than a propose because of the gate: it
   * only runs once the host has measured at the moment of deletion that it is **provably
   * lossless** (no uncommitted changes, and the current tip has landed on trunk). Any deletion
   * outside that proof is still a human's job.
   */
  deleteWorktreeSession(sessionId: string): Promise<{ ok: boolean; error?: string }>
  /**
   * Reads a session's recent conversation.
   *
   * Without this, the orchestrator had **no way at all to check** when a report seemed thin — the
   * one-line summary from list_sessions and the report itself came from the same source, so there
   * was no way around it either. This tool has been in the spec (FR-11) from the start.
   */
  readSession(
    sessionId: string,
    limit?: number,
    opts?: {
      /** A seq given by recall. Reads around that point — a direct path to the found passage */
      around?: number
      /** Whether to expand tool-call bodies too. Collapsed by default (a full script's text would bury the conversation) */
      tools?: boolean
    },
  ): Promise<{ ok: boolean; error?: string; lines?: string[]; state?: string }>
  /**
   * Searches past conversations — **memory that crosses project boundaries**.
   *
   * Why we do not store memory separately: it creates a new problem of who decides what to
   * remember, and a distilled summary stays frozen even after the original changes. We never
   * delete a single conversation, so **being findable is already being remembered.**
   */
  /**
   * Archives or restores a session.
   *
   * Without this, the only way to unstick a jammed window was to restart the app or to archive
   * and then restore, and the orchestrator could do neither, so it always had to hand off to a
   * person (dogfooding). We give it this because it is reversible.
   */
  /**
   * Creates a worker session (#13).
   *
   * Why creation is given but deletion is not: a session that gets created is visible to the
   * person in the list and can be reversed (both archiving and deletion stay in the person's
   * hands), but deletion also erases the conversation record and cannot be undone.
   */
  createSession(opts: {
    /** The project's name or id — the orchestrator belongs to no project, so this must always be pointed to */
    project?: string
    tool?: ToolName
    /** The session name. If given, the automatic name does not override it */
    name?: string
    /** The first instruction to send right after creation */
    firstMessage?: string
  }): Promise<{ ok: boolean; error?: string; sessionId?: string; name?: string }>
  /**
   * Changes a session's performance settings (#30).
   *
   * **The permission preset not existing on this type is itself the decision.** If the
   * orchestrator could switch a preset to auto, the rule "cannot approve on someone else's
   * behalf" would collapse through a back door — this blocks it by making it inexpressible,
   * rather than by checking the field and rejecting it.
   * A change is announced to the screen as an event — no silent, untraceable settings change.
   */
  updateSessionSettings(
    sessionId: string,
    s: { model?: string | null; effort?: string | null; verbosity?: string | null; serviceTier?: string | null },
  ): Promise<{ ok: boolean; error?: string; /** takes effect once the running turn ends (#164) */ deferred?: boolean }>
  recall(
    query: string,
    limit?: number,
  ): Promise<{
    hits: {
      sessionId: string
      session: string
      project: string
      snippet: string
      /** Pass this as read_session's around to jump straight to that passage */
      seq: number
      at?: string
    }[]
  }>
  /**
   * **Proposes to the person** that an MCP server be installed (a dogfooding request — wanting to
   * equip itself with a capability like Playwright). Follows the propose-not-power rule exactly:
   * this call installs nothing on its own. If the person approves, the app registers it and
   * restarts the orchestrator — since this is registering arbitrary command execution, installing
   * it without approval would simply be a back door.
   */
  proposeMcpServer(spec: {
    name: string
    command: string
    args: string[]
    why?: string
  }): Promise<{ ok: boolean; error?: string }>
  /**
   * **Proposes to the person** a reusable procedure (a skill) (#71). A skill lives in the app's
   * database, not as a file — a worker session can write files but not the database, so this
   * closes off any path for a lower-privilege session to reach the orchestrator's own
   * instructions. It has no effect at all before approval: a skill is **permanent leverage** over
   * an agent that can instruct every session, so if self-authorship survived without approval,
   * injected text would effectively become permanent authority.
   */
  proposeSkill(spec: { name: string; content: string; why?: string }): Promise<{ ok: boolean; error?: string }>
  /**
   * Checks its own app (M4 C-3) — for a session that creates an app only. Which app is decided by
   * the calling session itself (the app it is creating): it takes no name, so there is no way to
   * probe someone else's app. `text` is the report meant for the agent to read.
   */
  checkApp(): Promise<{ ok: boolean; text: string }>
  /**
   * Creates a new app from a template (M4 C-1b) — orchestrator only. The same path as the "New
   * app" button (`apps.create`).
   *
   * Why this is a power rather than a propose: what gets created is **a copy of a template** — it
   * loads no code that is already in the repository, and no command the person did not choose. An
   * app is only ever created in a trusted project (or a user folder), and it never overwrites an
   * id that already exists. Deletion is still a human's job (a project app through git, a
   * user-folder app through `apps.remove`).
   */
  createApp(spec: {
    /** The project's name or id. A user-folder app if omitted */
    project?: string
    id: string
    name: string
    description?: string
    /** The tool for the session that creates it (C-2). The project's default tool if omitted */
    tool?: ToolName
  }): Promise<{
    ok: boolean
    error?: string
    appId?: string
    projectId?: string | null
    dir?: string
    /** The session created alongside it to build the app (C-2) — absent if it failed to start, with `builderError` as the reason */
    builder?: { sessionId: string; name: string }
    builderError?: string
  }>
}

/**
 * A single tool of an external app attached to a session — carries the exact shape of an MCP
 * `Tool` (minus outputSchema).
 *
 * The description and the annotations (`annotations`) are carried through **unchanged**. The
 * description is what the model uses to choose a tool, and the annotations decide whether
 * approval can be skipped (read-only) — trimming either one turns it into a different tool than
 * what the app actually declared.
 */
export type AppToolSpec = {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  _meta?: Record<string, unknown>
}

/** The result of an app tool call — the shape of MCP's `CallToolResult`. Even a failure is returned as `isError`, not thrown */
export type AppToolResult = {
  content: unknown[]
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

/** A single app currently attached to this session */
export type AttachedApp = {
  /** The server name used in the session (`app-<id>`) */
  server: string
  appId: string
  /**
   * The tool list we already know — null if it has never been read. The app is still attached
   * even when this is null: `tools()` starts the app and finds out when it is needed.
   */
  tools: AppToolSpec[] | null
}

/**
 * An external app attached to this session (M4 A-5) — each adapter attaches it its own way.
 *
 *   Claude  an in-process proxy server per app. Changes the server set with no restart as apps come and go
 *   Codex   an stdio bridge per app. Attached only when a thread starts or resumes (there is no way to add one while it is running)
 *
 * **Which apps get attached is not decided here** — the manager decides it from the session kind
 * and the project, and passes it down (decision 4). What the adapter receives is an
 * already-filtered list, plus the single path every call goes through (`call`). One per handle:
 * closing the handle closes this with it via `close()`.
 */
export type SessionApps = {
  current(): AttachedApp[]
  /** Attached apps or their tools may have changed — time to read `current()` again. Unsubscribe with the returned function */
  onChange(listener: () => void): () => void
  /** An app's agent tools. If unknown, starts the app to find out (the wait is bounded) */
  tools(server: string): Promise<AppToolSpec[]>
  /**
   * Calls an app tool — the caller is this session. An unattached app or a nonexistent tool comes
   * back as a rejected result.
   *
   * If `waitMs` is given, a call taking longer than that **returns a run id and "still running"
   * first** — the call itself does not stop, and the result is followed up through that app
   * server's own `run_status` tool. Used by a tool that has its own call ceiling externally
   * (Codex, 300 seconds). A tool with effectively no ceiling (Claude's in-process server) does not
   * get this and simply waits.
   */
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal
      waitMs?: number
      /**
       * The conversation card id for this call (the adapter's `tool_call` callId) — given **only
       * when the agent's MCP client reports it** (Claude Code: `_meta["claudecode/toolUseId"]`).
       * This decides which card the in-conversation screen (B-1) settles under. If absent, it is
       * matched against what was recorded via `noteCall`.
       */
      callId?: string
    },
  ): Promise<AppToolResult>
  /**
   * The adapter observed, in its own event stream, that the agent **started** calling an attached
   * app's tool (M4 B-1).
   *
   * A call going through a bridge (Codex) does not carry a card id — Codex does not put that id
   * on the MCP request (we found no evidence that it does). So we record what the adapter
   * observed ("card X calls server S's tool T with argument A"), and match it, in first-come
   * order, against the call that follows by (server, tool, args). Either side may arrive first —
   * whichever arrives second gets matched then.
   */
  noteCall(callId: string, server: string, tool: string, args: unknown): void
  /**
   * That card's call has ended (success, failure, or rejection). If it was never matched, the
   * record is discarded — a call rejected at approval never reaches the app, so keeping the
   * record around would let a later call with the same arguments get matched to the old card.
   */
  callEnded(callId: string): void
  /**
   * Whether the app itself declared this tool read-only (`readOnlyHint: true`) — the basis for the
   * approval decision (decision 5). Only looks at the attached app's already-read agent tool
   * list. Defaults to false when unknown (leans toward asking).
   */
  readOnly(server: string, tool: string): boolean
  /**
   * Cancels every app call this session made — used when stopping the session (interrupt).
   * Includes a call that already returned early (`waitMs`): work from a session the person
   * stopped must not keep running in the background. Cancellation is carried by the runtime down
   * through the app and whatever work the app requested below it.
   */
  cancelAll(): void
  /** The handle is closing — cancels every call and unsubscribes */
  close(): void
}

/**
 * A tool's process as an adapter drives it — what a local `ChildProcess` and a process the keeper
 * holds (#280 step 2, `keeper/agent-process.ts`) both are. It is also the shape the Agent SDK's
 * `spawnClaudeCodeProcess` returns.
 */
export interface AgentProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr?: Readable | null
  readonly pid?: number
  readonly exitCode: number | null
  readonly signalCode?: NodeJS.Signals | null
  readonly killed: boolean
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  off(event: 'error', listener: (error: Error) => void): this
  /** Lets go of the process and leaves it running (only a process someone else holds can) */
  detach?(): Promise<void>
}

export type AgentSpawnSpec = { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined> }

/**
 * Where a session's tool process comes from, when not from the adapter's own `spawn` (#280 step 2).
 *
 * Under the keeper the manager passes this so the process outlives the host: `spawn` starts it
 * in the keeper, and `adopt` hands over one a previous host started — the re-attach after a host
 * restart, with the process possibly mid-turn.
 */
export type ProcessSource = {
  spawn(spec: AgentSpawnSpec): AgentProcess
  adopt?: {
    process: AgentProcess
    /**
     * Tool calls the store recorded for this session with no result yet. A call the previous host
     * was serving in-process died with it, and the tool would wait for that answer forever: the
     * adapter knows which of its calls those are, and releases the turn.
     */
    openCalls: { callId: string; tool: string }[]
  }
}

export type CreateSessionOpts = {
  /** Absent: the adapter spawns its tool itself, as a child of this host */
  processSource?: ProcessSource
  sessionId: string
  cwd: string
  model?: string
  /** Reasoning effort. Carried as a plain string, since the levels differ per model */
  effort?: string
  /** Response verbosity (#54). Ignored by an adapter whose capabilities.verbosities is empty */
  verbosity?: string
  /** Response speed (codex's service_tier). Supported tiers are stated by the model list (ModelOption.tiers) */
  serviceTier?: string
  permissionPreset: PermissionPreset
  /**
   * Whether this session's working folder is trusted (M4 decision 3, #92, #152) — **whether files
   * in the repository are allowed to alter this session.**
   *
   * When untrusted, tool settings committed to the repository never reach this session: Claude
   * does not read `.claude/`'s settings, hooks and commands or CLAUDE.md, and Codex does not read
   * `.codex/`'s settings, hooks and rules or AGENTS.md. The user's own settings (`~/.claude`,
   * `~/.codex`) still apply as usual — decision 3 only turns off the repository's own share.
   *
   * **Absent means untrusted.** What gets trusted is decided by the manager from what the session
   * **is** (`settingFilesFor`): a session belonging to a project (worker, manager, or the session
   * that creates a project app) receives that project's trust, and the session that creates a
   * user-folder app receives trust even without a project — that folder belongs to the user
   * (decision 3). Every time the manager starts a session (creation or waking), it reads this from
   * the repository and passes it down: if trust changes, a running session only gets the new value
   * the next time it starts up.
   */
  projectTrusted?: boolean
  /**
   * A session that reads **no** settings files at all (#92) — the orchestrator and coordination
   * sessions. Takes precedence over `projectTrusted`.
   *
   * Those sessions have no project, and their working folder (orchestratorHome) is a spot a
   * worker can write into. If a session that can instruct many other sessions read instructions
   * from there, it would become a path from low privilege to high privilege — its role is instead
   * given through `systemPromptAppend` rather than a file. Claude turns off even the user's own
   * settings (`settingSources: []`). Codex turns off the repository layer (`.codex/`, AGENTS.md)
   * per thread, while the user's own `~/.codex` is still read as usual.
   *
   * This is independent of whether the session receives tools (`orchestratorTools`) — the worktree
   * manager and the session that creates the worktree also receive tools, but since they belong to
   * a project, they follow `projectTrusted` instead.
   */
  noSettingFiles?: boolean
  /**
   * Folders outside the working folder that **must be read** (#142) — currently just the one
   * folder holding an inherited handoff note.
   *
   * The note lives in the data folder (`<data>/handoff/<project id>/`), while the successor's cwd
   * is the project. The two tools differ here:
   *  - Claude **asks** before reading outside the working folder. Measured (SDK 0.3.263 bundled
   *    with CLI 2.1.263, haiku, permissionMode 'default', 2026-09-29): Reading a file outside it
   *    invoked canUseTool as `Read` (i.e. an approval card). Giving the same folder as
   *    `additionalDirectories` let it read without the callback. So Claude receives this value as
   *    `additionalDirectories`.
   *  - Codex does not block reads at all. In the generated type (codex-cli 0.153.4
   *    `SandboxPolicy`), neither the readOnly nor the workspaceWrite sandbox has a read scope — the
   *    only thing it restricts is the writable roots (`writableRoots`). So Codex does not use this
   *    value: touching the thread's sandbox would only end up overriding the user's own settings.
   */
  readableDirs?: string[]
  resumeExternalId?: string
  /**
   * The goal the host last heard of for this conversation, when a new process resumes it (the badge's
   * `goal` event). Codex has no use for it — it asks the thread (`thread/goal/get`). Claude does: its
   * CLI restores the goal from the transcript and says nothing about it on the stream (measured
   * 2026-10-03), so without this the new process would not know the goal it is running, and a met
   * goal would leave the badge up. Absent after a host restart, since the goal is live-only.
   */
  knownGoal?: SessionGoal
  /** If given, this session receives app tools — each adapter attaches them its own way */
  orchestratorTools?: OrchestratorTools
  /**
   * External apps attached to this session (M4 A-5). Separate from the built-in app tools
   * (`orchestratorTools`) — an ordinary worker receives these too (decision 4 changes #81's "a
   * worker has no tools" only for external apps).
   */
  /*
   * An MCP server the person approved (propose_mcp_server) does not arrive here separately — it
   * becomes a user-folder app and arrives through `apps` instead (M4 A-7). The old
   * `extraMcpServers` used to load that server raw into the adapter settings, so its calls went
   * through neither mediation nor logging.
   */
  apps?: SessionApps
  /**
   * The JSON schema this session's answer must follow (M4 D-1 — an agent an app asked for by
   * giving a `schema`). The root is an object.
   *
   * The two tools take it in different places: Claude receives it only **when starting the
   * query** (`outputFormat`, per query). Codex receives it **per turn** (`outputSchema` on
   * `turn/start`). So an app's request is always given to a fresh session per request — the format
   * of a running session cannot be changed mid-flight. A turn answered with the schema arrives as
   * `turn_complete.output` (Claude) — for Codex, the last message itself is that JSON.
   */
  outputSchema?: Record<string, unknown>
  /**
   * Which bundle of tools is received (#69). 'orchestrator' gets all of them; 'manager' gets a
   * subset of the worktree manager's (propose, query, instruct). Only meaningful when
   * orchestratorTools is present. Both exposure and execution use the same decision
   * (profileAllows) — narrowing only the exposure would let a caller who already knows the name
   * just call it anyway.
   */
  toolProfile?: 'orchestrator' | 'manager' | 'scoped' | 'builder'
  /**
   * The role description the app vouches for. **Appended** to the tool's default prompt.
   *
   * Why this is not kept as a file (AGENTS.md): it would disappear along with a person deleting or
   * mis-editing it. What the person is meant to control and what we must guarantee do not belong
   * in the same place.
   */
  systemPromptAppend?: string
  /**
   * The path back to the host for an adapter that **cannot attach tools in-process**.
   *
   * Claude does not need this (a function simply becomes a tool). Codex can only attach an stdio
   * server through per-thread config, so a separate process starts, and that process calls back to
   * this address. The bridge for orchestrator tools and the bridge for an external app (M4 A-5)
   * both use the same path — the name follows whichever one existed first.
   */
  orchestratorBridge?: { url: string; token: string }
}

/** A single previous session kept by the tool (a tool's own type never reaches this far) */
export type ExternalSessionSummary = {
  externalId: string
  title: string
  updatedAt: number
  createdAt?: number
  branch?: string
}

/**
 * One line of conversation for restoration. Regardless of the tool, only "what the person said" and "what the model
 * said" survive — plus the point where the tool compacted its context, when its record says so (#303). That point is
 * stored as the same marker a live compaction leaves, so a conversation read back from the tool shows where it was
 * folded, just as one watched live does.
 */
export type HistoryMessage =
  | { role: 'user' | 'assistant'; text: string; ts?: number }
  | { role: 'system'; marker: 'compaction'; ts?: number }

export type DetectResult = { tool: ToolName; installed: boolean; loggedIn: boolean; detail: string }

export type EventSink = (event: NormalizedEvent) => void

export interface SessionHandle {
  readonly sessionId: string
  readonly externalId: string | null
  send(text: string): void
  /** The matcher is computed by core and passed along by the UI (boundary rule: the host does not know core) */
  /**
   * The approval response. **Returns whether it reached anything** (false = no such request exists).
   *
   * Ignoring it silently leaves the screen holding the approval card forever — pressing it does
   * nothing, and the user cannot even tell whether the command ran. This actually got stuck this
   * way during dogfooding.
   */
  respondApproval(requestId: string, decision: ApprovalDecision, scope?: ApprovalScope, matcher?: string): boolean
  /**
   * Answers a set of choices (AskUserQuestion). Same rule as approval — **returns whether it
   * reached anything.** An adapter that does not support this tool leaves it unimplemented.
   */
  answerQuestion?(requestId: string, answers: QuestionAnswer[]): boolean
  /** Injects saved "always allow" rules — so they survive a restart (FR-10, C-2) */
  applyRules?(matchers: readonly string[]): void
  /** Changes model or permission (starting next turn). Left unimplemented if unsupported */
  updateSettings?(settings: {
    model?: string | null
    effort?: string | null
    verbosity?: string | null
    permissionPreset?: PermissionPreset
  }): void
  /**
   * Slash commands (skills) usable in this session.
   * May throw if the tool is still starting up — the manager falls back to the cache.
   */
  listCommands?(): Promise<{ name: string; description?: string; argumentHint?: string }[]>
  interrupt(): void
  /**
   * Stops one background task (#290) by the id its `background_tasks` entry carries. Only a task marked `stoppable`
   * is asked for. The ending arrives as an ordinary `background_tasks` event; a rejection is thrown, so the person
   * hears that it did not stop. An adapter that cannot stop a task alone leaves this unimplemented.
   *
   * **Reporting background work is the `background_tasks` event, declared by `capabilities.backgroundTasks`.** An
   * adapter that reports it also releases it: when its process goes away it sends the last live set empty, with the
   * tasks it held as ended (`stopped`) — the work went with the process (measured for both tools).
   */
  stopBackgroundTask?(taskId: string): Promise<void>
  /**
   * Whether this live agent can call one attached app server (`app-<id>`), as far as the agent's own
   * configuration goes (#308). The manager asks only about a server decision 4 gives the session, so
   * this answers what the rule cannot know:
   *
   *   attached       the agent has it (or will, when its thread starts)
   *   restart        the agent started without it and cannot take it in now (a Codex thread keeps the
   *                  servers it started with)
   *   failed         the agent tried and the server did not start
   *
   * An adapter that follows the attached set live (Claude, through in-process proxies) leaves it
   * unimplemented, which reads as `attached`.
   */
  appAttachment?(server: string): 'attached' | 'restart' | 'failed'
  dispose(): Promise<void>
  /**
   * Lets go of the session **without stopping its process** (#280 step 2): a host leaving for a
   * restart under the keeper. Nothing is sent to the tool — no deny for a waiting approval, no EOF,
   * no signal — and the next host re-attaches and the tool re-delivers what is pending. Output that
   * arrives while the process is being released is still emitted. Only an adapter whose process came
   * from a `ProcessSource` can; the others leave it unimplemented.
   */
  detach?(): Promise<void>
}

export interface AgentAdapter {
  readonly tool: ToolName
  readonly capabilities: AdapterCapabilities
  /**
   * Who this tool is, for the screens that draw a row per tool.
   *
   * It lives on the adapter because the adapter is the only thing that knows the tool
   * exists. This used to be a `TOOL_META` record in `@cc/protocol` listing two vendors by
   * name, so adding a third meant editing the shared protocol — an adapter that cannot
   * introduce itself is not really a plug-in point.
   */
  readonly descriptor: ToolDescriptor

  detect(): Promise<DetectResult>
  createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle>
  /**
   * The list of previous sessions the tool keeps for this directory.
   * Treated as unsupported when unimplemented — support is stated by capabilities.listExternal.
   * May throw when facing an older tool version: the manager degrades with a reason.
   */
  listExternalSessions?(cwd: string, limit: number): Promise<ExternalSessionSummary[]>

  /**
   * **Truly** deletes the original conversation on the tool's own side (a dogfooding request —
   * "actually delete it").
   *
   * Deleting our own session only cleared our own database: the codex rollout (measured at 550MB)
   * and claude's JSONL belong to the tool, so they were left alone. The rule that leaving things
   * behind is the default still holds — this method is only called when the person has explicitly
   * checked the box. Thrown failures propagate: the manager stops deleting on our side and reports
   * it as-is (saying "deleted" while the original survives would be the worst outcome).
   */
  deleteExternalConversation?(externalId: string, cwd: string): Promise<void>
  /**
   * The last compact summary of a dead tool process (#78) — becomes the head of the handoff
   * record when one exists.
   *
   * Must work **without the tool's process running** — this method is only called at the moment
   * that tool's service has stopped. codex reads it from the rollout file; claude has no
   * implementation because its stream never carries the summary body — when absent, the record
   * builder falls back to compressing the raw text.
   */
  lastCompactSummary?(externalId: string): Promise<string | null>
  /** Reads a previous session's conversation (a display snapshot — the model's actual context is held by the tool) */
  readExternalHistory?(externalId: string, cwd: string, limit: number): Promise<HistoryMessage[]>

  /**
   * Account usage and limits (FR-9).
   *
   * Takes no argument because it is a property of the **account**, not a session or a directory.
   * Only covers subscription limits — additional billing (credits) is out of scope.
   * Throws when it cannot be fetched: the manager degrades with a reason.
   */
  listUsage?(): Promise<UsageSnapshot>

  /**
   * The models available to choose from, and the reasoning effort levels each supports.
   *
   * Takes no argument because it is the same **account** axis as usage — the answer is the same no
   * matter which directory it is asked from. Exists so that we do not have to maintain the list
   * ourselves: when the tool ships a new model, it simply follows through here. May throw when
   * facing an older tool version — the manager degrades with a reason.
   */
  listModels?(): Promise<ModelOption[]>

  /**
   * **Splits off** a new thread from a locked conversation — returns a new externalId.
   *
   * Why this is needed: depending on the tool, only one writer can hold a given conversation at a
   * time. codex blocks this with a lock ("already has an active writer"), and when that happens
   * there was no way at all to continue that conversation from this app — short of the person going
   * to close the other app.
   *
   * But **only writing is blocked.** What we confirmed by measurement:
   *   thread/resume  blocked
   *   thread/read    works even while locked (we were already reading through our own store)
   *   thread/fork    works even while locked
   *
   * So this is a fork in the road, not a dead end. We leave the original untouched and continue
   * from the copy instead. An adapter without this capability leaves it unimplemented — claude
   * does not need it since it never locks in the first place (we also confirmed by measurement
   * that a concurrent resume simply works).
   */
  forkConversation?(externalId: string, cwd: string): Promise<string>

  /**
   * Called once by the host on its way out, after every session was disposed: waits a moment for
   * the processes those disposals closed to leave by themselves, so the host's own exit does not end
   * them mid-write. Resolves quickly when there is nothing to wait for, and never takes longer than
   * the adapter's own short cap. Unimplemented: nothing to wait for.
   */
  settle?(): Promise<void>
}
