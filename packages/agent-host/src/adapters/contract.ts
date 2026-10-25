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
import type { ToolProfile } from '../apps/contract.js'
import type { OrchestratorTools } from './contract/orchestrator.js'
import type { ProcessSource } from './contract/process.js'
import type { SessionApps } from './contract/session-apps.js'
import type { AdapterSurface } from './contract/surface.js'

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

// The contract's parts, one file per concept (#843): the orchestrator's tools, the apps a session has, the tool's process
export * from './contract/orchestrator.js'
export * from './contract/session-apps.js'
export * from './contract/process.js'
export * from './contract/surface.js'

/**
 * The `state_change` reason an adapter gives a turn the tool interrupted when nobody here asked it to (#698): Codex's
 * `turn/completed` with `interrupted` that no `turn/interrupt` of ours preceded. The manager reads it as an
 * interruption the person and the orchestrator are told of. A Stop of ours ends a turn with `interrupted`.
 */
export const INTERRUPTED_BY_TOOL = 'interrupted_by_tool'

/**
 * What the host says of a step of the CLI's own in a session's request: `asked` is true when the person was asked and allowed it, and false for a
 * read, which needed no question and is left to the CLI's own flow; or not allowed, with the words the model reads instead
 */
export type RequestTurnAnswer = { allowed: true; asked: boolean } | { allowed: false; message: string }

/** What the adapter reaches of the host for the orchestrator's turn that a session's request is (`CreateSessionOpts.requestTurn`) */
export type RequestTurn = {
  /** Whether the session's turn that is going is a session's request: read at every step of the CLI's own */
  active(): boolean
  /**
   * Asks the person about a step of the CLI's own (its name and arguments), naming who asked. A read is answered at once, and so is a step that
   * would outlive the turn (a subagent, a scheduled prompt): it is refused, since the person's card belongs to the turn
   */
  ask(tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<RequestTurnAnswer>
  /**
   * The CLI is itself about to ask the person about a read (a file outside its working folder, in a preset that asks): the card is the host's, naming who
   * asked, with Allow or Deny only, instead of the CLI's own with its "always"
   */
  askRead(tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<RequestTurnAnswer>
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
  /**
   * Where the agent compacts its conversation by itself, in tokens (#1376): Centralu's share of the model's window
   * (`sessions/auto-compact.ts`). Claude takes it as `autoCompactWindow` (it compacts a little before it, by its own
   * reserve), Codex as `model_auto_compact_token_limit`. Absent: nothing is passed and the agent's own settings decide.
   */
  autoCompactTokens?: number
  /**
   * For a process the host adopts (a host swap): the compaction window it was started with, which it keeps whatever the
   * setting says by now (`ModelWindows.started`). Absent when it was started without one, or the host that started it did not
   * say. The adapter compares where the tool says it compacts with this, not with `autoCompactTokens`.
   */
  autoCompactCeiling?: number
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
   * Start without code intelligence (#686): the language servers the CLI would start for this session are turned off,
   * for this session only. The manager sets it for child sessions (start_agent's, a fork, an app's agent) unless their
   * caller asked for it (`codeIntelligenceOff`); sessions the person starts never get it. What it means is the adapter's:
   * Claude disables, in this session's flag settings, every enabled plugin that declares `lspServers`; the person's
   * settings files are not touched. An adapter whose CLI starts no language server (Codex) ignores it.
   */
  noCodeIntelligence?: boolean
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
  /**
   * Paths this session was given to read **after it started** (#371 part B): the output files another project named
   * in its answer to this session's ask_project. Asked on every read, since grants arrive mid-turn and
   * `readableDirs` is fixed when the process starts. Claude uses it in `canUseTool` (a read outside the folder lands
   * there and is allowed without a card when this says yes); Codex does not restrict reads, so it has no use for it.
   */
  mayRead?: (path: string) => boolean
  /**
   * Given to the orchestrator: whether its turn that is going is a session's request (docs/plans/mailbox.md §9.7, #1447), and the person's card for a
   * step of the CLI's own. In such a turn every step that is not a read reaches `ask` (which names who asked, and is Allow or Deny only), whatever the
   * session's preset and whatever the person once allowed "always": the adapter puts it in front of every tool call the CLI makes
   */
  requestTurn?: RequestTurn
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
   * External apps attached to this session (M4 A-5). Separate from Centralu's own tools
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
   * Which bundle of tools is received (#69). 'orchestrator' gets all of them; 'reader' is an ordinary
   * session's light set (#320), with ask_project and start_agent beside it. Only meaningful when orchestratorTools is present. Both exposure and execution use the same decision
   * (profileAllows) — narrowing only the exposure would let a caller who already knows the name
   * just call it anyway.
   */
  toolProfile?: ToolProfile
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
   *
   * `token` is this session's bridge credential, not the host's token: it opens only this
   * session's bridge calls (`transport/bridge-token.ts`, #382).
   */
  orchestratorBridge?: { url: string; token: string }
}

/**
 * The stable, session-specific inputs an adapter may use to describe what it launches.
 *
 * The host persists the adapter's fingerprint across a keeper handoff. It deliberately does
 * not include a process source, bridge credential, callbacks or session id: those are transport
 * details that change on every host, not settings a kept CLI can retain.
 */
export type LaunchSettings = Pick<
  CreateSessionOpts,
  'cwd' | 'model' | 'effort' | 'verbosity' | 'serviceTier' | 'permissionPreset' | 'projectTrusted' | 'noSettingFiles' | 'toolProfile' | 'systemPromptAppend' | 'noCodeIntelligence'
>

/** A single previous session kept by the tool (a tool's own type never reaches this far) */
export type ExternalSessionSummary = {
  externalId: string
  title: string
  updatedAt: number
  createdAt?: number
  branch?: string
}

/**
 * One line of conversation for restoration: what the person said, what the model said, and the recorded events the
 * tool's record holds between them, read by the adapter's live normalizer (#843): its tool calls and their results,
 * and the points where it compacted its context (#303). Each event is stored as the row the same event leaves live,
 * so a conversation read back from the tool shows its tool cards and where it was folded, just as one watched live
 * does. The event's `sessionId` is the adapter's placeholder; the host stores it under the session's own.
 */
export type HistoryEvent = Extract<NormalizedEvent, { type: 'tool_call' | 'tool_result' | 'compaction' }>
export type HistoryMessage =
  | { role: 'user' | 'assistant'; text: string; ts?: number }
  | { role: 'system'; event: HistoryEvent; ts?: number }

export type DetectResult = { tool: ToolName; installed: boolean; loggedIn: boolean; detail: string }

export type EventSink = (event: NormalizedEvent) => void

/**
 * A session handle. Its adapter reports the running CLI's version once per process as an
 * `agent_version` event (#297), from what the tool itself says when it starts.
 */
export type InputObserver = {
  complete(): void
  fail(error: Error): void
  /**
   * The tool took the input: Codex answered `turn/start`, Claude started a turn for it. Before `complete`, which waits for the turn to be
   * recorded. The mailbox's delivery counts a wake as delivered from here, not from the write (docs/plans/mailbox.md §7.6.2)
   */
  accepted?(): void
}

/**
 * Who wrote an input, when the host can say so. The person's own typing is stamped `human`; the mailbox's delivery is stamped
 * `channel` from `centralu` (docs/plans/mailbox.md §7.1: it carries nothing to the model, but is the record and what a later CLI
 * may honour). A report, an app's notice and Centralu's other words carry none. Claude passes it to the CLI as the user
 * message's `origin`, where an absent one is "unattributed" and fails closed at its strict `isHuman()` gates.
 */
export type InputOrigin = { kind: 'human' } | { kind: 'channel'; server: 'centralu' }

export interface SessionHandle {
  readonly sessionId: string
  readonly externalId: string | null
  /** Limits the parent should know before delegating more work; decided by the adapter's effective settings. */
  delegationNotice?(): string | undefined
  /**
   * `id`: a name the host gives the input, which `turnInputs` then reports back (a UUID). `quiet`: appended to the conversation without
   * starting a turn, and read with the next message that does (Claude's `shouldQuery: false`). Only an adapter with `quietInput` takes
   * it; the mailbox's mail that must not wake goes this way
   */
  send(text: string, opts?: { origin?: InputOrigin; id?: string; quiet?: boolean }): void
  /**
   * A note for the model that never starts a turn and never interrupts one (#1492): Claude takes it as quiet input, read with
   * the next message or at the running turn's next tool round; Codex steers it into the regular turn that is running
   * (`turn/steer`, which names the turn and is refused for one that has ended). Says whether the tool took it: false when Codex has
   * no turn it can steer (none running, or a compact or review one) or refuses the steer, where a send would start a turn. A tool
   * that only knows later (Codex) answers with a promise. Absent: the tool takes no such note.
   */
  nudge?(text: string): boolean | Promise<boolean>
  /**
   * Which of the inputs given an `id` the turn that just ended took in (#1377), read while the event that ends it is
   * handled. Absent: the tool takes every message into the turn it is running (Codex steers an active turn). Present:
   * a message sent mid-turn may instead run as a turn of its own after (Claude folds one in only at a tool round);
   * `null`: the tool cannot tell (an older CLI), and none is taken to have joined
   */
  turnInputs?(): readonly string[] | null
  /** Completes after the consuming turn is recorded. The observer runs synchronously, before later turn frames. */
  sendTracked?(text: string, observer?: InputObserver, opts?: { origin?: InputOrigin }): Promise<void>
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
  /**
   * The model and effort the tool's conversation turned out to run with when it was opened, when they are not what the
   * session was asked to run (#1369): a conversation started elsewhere keeps the model it was started with. Taken once,
   * by the host, as it registers the handle, so it can record them before anything reads the session's settings; a
   * handle that is not registered yet cannot hear a `settings_changed`. After it is taken, a later answer (a slow
   * background resume) comes as a `settings_changed` the tool made. Left unimplemented by a tool that always runs what it is asked.
   */
  takeOpenedSettings?(): { model: string | null; effort: string | null } | null
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

/** Whose price ratios between uncached input, a cache read and a cache write the tool's model is billed by (`sessions/cache-cost.ts`, #1492) */
export type CacheBilling = 'anthropic' | 'openai'

export interface AgentAdapter {
  readonly tool: ToolName
  /** Absent: Anthropic's, the ratios the cache figures were first drawn with */
  readonly cacheBilling?: CacheBilling
  /**
   * The tool says the context size itself with every request's token count (Codex's `thread/tokenUsage/updated`), so the figure
   * needs no estimate from the request during a turn (`ContextMeter`). Absent: it reads it once at a turn's end (Claude).
   */
  readonly contextAtRequest?: boolean
  /** Whether a live session takes a `quiet` input (see `SessionHandle.send`): the mailbox sends mail that must not wake only to such a tool */
  readonly quietInput?: boolean
  readonly capabilities: AdapterCapabilities
  /**
   * For a tool whose reported context window is the smaller of the model's and the compaction point it was started with
   * (#1376: Claude's CLI is; Codex reports the model's own): the largest window a process started with `autoCompactTokens`
   * can report. The host reads a reading against it (`ModelWindows.note`): below it is the model's real window, at it only
   * "at least this".
   */
  windowCeilingFor?(autoCompactTokens: number): number
  /**
   * The input that makes this tool compact its conversation (#1451), with the focus line for the summary when it takes one:
   * what `SessionHandle.send` is given when Centralu compacts a session at a break. Absent: `/compact`.
   */
  compactCommand?(focus: string | null): string
  /**
   * Who this tool is, for the screens that draw a row per tool.
   *
   * It lives on the adapter because the adapter is the only thing that knows the tool
   * exists. This used to be a `TOOL_META` record in `@cc/protocol` listing two vendors by
   * name, so adding a third meant editing the shared protocol — an adapter that cannot
   * introduce itself is not really a plug-in point.
   */
  readonly descriptor: ToolDescriptor

  /**
   * A versioned fingerprint of the launch settings this adapter derives for one session (#589).
   *
   * A keeper can retain a process across a host swap. When this changes, the manager restarts an
   * idle retained process (or waits for its turn) so it receives the new adapter settings.
   * Adapters without a fingerprint remain compatible; they simply cannot opt into that check.
   */
  launchSettingsFingerprint?(settings: LaunchSettings): string

  /**
   * What the installed tool offers, against what this adapter blocks, drops or works around (#270,
   * `contract/surface.ts`). The weekly drift run reads it for every registered adapter and files an issue for what is
   * new, so the tool gaining a command or a message type the adapter does not know is heard of. Optional like the rest
   * of the contract, for test doubles; every adapter the registry ships has one (`descriptors.test.ts`).
   */
  readonly surface?: AdapterSurface

  detect(): Promise<DetectResult>
  /**
   * The version of this tool installed on the machine now, or null when it is not installed or
   * cannot be told (#297). Read without starting a session, and cheaply: it runs every ten minutes
   * and whenever a window gains focus (`cli-version.ts` reads npm's `package.json`). Compared with
   * the version each session's process reports (the `agent_version` event), it says which sessions
   * still run an older CLI. An adapter that cannot tell leaves it unimplemented, and its sessions
   * are never moved.
   */
  installedVersion?(): Promise<string | null>
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
   * Which account the tool is logged in to on this host, as an opaque fingerprint (#726); `fingerprint` is null when the
   * tool does not say. An adapter without it never has its account compared, so a linked machine's usage is read there.
   */
  account?(): Promise<{ loggedIn: boolean | null; fingerprint: string | null }>

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
   * from the copy instead. Claude never needed it for that (it never locks, and a concurrent resume
   * simply works, measured), but implements it for the second use: a fork a requester chose for a
   * busy session (#677, `ifBusy: "fork"`), a sub-session that starts from a copy of the conversation.
   * An adapter without it leaves it unimplemented, and a fork is then not offered.
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
