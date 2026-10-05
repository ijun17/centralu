import { query, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

/**
 * Only the part of the SDK Query that we use.
 * We write down only the minimal surface, so external types do not leave the adapter.
 */
type QueryHandle = AsyncIterable<unknown> &
  UsageQuery &
  ModelQuery & {
    getContextUsage(): Promise<{ totalTokens?: number; maxTokens?: number } | undefined>
    /** Interrupts the turn in progress. Only works in streaming input mode — which is the mode we use. */
    interrupt(): Promise<unknown>
    /** Stops one background task; a task_notification with status 'stopped' follows (sdk.d.ts, measured — #290). */
    stopTask(taskId: string): Promise<void>
    supportedCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]>
    /** Closes the query and terminates the CLI process (sdk.d.ts) — called by dispose (#157). */
    close(): void
    /**
     * **Replaces the whole set** of dynamically attached MCP servers (sdk.d.ts). The in-process
     * server originally passed via `mcpServers` is also part of this set (measured in the
     * installed sdk.mjs from 0.3.263: the initial SDK server sits in the same map) — so every call
     * has to carry the orchestrator server along with everything else.
     */
    setMcpServers(servers: Record<string, McpServerConfig>): Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }>
  }
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalScope,
  NormalizedEvent,
  Question,
  QuestionAnswer,
  ToolDescriptor,
} from '@cc/protocol'
import { dataRoot } from '../../data-dir.js'
import { whichTool } from '../../env-path.js'
import { launchFor, toolExecutable, type ToolLaunch } from '../../tool-launch.js'
import { installedCliVersion } from '../../cli-version.js'
import { ClaudeLinks, ClaudePlaceholderError, type ExeFs } from './exe-link.js'
import { StartGate } from './start-gate.js'
import { deleteClaudeSession, listClaudeSessions, readClaudeHistory } from './history.js'
import { readUsage, type UsageQuery } from './usage.js'
import { ORCHESTRATOR_MCP_NAME, orchestratorMcp } from './orchestrator-mcp.js'
import { appProxy, type AppProxy } from './app-proxy.js'
import { APP_MCP_PREFIX } from '../../apps/contract.js'
import { readClaudeModels, type ModelQuery } from './models.js'
import type { AgentAdapter, AgentProcess, AgentSpawnSpec, CreateSessionOpts, DetectResult, EventSink, SessionHandle } from '../contract.js'
import { approvalDetail, ClaudeStreamNormalizer } from './normalize.js'

const exec = promisify(execFile)

/**
 * The Claude Code adapter (reflects M0 validation — docs/spikes/m0-findings.md).
 * Three constraints:
 *  1. Bare tool names are not allowed in allowedTools (it would shadow canUseTool).
 *  2. `includePartialMessages: true` (streaming deltas).
 *  3. In a trusted project, `settingSources` is left unspecified, which means **the user's
 *     settings, project settings, hooks and CLAUDE.md are all loaded.** (A comment here once said
 *     the opposite. Measured: omitting it actually ran three global hooks.) This is intentional —
 *     this app does not force a workflow. Settings a person tuned for their own tool have to keep
 *     working the same way inside this app.
 *     There are two exceptions (`settingSourcesFor`): orchestrator/coordination sessions
 *     (`settingSources: []` — an instruction arriving through a file is itself a privilege-
 *     escalation channel) and untrusted projects (`['user']` — files from the repo must not be
 *     able to decide approvals, #92).
 */

type PendingApproval = { resolve: (r: { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }) => void; input: unknown }

/**
 * AskUserQuestion's arguments to our own `Question[]`.
 *
 * This reads the raw shape directly rather than trusting the SDK's type (a boundary rule). If the
 * shape is off, it returns an empty array and **lets it fall through the ordinary path** — better
 * than presenting a half-drawn set of choices.
 */
function parseQuestions(input: unknown): Question[] {
  const raw = (input as { questions?: unknown })?.questions
  if (!Array.isArray(raw)) return []
  const out: Question[] = []
  for (const q of raw) {
    const o = (q ?? {}) as Record<string, unknown>
    const opts = Array.isArray(o.options) ? o.options : []
    const options = opts
      .map((x) => {
        const t = (x ?? {}) as Record<string, unknown>
        return { label: String(t.label ?? ''), description: String(t.description ?? '') }
      })
      .filter((x) => x.label !== '')
    if (typeof o.question !== 'string' || options.length === 0) continue
    out.push({
      question: o.question,
      header: typeof o.header === 'string' ? o.header : '',
      options,
      multiSelect: o.multiSelect === true,
    })
  }
  return out
}

/** `/goal`, alone or with an argument — not a message that merely starts with those letters ("/goal's syntax?"). */
function isGoalCommand(text: string): boolean {
  return /^\/goal(\s|$)/.test(text.trim())
}

/**
 * Is this tool one belonging to **our own in-process server** (the judgment behind the approval
 * exception)?
 *
 * An MCP tool name has the shape `mcp__<server>__<tool>`, with `__` as the separator. So a prefix
 * check (`startsWith('mcp__centralu__')`) cannot see the server name itself — a server named
 * `centralu__pw` producing `mcp__centralu__pw__navigate` also passed that check, and that tool
 * bypassed `canUseTool` entirely (measured, #93).
 *
 * This counts segments and judges by **the full server name** instead. None of our own tool
 * names contain `__` (list_sessions, propose_mcp_server, and so on all use a single underscore),
 * so there are exactly three segments. The name is already blocked on the naming side
 * (`mcpServerNameError`), but a place that grants trust must not rely on another layer's check —
 * it has to be correct on its own.
 */
function isOrchestratorTool(toolName: string): boolean {
  const parts = toolName.split('__')
  return parts.length === 3 && parts[0] === 'mcp' && parts[1] === ORCHESTRATOR_MCP_NAME
}

/**
 * If this tool belongs to an external app's proxy server, its server and tool name (M4 A-5) —
 * `mcp__app-<id>__<tool>`.
 *
 * This counts segments for the same reason as above. An app id never contains an underscore and
 * an app's own tool names never contain `__` (two rules enforced in manifest.ts), so a tool that
 * is ours has exactly three segments. This never grants anything based on the name alone —
 * whether it is read-only is asked of the attached app's own list (`SessionApps.readOnly`).
 */
function appToolOf(toolName: string): { server: string; tool: string } | null {
  const parts = toolName.split('__')
  if (parts.length !== 3 || parts[0] !== 'mcp' || !parts[1]!.startsWith(APP_MCP_PREFIX)) return null
  return { server: parts[1]!, tool: parts[2]! }
}

/** The tools that only read — the ones a read grant (#371, `CreateSessionOpts.mayRead`) lets through without a card */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])

/** The path a read tool reads: Read's file, or the folder Glob and Grep search in (absent means the working folder) */
function readTarget(toolName: string, input: Record<string, unknown>): string | null {
  const p = toolName === 'Read' ? input.file_path : input.path
  return typeof p === 'string' && p ? p : null
}

/**
 * Preset to SDK permission options.
 *
 * **Normal sends no permission mode.** This app loads the user's settings, hooks and CLAUDE.md in
 * full (settingSources left unspecified), but was silently overriding permissions on top of that.
 * That was exactly the place where we broke our own principle of not forcing a workflow.
 *
 * On the pinned SDK (0.3.263) **it cannot simply be omitted.** Measured (the probe older comments
 * call probe-perm2 is packages/agent-host/scripts/probe-permission-mode.mts — no file by the other
 * name was ever committed):
 *
 *   permissionMode:'default'                our callback is called    (settings ignored)
 *   permissionMode:'bypassPermissions'      not called
 *   sending nothing at all                   our callback is called    ← settings still ignored!
 *   sending nothing + resolvePermissionModeInCli   not called          ← settings finally apply
 *
 * Up to 0.3.285 the SDK fixes an omitted mode to 'default' and passes `--permission-mode
 * default`; only the untyped `resolvePermissionModeInCli` makes it pass no flag, so the CLI
 * resolves the mode from the settings. 0.3.286 removed that option and made its behaviour the
 * default: an omitted mode passes no flag, and the option is an unknown key it ignores.
 * Re-measured (#275, CLI 2.1.282, haiku, `defaultMode: 'acceptEdits'` planted in a throwaway
 * repo's settings.local.json, a Write call, 2026-10-04):
 *
 *   SDK      option     flag the CLI got           init permissionMode   our callback
 *   0.3.263  sent       none                       acceptEdits           not called
 *   0.3.263  omitted    --permission-mode default  default               called
 *   0.3.289  sent       none                       acceptEdits           not called
 *   0.3.289  omitted    none                       acceptEdits           not called
 *
 * So normal keeps sending it **while the workspace pin is below 0.3.286** — without it, normal is
 * silently safe. When the pin reaches 0.3.286 or later, delete the key below (normal returns `{}`)
 * and drop it from the stand-ins in project-trust.test.ts and setting-files.test.ts. Until then it
 * is harmless on newer SDKs, which is what lets the drift check (`pnpm drift:claude`, step 4) stop
 * requiring the name and guard the behaviour instead: an omitted mode must still reach the CLI as
 * no flag.
 *
 * With this value, the meaning of the three presets differs from each other for the first time —
 * before this, safe and normal were literally identical in behavior.
 *
 * **Whose settings count as "my settings" is not decided here** — that is decided by which files
 * get read (`settingSourcesFor`). In an untrusted project, normal follows only the user's own
 * settings (#92, see the table below).
 */
function permissionOptionsFor(preset: 'safe' | 'normal' | 'auto'): Record<string, unknown> {
  if (preset === 'auto') return { permissionMode: 'bypassPermissions' } // Unconditionally allowed.
  if (preset === 'safe') return { permissionMode: 'default' } // Always asks, regardless of the person's own settings.
  return { resolvePermissionModeInCli: true } // Follows the person's own settings — the key matters only below SDK 0.3.286, see above.
}

/**
 * Which settings files get read (M4 decision 3, #92, #152) — **so that a file committed to the
 * repo cannot be able to decide an approval.**
 *
 *   orchestrator/coordination sessions (noSettingFiles)   []        reads no files at all (see the comment on the query option below)
 *   trusted project / a user-folder app's session          omitted   user, project and local, all of it — the CLI's own default
 *   untrusted project                                       ['user'] only the user's own settings (~/.claude)
 *
 * **Which row applies is decided by the manager, based on the session's kind and project, and
 * passed down** (the manager's `settingFilesFor`). This must never be inferred from whether the
 * session receives tools — it once was: `orchestratorTools` being set used to mean `[]`, but the
 * worktree manager and builder sessions also receive those tools. A builder session in a trusted
 * project could then read neither CLAUDE.md nor the user's own ~/.claude (the global bypass),
 * which popped an approval card the person had turned off everywhere else. Measured (launching a
 * builder session through this adapter and having it run `touch`, normal, CLI 2.1.282, haiku,
 * 2026-09-25): before (`[]`) — card popped up, project hooks did not run, CLAUDE.md was not read;
 * now (omitted) — no card (the user's own bypass), hooks ran, CLAUDE.md was read. The orchestrator
 * still pops a card and still reads nothing, as before.
 *
 * A `.claude/` planted in the repo was able to disable our own approval card. Measured
 * (probe-project-trust.mts, CLI 2.1.282, SDK 0.3.263, planted into a temp folder standing in for
 * a checked-out repo and had it run `touch`; the user's own settings were left untouched):
 *
 *   planted                                    preset  omitted (reads everything)    ['user']
 *   permissions.allow in settings.json          safe    callback called               callback called
 *   allow in settings.local.json                safe    **not called**                callback called
 *   PreToolUse hook (allow) in settings.json    safe    **not called**, hook runs      callback called, hook does not run
 *   the same hook                               normal  not called                    not called ← decided by the user's own settings (bypass)
 *   CLAUDE.md, .claude/commands                 -       read, shows up in the list     not read, does not show up
 *
 * The CLI already did not honor allow rules from a committed settings.json. The actual holes were
 * settings.local.json (usually excluded from git, but it can still be committed) and hooks, and
 * both disabled the card **even in safe**. A hook is itself an arbitrary command as well.
 *
 * Why normal still sends `resolvePermissionModeInCli` as-is in an untrusted project: decision 3
 * disables files from the repo, not the person's own choice. If the user set bypass in their own
 * ~/.claude, that wins (see the last row of the table) — that is the person's own decision, made
 * to apply everywhere. Overriding even the user's own `defaultMode` to force 'default' and always
 * ask, just because the folder is untrusted, would turn this app into something that forces a
 * workflow. Someone who wants a card everywhere already has safe for that.
 */
function settingSourcesFor(opts: Pick<CreateSessionOpts, 'noSettingFiles' | 'projectTrusted'>): Record<string, unknown> {
  if (opts.noSettingFiles) return { settingSources: [] }
  if (opts.projectTrusted === true) return {}
  return { settingSources: ['user'] }
}

/**
 * Claude Code's words when a process lost the race to refresh the sign-in (#353). Read in the CLI
 * (2.1.289): the error is an API error message the CLI writes itself (`error: "server_error"`), in
 * one of two wordings — the first in a headless session like ours, the second in the terminal:
 *
 *   Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. …
 *   Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh) · …
 *
 * The turn then ends with an error result carrying the same text.
 */
const REFRESH_RACE = /another Claude Code process is refreshing/i

type RaceMsg = { type?: string; subtype?: unknown; is_error?: unknown; result?: unknown; errors?: unknown; message?: { content?: unknown } }

/** The text of a result or an assistant message, if it is the refresh race */
function refreshRaceText(m: RaceMsg): string | null {
  const texts: string[] = []
  if (typeof m.result === 'string') texts.push(m.result)
  if (Array.isArray(m.errors)) texts.push(...m.errors.filter((x): x is string => typeof x === 'string'))
  if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
    for (const b of m.message.content as { type?: string; text?: unknown }[]) if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text)
  }
  return texts.find((t) => REFRESH_RACE.test(t)) ?? null
}

/**
 * How this adapter starts Claude processes, shared by every session it creates (#353): where the
 * program runs from, the spacing between starts, and the processes still closing.
 */
type ClaudeLaunch = {
  platform: NodeJS.Platform
  /** The `claude` found on PATH, as the SDK takes it */
  executable: () => string | null
  links: ClaudeLinks
  gate: StartGate
  /** How long to wait before resending a turn that lost the sign-in refresh race */
  retryDelay: () => number
  /** Disposed sessions whose process has not ended yet: what `settle` waits for */
  closing: Set<Promise<void>>
  exitGraceMs: number
}

class ClaudeSession implements SessionHandle {
  externalId: string | null = null
  private queue: string[] = []
  /** The CLI version this process last reported (#297) */
  private reportedVersion: string | null = null
  private notify: (() => void) | null = null
  private closed = false
  /** The turn for a message we sent has not been closed by a result yet — decides whether to flag it as interrupted (see interrupt). */
  private turnOpen = false
  /** Choices waiting on an answer. Unlike approvals, **more than one can be open at once**. */
  private questions = new Map<string, { resolve: (r: unknown) => void; input: Record<string, unknown> }>()
  private pending = new Map<string, PendingApproval>()
  /** The live query — the channel for asking about slash commands and context. */
  private query: QueryHandle | null = null
  /** Auto-approval matchers. Seeded with the saved rules at session start, and grows with each 'always' response. */
  private alwaysAllow = new Set<string>()
  private reqCounter = 0
  private readonly stream: ClaudeStreamNormalizer
  /**
   * Proxy servers for attached apps (M4 A-5) — server name to proxy server, plus the last tool
   * list seen. The same object is reloaded for as long as the same app stays attached: the SDK
   * ignores a new object for a name that is already connected (sdk.mjs `setMcpServers`), so
   * swapping in a different object requires detaching and reattaching.
   */
  private appProxies = new Map<string, { proxy: AppProxy; tools: string }>()
  /** The orchestrator's in-process server — the same object passed initially is reloaded every time the server set changes. */
  private orchestratorServer: ReturnType<typeof orchestratorMcp> | null = null
  /** Serializes server-set changes into one line — so a later change never interleaves with one that has not finished yet. */
  private serversSync: Promise<unknown> = Promise.resolve()
  private stopAppWatch: (() => void) | null = null
  /**
   * Whether this session's CLI offers `/goal` — undefined until it has said (see `send`). Decided by
   * what the CLI advertises, never by a version number: `supportedCommands()` (answered at
   * initialization, before any message) and the init message's `slash_commands`.
   */
  private goalCommand: boolean | undefined
  /** Settles once `goalCommand` is as known as it will get — the command list answered, failed, or the stream ended. */
  private goalKnown: Promise<void> = Promise.resolve()
  private settleGoalKnown: () => void = () => {}
  /** Messages held behind a `/goal` that is waiting for `goalKnown` — so nothing sent after it overtakes it. */
  private sendGate: Promise<void> | null = null
  private notices = 0
  /** The CLI's process when it came from a `ProcessSource` (the keeper, #280 step 2) */
  private proc: AgentProcess | null = null
  private adopted = false
  /** Letting go of the process for the next host: its stream ending is not a crash */
  private detaching = false
  /** The messages the CLI has read since its last result: what a retried turn sends again (#353) */
  private inTurn: string[] = []
  /** This turn already went again once after losing the sign-in refresh race */
  private raceRetried = false
  /** An assistant message in the current turn carried the refresh-race error */
  private raceSeen: string | null = null
  /** A resend waiting out its delay, and what it will send */
  private retry: { timer: ReturnType<typeof setTimeout>; texts: string[] } | null = null
  /** The link folder this session's process runs from, released when the process is gone */
  private runKey: string | null = null
  /** Settles once the stream ended: the CLI process is gone, or this host let go of it */
  readonly ended: Promise<void>
  private markEnded: () => void = () => {}

  constructor(
    readonly sessionId: string,
    private opts: CreateSessionOpts,
    private emit: EventSink,
    private launch: ClaudeLaunch,
  ) {
    this.ended = new Promise<void>((resolve) => (this.markEnded = resolve))
    // The process runs with these until it is replaced; a model switch the CLI makes is reported against them (#304)
    this.stream = new ClaudeStreamNormalizer(sessionId, () => ({
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      verbosity: opts.verbosity ?? null,
      serviceTier: opts.serviceTier ?? null,
    }))
    this.stream.goal.seed(opts.knownGoal)
    // An adopted CLI announces its id only with its next turn's init; it is the conversation we resume
    if (opts.processSource?.adopt) this.externalId = opts.resumeExternalId ?? null
  }

  async start(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the instance needs to be reachable inside an async generator
    const self = this
    const preset = this.opts.permissionPreset

    /*
     * What to start (#353). On Windows a hard link of npm's claude.exe in the data folder, so a Claude
     * Code update can replace npm's file while this session runs; npm's placeholder is refused here
     * with the fix, instead of a spawn error Windows words as "16-bit program". Elsewhere the path
     * found on PATH, as before.
     */
    const exe = this.launch.executable()
    const run = exe ? this.launch.links.prepare(exe) : null

    /*
     * External apps (M4 A-5) — one proxy server per app. Loads whatever is currently attached,
     * and follows along without restarting the session when an app comes, goes, or its tools
     * change (syncApps).
     */
    for (const a of this.opts.apps?.current() ?? []) {
      this.appProxies.set(a.server, { proxy: appProxy(this.opts.apps!, a.server), tools: JSON.stringify(a.tools) })
    }
    if (this.opts.orchestratorTools) {
      this.orchestratorServer = orchestratorMcp(this.opts.orchestratorTools, this.opts.toolProfile, this.opts.sessionId)
    }
    const servers = this.mcpServers()

    /*
     * Spaced out on Windows, so processes started together (the orchestrator waking its sessions, a
     * grid) do not all refresh an expired sign-in at once (#353). An adopted process is already running.
     */
    if (!this.opts.processSource?.adopt) await this.launch.gate.turn()
    this.runKey = run?.key ?? null
    this.launch.links.acquire(this.runKey)

    async function* input() {
      while (!self.closed) {
        const next = self.queue.shift()
        if (next !== undefined) {
          self.inTurn.push(next)
          yield {
            type: 'user' as const,
            parent_tool_use_id: null,
            session_id: self.externalId ?? '',
            message: { role: 'user' as const, content: [{ type: 'text' as const, text: next }] },
          }
          continue
        }
        await new Promise<void>((r) => (self.notify = r))
      }
    }

    // Usage is a property of the account, but the SDK only exposes the method on a Query — this borrows a live query for it (liveQueries).
    const q: QueryHandle = (this.query = query({
      prompt: input(),
      options: {
        cwd: this.opts.cwd,
        model: this.opts.model,
        /**
         * The SDK looks for the native CLI it bundles itself, and bundling the host breaks that
         * path ("Native CLI binary for darwin-arm64 not found" — every session creation failed in
         * the packaged app). This points directly at the `claude` the user already has installed.
         * It behaves the same way in dev.
         */
        pathToClaudeCodeExecutable: run?.path ?? undefined,
        /*
         * Under the keeper (#280 step 2) the CLI is spawned there, or an already running one is
         * adopted, so the process outlives this host. Measured (CLI 2.1.282, SDK 0.3.263, haiku,
         * 2026-10-04): a new `query()` whose `spawnClaudeCodeProcess` returns the pipes of a
         * claude another host started is accepted mid-turn — its re-`initialize` re-delivers a
         * pending approval to the new `canUseTool` at once, and the rest of a running turn
         * (three more Bash calls, the result) arrives through it.
         */
        ...(this.opts.processSource ? { spawnClaudeCodeProcess: (o: AgentSpawnSpec) => this.spawnProcess(o) as never } : {}),
        /*
         * Reasoning effort. It only matters when the model supports it, so deciding support is
         * left to whatever provides the list (supportedModels) — this just passes through the
         * value it received.
         */
        effort: this.opts.effort as never,
        includePartialMessages: true,
        /*
         * A subagent's text and thinking, not only its tool blocks (#222). sdk.d.ts: "By default, only
         * tool_use/tool_result blocks from subagents are emitted … When true, the full subagent conversation is
         * forwarded so consumers can render a nested transcript." The normalizer keeps them under the launch card,
         * out of the parent's conversation (#98).
         */
        forwardSubagentText: true,
        // MCP servers — the orchestrator's tools and any attached external apps (including approved MCP servers). See mcpServers().
        ...(Object.keys(servers).length > 0 ? { mcpServers: servers } : {}),
        /*
         * Which settings files get read (settingSourcesFor) — orchestrator/coordination sessions
         * **never read instructions from a file.**
         *
         * A worker session only has permissions in its own project, but it can still write files.
         * If it wrote an instruction into the orchestrator's own folder, the orchestrator — which
         * can instruct every session — would read that as its own instruction: a path from low
         * privilege to high privilege.
         *
         * Measured values (probe):
         *   omitted       CLAUDE.md read, 3 of the user's global hooks ran
         *   ['project']   CLAUDE.md read, 0 hooks
         *   []            nothing read at all      ← this is the only one the control tower uses
         *
         * The role is injected directly through `systemPrompt` below instead. It never goes
         * through a file, so nobody can rewrite it along the way. For a project's own session,
         * whether it receives tools (manager, builder sessions) or not (worker) makes no
         * difference — the project's own trust decides it (#92, #152).
         */
        ...settingSourcesFor(this.opts),
        // A folder to read outside the working folder (#142 — an inherited handoff note). Without it, this asks (measured in CreateSessionOpts.readableDirs).
        ...(this.opts.readableDirs?.length ? { additionalDirectories: this.opts.readableDirs } : {}),
        ...(this.opts.orchestratorTools
          ? {
              /*
               * The role is guaranteed here, not by a file. AGENTS.md is a file the person can
               * and should edit, so nothing that must never be erased belongs there.
               */
              ...(this.opts.systemPromptAppend
                ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: this.opts.systemPromptAppend } }
                : {}),
            }
          : {}),
        ...permissionOptionsFor(preset),
        /*
         * The agent an app hands a schema and asks for output (M4 D-1). It is a per-query option,
         * so it can only be given when the session starts. Measured (SDK 0.3.263, CLI 2.1.282,
         * haiku): the CLI adds a `StructuredOutput` tool, and if the model answers in plain text
         * first, a "[structured-output-enforce]" message makes it call that tool instead. That
         * tool never went through `canUseTool` (no approval card appears). The answer arrives on
         * `result.structured_output` — the normalizer moves it to `turn_complete.output`.
         */
        ...(this.opts.outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: this.opts.outputSchema } } : {}),
        resume: this.opts.resumeExternalId,
        // allowedTools is never set (M0: it would shadow canUseTool).
        /*
         * **The callback is passed even in auto** (#171). It used to be omitted for auto, and
         * AskUserQuestion never reached the person — no choice card appeared, and the model moved
         * on without an answer. Measured (probe-auto-callback.mts, CLI 2.1.282, SDK 0.3.263,
         * haiku, a temp folder, 2026-09-27) — passing a callback alongside bypassPermissions:
         *
         *   AskUserQuestion                             reaches the callback (a tool asked about even before bypass)
         *   ordinary Bash                                does not reach it — bypass just lets it through
         *   Bash caught by an `ask` rule in the settings file   reaches the callback → answering allow runs it
         *   the same request, with no callback (old-style auto)   denied — "Claude requested permissions to use Bash, but you haven't granted it yet."
         *
         * So auto's own callback only accepts question choices, and **denies everything else the
         * way it used to.** Allowing it here would let our own callback approve an `ask` rule
         * written into a trusted project's own `.claude/settings.json` — the opposite direction
         * from #92, which exists so files from the repo cannot decide approvals. (The SDK leaves a
         * `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning line for this combination.)
         */
        canUseTool: async (toolName: string, toolInput: Record<string, unknown>) => {
          if (preset === 'auto' && toolName !== 'AskUserQuestion') {
            return {
            behavior: 'deny' as const,
            message: `Permission to use ${toolName} was not granted (a settings "ask" rule matched; the auto preset does not ask)`,
          }
          }
          /*
           * **We vouch for our own tools ourselves.**
           *
           * The orchestrator's centralu tools can never reach outside the sessions this app
           * manages (only the manager ever sees them), and the actual dangerous part — what the
           * target session runs — **is already gated entirely by that session's own permission
           * settings.** Asking again here would double up approval, and the reason this feature
           * exists in the first place — issuing instructions from one window — would disappear.
           *
           * Measured: without this, even a single list read popped an approval window, and the
           * orchestrator stalled on its very first tool call.
           */
          if (isOrchestratorTool(toolName)) {
            return { behavior: 'allow' as const, updatedInput: toolInput }
          }

          /*
           * **A read-only app tool is never asked about** (M4 decision 5).
           *
           * The criterion is the annotation the app attached to the tool (`readOnlyHint: true`),
           * and the judgment is made from the attached app's own list, not the name — a server
           * simply starting with `app-` is never trusted on its own (the lesson from #93). Every
           * other app tool goes through the ordinary approval card below: safe always asks, normal
           * asks whenever this callback is called. In auto, this callback is never reached
           * (bypassPermissions lets it through — see the measurement above). This is the same
           * criterion as Codex's `writes` approach, so the two adapters behave the same way.
           *
           * This is separate from the centralu exception above — that exception is never widened.
           */
          const appTool = appToolOf(toolName)
          if (appTool && self.opts.apps?.readOnly(appTool.server, appTool.tool)) {
            return { behavior: 'allow' as const, updatedInput: toolInput }
          }

          /*
           * **A read of a file another project handed back** (#371 part B). ask_project grants the caller the paths
           * the delegated session named, after this process started — so not `additionalDirectories`, which is fixed
           * at launch. A read outside the working folder lands here (measured, see `readableDirs`), and the host
           * answers whether that path was granted. Only reads: a write to the same path still asks.
           */
          if (READ_TOOLS.has(toolName) && self.opts.mayRead) {
            const target = readTarget(toolName, toolInput)
            if (target && self.opts.mayRead(target)) return { behavior: 'allow' as const, updatedInput: toolInput }
          }

          /*
           * **A choice is a question, not an approval** (FR: AskUserQuestion).
           *
           * The path here was found by measurement (probe-askuserquestion.mts, 2026-08-18):
           *   arrives via canUseTool    yes — the arguments (question, choices) arrive whole
           *   arrives via onUserDialog  no — never called even once, no matter what kind was declared
           *   allow with the input unchanged → the CLI tries its own dialog, and the tool ends with
           *                                    "The user did not answer the questions."
           *
           * So this intercepts it here and asks the person. The answer goes back as an **allow whose
           * `updatedInput.answers` carries it** (see `answerQuestion`). That field is the SDK's own
           * ("User answers collected by the permission component", sdk-tools.d.ts), and with it filled the
           * tool finishes normally: measured 2026-09-30, the result came back with `is_error: false` as
           * `Your questions have been answered: "Pick a color"="Blue"…`, and the model replied "Blue".
           *
           * Until then the answer went back as a **deny's message**, the only other way found to hand the
           * model arbitrary text as this tool's result. The model read it correctly, but the CLI marks a
           * denied tool's result as an error, so every answered card read "Failed" (2026-09-30, the Mea
           * session).
           */
          if (toolName === 'AskUserQuestion') {
            const questions = parseQuestions(toolInput)
            // If the shape is not a question, we cannot render it — never swallow it, let it flow through as usual.
            if (questions.length === 0) return { behavior: 'allow' as const, updatedInput: toolInput }
            const requestId = `q-${++self.reqCounter}`
            self.emit({ type: 'question_request', sessionId: self.sessionId, requestId, questions })
            return new Promise((resolve) => {
              self.questions.set(requestId, { resolve: resolve as (r: unknown) => void, input: toolInput })
            })
          }
          const detail = approvalDetail(toolName, toolInput, self.opts.cwd)
          /*
           * The rule's key — for a command it is the full command text, for a file edit it is
           * **the path** (#170). This matches what the UI carries on "always allow" (a command
           * uses core's `suggestMatcher`, an edit uses `detail.path`), and the Codex adapter looks
           * things up by the same rule. This used to look up an edit by `Edit:file_edit`, so a
           * rule saved by path could never match — the same file was asked about again every time
           * it was edited again. Other kinds (`other`) have no key at all: what "always" would
           * even mean for them has not been decided yet.
           */
          const key =
            detail.kind === 'command' ? detail.command
            : detail.kind === 'file_edit' && detail.path !== '?' ? detail.path
            : ''
          if (key && self.isAlwaysAllowed(key)) return { behavior: 'allow' as const, updatedInput: toolInput }

          const requestId = `req-${++self.reqCounter}`
          self.emit({ type: 'approval_request', sessionId: self.sessionId, requestId, detail })
          return new Promise((resolve) => {
            self.pending.set(requestId, { resolve: resolve as PendingApproval['resolve'], input: toolInput })
          })
        },
      },
    }))
    ClaudeAdapter.liveQueries.add(q)
    this.releaseLostCalls(q)

    this.goalKnown = new Promise<void>((resolve) => (this.settleGoalKnown = resolve))
    q.supportedCommands()
      .then((list) => {
        if (this.goalCommand === undefined && Array.isArray(list)) this.goalCommand = list.some((c) => c?.name === 'goal')
      })
      .catch(() => {})
      .finally(() => this.settleGoalKnown())

    // Follows the server set when apps come and go, and that server's list when its tools change — never restarting the session.
    this.stopAppWatch = this.opts.apps?.onChange(() => this.syncApps()) ?? null

    void (async () => {
      try {
        /*
         * The normalizer remembers what a single message cannot decide on its own — whether the
         * body already went out as deltas, or a background agent that is still running. See
         * `ClaudeStreamNormalizer`. A local synthetic response like /usage produces zero deltas
         * (measured), and without that memory there would be no way to decide whether to emit the
         * whole-response body — emitting it always gets it appended twice on an ordinary turn,
         * and never emitting it means it never shows up at all.
         */
        for await (const msg of q) {
          /*
           * **Nothing arriving after close is accepted** (#157). Even after dispose terminates
           * the process, a few already-buffered messages can still come through — the tail text
           * and result of a turn that was wrapping up. A new process may already be sitting in
           * that session's slot, so the end of the old turn must never land in the new process's
           * own record.
           */
          if (this.closed) break
          const m = msg as { type?: string; session_id?: string; subtype?: string; slash_commands?: unknown; claude_code_version?: unknown }
          if (m.type === 'system' && m.subtype === 'init' && m.session_id) this.externalId = m.session_id
          // The CLI's own version, for moving the session to a newer install (#297). Once per process: init repeats per query
          if (m.type === 'system' && m.subtype === 'init' && typeof m.claude_code_version === 'string' && m.claude_code_version !== this.reportedVersion) {
            this.reportedVersion = m.claude_code_version
            this.emit({ type: 'agent_version', sessionId: this.sessionId, version: m.claude_code_version })
          }
          if (m.type === 'system' && m.subtype === 'init' && Array.isArray(m.slash_commands)) {
            this.goalCommand = m.slash_commands.includes('goal')
            this.settleGoalKnown()
          }
          this.noteAppCalls(msg)
          if (m.type === 'assistant') this.raceSeen ??= refreshRaceText(msg as RaceMsg)
          if (m.type === 'result') this.turnOpen = false
          let events = this.stream.push(msg)
          const retrying = m.type === 'result' && this.retryAfterRefreshRace(msg as RaceMsg)
          // The turn goes again instead of failing: its error marker would end the turn on screen
          if (retrying) events = events.filter((e) => e.type !== 'error')
          for (const e of events) this.emit(e)
          // Once a turn ends, asks what is currently in the context window (FR-14).
          if (m.type === 'result' && !retrying) void this.reportContext(q)
        }
        /*
         * **If the stream ended and we did not close it, the CLI died.**
         *
         * When the CLI process disappears silently, the stream can sometimes just end with no
         * exception at all. If nothing is emitted at that point, the UI stays "working" forever
         * and the next message goes nowhere — this raises the same signal the codex adapter raises
         * from `onExit(expected=false)`.
         */
        ClaudeAdapter.liveQueries.delete(q)
        this.settleGoalKnown()
        // A stream that ends because this host let go of the process is not a death (#280 step 2)
        if (!this.closed && !this.detaching) {
          this.releaseAgents('The session process ended before this agent reported back')
          this.emit({
            type: 'error',
            sessionId: this.sessionId,
            error: { code: 'adapter_crashed', message: 'claude process ended unexpectedly', retryable: true },
          })
        }
      } catch (err) {
        ClaudeAdapter.liveQueries.delete(q)
        this.settleGoalKnown()
        /*
         * **An exception from a process we ourselves closed is not a crash** (#157). Same rule as
         * the clean-exit branch above. If settings change after a stopped turn (the last result
         * was `error_during_execution`), the old CLI ends still carrying an error result, and the
         * SDK turns that into a thrown exception, "Claude Code returned an error result: …". This
         * used to surface as adapter_crashed, and the manager would treat the brand-new process it
         * had just started as dead and close it.
         */
        if (this.closed || this.detaching) return
        this.releaseAgents('The session process ended before this agent reported back')
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'adapter_crashed', message: (err as Error).message, retryable: true },
        })
      } finally {
        // The process is gone (or another host holds it now): its link may go once nothing else runs from it
        this.launch.links.release(this.runKey)
        this.runKey = null
        this.markEnded()
      }
    })()
  }

  /**
   * A turn that lost the race to refresh the sign-in goes again once, after a few seconds (#353).
   *
   * Claude Code lets one process at a time refresh an expired sign-in; another process that needs it
   * at that moment ends its turn with "another Claude Code process is refreshing it", which the CLI
   * itself calls transient. By the time the delay is over the other process has written the new
   * token, and the resent turn reads it. The person sees why in the conversation: the CLI's own words
   * and a notice that the message goes again, instead of a failed turn. A second loss in a row is
   * reported as the failure it is.
   *
   * What goes again is what the CLI read since its last result. The CLI has already recorded those
   * messages in its conversation, so the model reads them twice, next to each other — the cost of
   * not losing what the person sent.
   *
   * @returns whether the turn goes again (its error is then not reported)
   */
  private retryAfterRefreshRace(result: RaceMsg): boolean {
    const sent = this.inTurn.splice(0)
    const seen = this.raceSeen
    this.raceSeen = null
    const failed = result.is_error === true || result.subtype !== 'success'
    const race = failed ? (refreshRaceText(result) ?? seen) : null
    if (!race) {
      this.raceRetried = false
      return false
    }
    if (this.raceRetried || sent.length === 0 || this.closed) {
      this.raceRetried = false
      return false
    }
    this.raceRetried = true
    const delay = Math.max(0, this.launch.retryDelay())
    this.emit({
      type: 'notice',
      sessionId: this.sessionId,
      level: 'warning',
      from: 'Claude Code',
      label: 'sign-in',
      audience: 'centralu',
      text: race,
      summary: `Claude Code could not refresh its sign-in because another Claude Code process was refreshing it at the same moment. Centralu sends the message again in ${Math.max(1, Math.round(delay / 1000))} s.`,
    })
    const timer = setTimeout(() => {
      this.retry = null
      if (this.closed) return
      this.queue.push(...sent)
      this.turnOpen = true
      this.notify?.()
      this.notify = null
    }, delay)
    this.retry = { timer, texts: sent }
    return true
  }

  /** A resend still waiting out its delay is called off; returns how many messages it would have sent */
  private cancelRetry(): number {
    if (!this.retry) return 0
    clearTimeout(this.retry.timer)
    const n = this.retry.texts.length
    this.retry = null
    return n
  }

  /**
   * The CLI's process, from the keeper (#280 step 2): the first call adopts the process a previous
   * host started, if there is one; any later call (none is expected) spawns a new one.
   */
  private spawnProcess(o: AgentSpawnSpec): AgentProcess {
    const src = this.opts.processSource!
    const adopt = src.adopt && !this.adopted ? src.adopt.process : null
    this.adopted = true
    this.proc = adopt ?? src.spawn({ command: o.command, args: o.args, cwd: o.cwd, env: o.env })
    return this.proc
  }

  /**
   * A call to one of our in-process servers (the orchestrator's tools, an app proxy) that was in
   * flight when the previous host went away: the CLI asked that host, nobody will ever answer, and
   * the turn would wait forever. Measured (CLI 2.1.282, SDK 0.3.263, haiku, 2026-10-04): the
   * adopted claude sat silent for 8 s with the call open; `interrupt()` from the new owner ended
   * the turn (`error_during_execution`), and the next turn — including a call to the same
   * in-process tool, now served by this host — ran normally. So the call is failed out loud and the
   * turn released, rather than left hanging; the person can send the message again.
   */
  private releaseLostCalls(q: QueryHandle): void {
    const open = this.opts.processSource?.adopt?.openCalls ?? []
    const lost = open.filter((c) => isOrchestratorTool(c.tool) || appToolOf(c.tool) !== null)
    if (lost.length === 0) return
    this.turnOpen = true
    this.stream.stopped()
    this.emit({
      type: 'error',
      sessionId: this.sessionId,
      error: {
        code: 'internal',
        message: `Centralu restarted while ${lost.map((c) => c.tool).join(', ')} was running; that call was lost, so the turn was stopped. Send the message again to retry.`,
        retryable: true,
      },
    })
    void q.interrupt().catch((err: Error) => console.error(`[claude] could not release a lost call in ${this.sessionId.slice(0, 8)}: ${err.message}`))
  }

  /**
   * Lets go of the CLI without stopping it (#280 step 2). Output keeps flowing through the normal
   * path until the keeper ends the stream, so a turn's result that was already on its way is still
   * recorded here; nothing is sent to the CLI, and an approval still waiting stays waiting for the
   * next host, which the CLI re-delivers it to.
   */
  async detach(): Promise<void> {
    this.detaching = true
    this.stopAppWatch?.()
    this.opts.apps?.close()
    if (this.query) ClaudeAdapter.liveQueries.delete(this.query)
    // An adopted process the SDK has not taken yet is let go of all the same
    const proc = this.proc ?? (this.adopted ? null : (this.opts.processSource?.adopt?.process ?? null))
    await proc?.detach?.()
    this.closed = true
    this.notify?.()
  }

  /**
   * Records a `tool_use` calling an attached app's tool with the attachment layer (M4 B-1 —
   * conversation-view card matching).
   *
   * This is not usually needed: the CLI carries the card id on the call itself
   * (app-proxy.ts's `CLAUDE_TOOL_USE_META`). This keeps the same matching logic as Codex as a
   * fallback, so the UI can still find its own card even on a CLI where that mechanism changed.
   * A card that has already received a result (`tool_result`) is removed from matching — a call
   * denied at approval never reaches the app at all.
   */
  private noteAppCalls(msg: unknown): void {
    const apps = this.opts.apps
    const m = msg as { type?: string; message?: { content?: unknown } }
    if (!apps || (m.type !== 'assistant' && m.type !== 'user') || !Array.isArray(m.message?.content)) return
    for (const b of m.message.content as { type?: string; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown }[]) {
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const t = appToolOf(b.name)
        if (t && this.appProxies.has(t.server)) apps.noteCall(b.id, t.server, t.tool, b.input ?? {})
      } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        apps.callEnded(b.tool_use_id)
      }
    }
  }

  send(text: string): void {
    /*
     * `/goal` goes to the CLI when the CLI offers it (2026-10-03). On 2026-09-07 (SDK 0.3.231 and
     * 0.3.263, the CLI of that day) the headless path had no goal at all: sent as text, the model
     * read the literal characters and role-played the hook ("Goal achieved!" with no hook behind
     * it), so every /goal was answered here with a refusal. The installed CLI 2.1.282 runs it
     * through the same `query()` path we use — measured: `goal` is in `supportedCommands()` and in
     * the init message's `slash_commands`, the CLI answers "Goal set: <condition>" itself (a
     * synthetic message, not the model), registers its Stop hook, and keeps the turn going until the
     * condition holds. What the stream says about it, and how the badge reads that, is in
     * `ClaudeGoalTracker` (normalize.ts).
     *
     * So the decision is made by capability: a CLI that advertises `goal` gets the command, one that
     * does not (older) still gets the honest one-liner. A `/goal` sent before the command list has
     * answered waits for it (`goalKnown`, milliseconds after start), and whatever is sent after it
     * waits behind it, so the order the person typed is the order the CLI reads.
     */
    const goal = isGoalCommand(text)
    if (!this.sendGate && !(goal && this.goalCommand === undefined)) {
      this.deliver(text)
      return
    }
    const gate = (this.sendGate = (this.sendGate ?? this.goalKnown).then(() => {
      if (!this.closed) {
        this.deliver(text)
        return
      }
      // Closed while it waited: the same rule as dispose's queue — a message is never dropped silently
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: {
          code: 'internal',
          message: '1 message(s) were still queued when the session closed and were not delivered — please resend',
          retryable: false,
        },
      })
    }))
    void gate.then(() => {
      if (this.sendGate === gate) this.sendGate = null
    })
  }

  private deliver(text: string): void {
    if (isGoalCommand(text)) {
      if (this.goalCommand !== true) {
        /*
         * A CLI that does not offer /goal: sent as text, the model would only role-play the hook. A
         * refusal, then — but never a `turn_complete` while one of the CLI's own turns is still open
         * (a /goal typed mid-turn): that would mark the turn done while the CLI works. The open
         * turn's result closes it. The line carries its own message id, so it never runs into the
         * model's text as one row.
         */
        this.emit({
          type: 'message_delta',
          sessionId: this.sessionId,
          role: 'assistant',
          messageId: `centralu-notice-${++this.notices}`,
          text: "This Claude Code does not offer /goal to Centralu (it is not in the CLI's command list) — update Claude Code to use goals here. Sent as a message, the model would only pretend to keep one.",
        })
        if (!this.turnOpen) this.emit({ type: 'turn_complete', sessionId: this.sessionId })
        return
      }
      this.stream.goal.commandSent()
    }
    this.queue.push(text)
    this.turnOpen = true
    this.notify?.()
    this.notify = null
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }

  respondApproval(requestId: string, decision: ApprovalDecision, scope?: ApprovalScope, matcher?: string): boolean {
    const p = this.pending.get(requestId)
    // Swapping the process empties this map and it starts fresh — the id of a card that came up before then is no longer here.
    if (!p) return false
    this.pending.delete(requestId)
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: 'Denied by user' })
    } else {
      if (decision === 'always') {
        // The matcher is computed by core and sent by the UI (agent-host never imports core — a boundary rule).
        // If none is given, this falls back to the full command text.
        const cmd = (p.input as { command?: string }).command
        const m = matcher ?? cmd
        if (m) this.alwaysAllow.add(m)
      }
      p.resolve({ behavior: 'allow', updatedInput: p.input })
    }
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
    void scope // Per-scope persistence is recorded to the store by the session manager.
    return true
  }

  /**
   * Answers a choice. The same rule as approval — **returns whether it was reached.**
   *
   * The answer goes back as an allow with `updatedInput.answers`: the question's text mapped to the chosen labels,
   * several of them joined with ", " as the SDK describes for multi-select. The tool then finishes as a success and
   * the model receives the answers in the CLI's own words (see the AskUserQuestion branch of `canUseTool`).
   */
  answerQuestion(requestId: string, answers: QuestionAnswer[]): boolean {
    const open = this.questions.get(requestId)
    if (!open) return false
    this.questions.delete(requestId)
    const byQuestion = Object.fromEntries(answers.map((a) => [a.question, a.answers.join(', ')]))
    open.resolve({ behavior: 'allow', updatedInput: { ...open.input, answers: byQuestion } })
    this.emit({ type: 'question_resolved', sessionId: this.sessionId, requestId })
    return true
  }

  /** Injects saved rules (so "always allow" survives a restart). */
  applyRules(matchers: readonly string[]): void {
    for (const m of matchers) this.alwaysAllow.add(m)
  }

  /** Only supports a trailing wildcard (`npm test*`) — the same rule as core's `matchesRule`. */
  /**
   * Reports context usage (FR-14).
   *
   * **Asks the SDK directly.** This must not be computed from a result message's `modelUsage` —
   * that number accumulates over the session, so re-reading the cache adds to it every turn, and
   * it ends up exceeding the window size (measured: "context 533%"). `getContextUsage()` returns
   * how full the current window actually is.
   *
   * A failure here is swallowed quietly — the gauge briefly disappearing is better than blocking
   * the conversation.
   */
  /**
   * All of this session's MCP servers — assembled in this one place, both at first launch and
   * whenever the set changes.
   *
   * There are two, and both are in-process, so there is never a separate process:
   *   1. The orchestrator's tools (FR-11) — everything these tools can see is exactly what the
   *      manager handed them.
   *   2. External apps' proxy servers (M4 A-5) — `app-<id>`. A server the person approved
   *      (`propose_mcp_server`) also becomes an app in the user's own folder and arrives here
   *      (A-7). This server used to be loaded raw, as a stdio entry — calls never went through
   *      mediation or recording, and a single server named `centralu` could replace the
   *      in-process orchestrator outright (#93). No server is ever loaded raw anymore.
   *
   * When the set changes (`setMcpServers`), leaving out #1 makes the SDK **detach it** — that
   * call replaces the entire set of dynamically attached servers with whatever was passed. So
   * this always loads everything, every time.
   */
  private mcpServers(): Record<string, McpServerConfig> {
    return {
      ...(this.orchestratorServer ? { [ORCHESTRATOR_MCP_NAME]: this.orchestratorServer } : {}),
      ...Object.fromEntries([...this.appProxies].map(([name, { proxy }]) => [name, proxy.config])),
    }
  }

  /**
   * An attached app changed (M4 A-5) — followed without a restart.
   *
   *   an app comes or goes (including trust flipping)   changes the set via `setMcpServers`; new tools become visible starting the next turn
   *   an attached app's own tools changed                that proxy server sends `tools/list_changed` — the server itself stays the same
   */
  private syncApps(): void {
    const apps = this.opts.apps
    if (!apps || this.closed) return
    const now = apps.current()
    const want = new Set(now.map((a) => a.server))
    let setChanged = false
    for (const name of [...this.appProxies.keys()]) {
      if (want.has(name)) continue
      this.appProxies.delete(name)
      setChanged = true
    }
    for (const a of now) {
      const tools = JSON.stringify(a.tools)
      const held = this.appProxies.get(a.server)
      if (!held) {
        // An app that detaches and reattaches also arrives with a fresh proxy server — a server the SDK has detached cannot be reconnected.
        this.appProxies.set(a.server, { proxy: appProxy(apps, a.server), tools })
        setChanged = true
      } else if (held.tools !== tools) {
        held.tools = tools
        held.proxy.toolsChanged()
      }
    }
    if (!setChanged || !this.query) return
    const q = this.query
    const servers = this.mcpServers()
    this.serversSync = this.serversSync
      .then(() => q.setMcpServers(servers))
      .then((r) => {
        const errors = Object.entries(r?.errors ?? {})
        if (errors.length) console.error(`[claude] ${this.sessionId.slice(0, 8)} app servers failed to attach:`, errors)
      })
      .catch((err: Error) => console.error(`[claude] ${this.sessionId.slice(0, 8)} could not update app servers: ${err.message}`))
  }

  /** The list of slash commands (an SDK public API). */
  async listCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    if (!this.query) throw new Error('Session is not ready yet')
    return this.query.supportedCommands()
  }

  private async reportContext(q: QueryHandle): Promise<void> {
    try {
      const usage = await q.getContextUsage()
      const used = Number(usage?.totalTokens ?? 0)
      const window = Number(usage?.maxTokens ?? 0)
      if (window > 0 && used >= 0) {
        this.emit({ type: 'context_update', sessionId: this.sessionId, used, window, exactness: 'exact' })
      }
    } catch {
      // The conversation continues even if context usage cannot be read.
    }
  }

  private isAlwaysAllowed(key: string): boolean {
    for (const m of this.alwaysAllow) {
      if (m.endsWith('*') ? key.startsWith(m.slice(0, -1)) : key === m) return true
    }
    return false
  }

  /**
   * Interrupt.
   *
   * **Both** of the following have to happen. This used to only deny the pending approval, which
   * only freed a turn that was waiting on a tool — if the model was simply thinking, nothing
   * happened at all. A button that does not stop anything when pressed is exactly the kind of
   * silent failure this project forbids.
   *
   *   1) Deny the pending approval: if `canUseTool` is holding a promise, it is stuck there with
   *      no point to clean up at even once the interrupt signal arrives. So it is released first.
   *   2) SDK interrupt: this actually cuts the turn. We can call this method because we pass the
   *      prompt as an async generator, in streaming input mode.
   */
  interrupt(): void {
    /*
     * This also stops any app calls this session made (M4 A-5). The SDK makes no promise about
     * whether the CLI sends a cancellation to a tool call when it interrupts a turn — we cut it
     * off directly. The cancellation propagates through the runtime, down to the app and whatever
     * it was doing.
     */
    this.opts.apps?.cancelAll()
    // A turn waiting to go again after the sign-in race (#353) is stopped as well: it is the same turn
    this.cancelRetry()
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Stopped by user' })
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId: id, decision: 'deny' })
    }
    this.pending.clear()
    this.releaseQuestions('Stopped by user')
    /*
     * The ending of an interrupted turn (`error_during_execution`) is an interruption, not a
     * failure (#168, the normalizer's `stopping`). This flags it **only while a turn is actually
     * running** — if pressing Stop on an idle session left the flag set, it would swallow a real
     * failure on the next turn.
     */
    if (this.turnOpen) this.stream.stopped()

    void this.query?.interrupt().catch((err: Error) => {
      // If we could not actually stop it, say so. Letting the person believe it stopped and wait is the worst outcome.
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: { code: 'internal', message: `Could not stop: ${err.message}`, retryable: true },
      })
    })

    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'waiting_input', reason: 'interrupted' })
  }

  /**
   * Stops one background task (#290). Measured on a backgrounded shell: `background_tasks_changed` without it,
   * `task_updated` killed and `task_notification` stopped follow at once, and the stream turns that into the
   * session's next `background_tasks` event. A rejection is thrown to the caller, so the person hears it.
   */
  async stopBackgroundTask(taskId: string): Promise<void> {
    if (!this.query || this.closed) throw new Error('The session process is not running')
    await this.query.stopTask(taskId)
  }

  /**
   * A pending approval is **never released silently.**
   *
   * Without a notification here, the approval card stays on the screen. Its `requestId` is not in
   * the new process's own map, so pressing it does nothing at all — the session is perfectly idle,
   * but the UI says "the agent is stuck", with no way out. `interrupt()` already handled this the
   * same way; only swapping the process was missing it.
   */
  async dispose(): Promise<void> {
    this.closed = true
    this.notify?.()
    // A message held behind an unanswered /goal is reported as undelivered, like the queue below
    this.settleGoalKnown()
    // App attachment closes along with the handle — a new handle gets its own.
    this.stopAppWatch?.()
    this.opts.apps?.close()
    /*
     * A message left in the queue follows the same rule (symmetric with the codex adapter's
     * compact queue — matched after the 2026-09-02 loss incident). Once the generator sees
     * `closed` and exits, nothing left here is ever read by anyone — and because the UI already
     * shows it as sent (the manager records it first), dropping it silently would quietly create
     * a "sent, but the agent never read it" state.
     */
    // A turn waiting out its delay after the sign-in race (#353) holds messages the same way
    const held = this.queue.length + this.cancelRetry()
    if (held > 0) {
      const n = held
      this.queue.length = 0
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: {
          code: 'internal',
          message: `${n} message(s) were still queued when the session closed and were not delivered — please resend`,
          retryable: false,
        },
      })
    }
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Session closed' })
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId: id, decision: 'deny' })
    }
    this.pending.clear()
    this.releaseQuestions('Session closed')
    this.releaseAgents('The session closed before this agent reported back')
    /*
     * **Terminates the process** (#157). This used to only end the input generator — the SDK just
     * closes the CLI's stdin, and the CLI keeps running the turn it was already on (including any
     * remaining tool calls in auto, where nothing ever asks). In a swapped-out session, the old
     * process and the new process ended up both writing into the same conversation. `close()`
     * closes stdin and sends SIGTERM if it has not ended (sdk.d.ts: "Close the query and
     * terminate the underlying process"). The usage window is also reclaimed here.
     *
     * On Windows there is no SIGTERM to send: the SDK (0.3.263, sdk.mjs `close`) ends stdin, waits
     * 2 s, then another 5 s, and only then kills a process that is still there. A CLI that is not mid-
     * turn leaves on the EOF by itself, so a sign-in refresh it may be writing (#353) gets to finish.
     * While the host keeps running that is all it takes; when the host is on its way out, `settle`
     * waits for these processes, because the host's own exit would take them along at once.
     */
    if (this.query) {
      ClaudeAdapter.liveQueries.delete(this.query)
      this.query.close()
      const ended = this.ended
      if (!this.launch.closing.has(ended)) {
        this.launch.closing.add(ended)
        void ended.then(() => this.launch.closing.delete(ended))
      }
    }
  }

  /**
   * Closes the card of a background agent that was still running — no notification arrives, since it disappeared with
   * the process (#98) — and ends every background task the session listed (#290), for the same reason.
   */
  private releaseAgents(why: string): void {
    for (const e of this.stream.release(why)) this.emit(e)
  }

  /** Releases a choice that was still waiting on an answer — **never released silently**, for the same reason as approval. */
  private releaseQuestions(why: string): void {
    // Closed without an answer: a deny, so the tool's result reads as the failure it is
    for (const [id, open] of this.questions) {
      open.resolve({ behavior: 'deny', message: why })
      this.emit({ type: 'question_resolved', sessionId: this.sessionId, requestId: id })
    }
    this.questions.clear()
  }
}

/**
 * Asks the CLI **directly** whether it is logged in (`claude auth status --json`).
 *
 * `claude --version` does not check authentication at all — it succeeds with zero credentials
 * configured. So this used to treat "installed" as "logged in", and the UI always drew a Claude
 * that was not logged in as a green dot. The failure only showed up once a session was actually
 * started (#11).
 *
 * **Why this does not fire a real query with `claude -p`:**
 * `detect()` runs every time the app starts and every time the new-session dialog opens. Firing
 * even one inference call here would mean **simply launching the app gets billed.** That is not a
 * price worth paying to learn whether the person is authenticated.
 *
 * **Why this does not check for a credentials file, the way the codex adapter does:**
 * Claude Code's credentials do not live in one place — they can be the macOS keychain, an OAuth
 * token, `ANTHROPIC_API_KEY`, `apiKeyHelper`, or Bedrock/Vertex, and `CLAUDE_CONFIG_DIR` can move
 * that whole location elsewhere. If we tried to reimplement that list ourselves, our own judgment
 * would go wrong every time the CLI changed. **What the CLI knows is asked of the CLI.**
 *
 * Measured (2.1.223): this never touches the network — the answer is the same even with a dead
 * proxy configured, and it finishes in 0.2 seconds. The CLI picks up both `CLAUDE_CONFIG_DIR` and
 * `ANTHROPIC_API_KEY` on its own.
 *
 * When not logged in, it exits with **code 1**, but the JSON still comes out on stdout as usual.
 * So this also reads the stdout attached to the thrown error.
 *
 * When the answer cannot be determined, this **passes it through** (true). A wrong "not logged
 * in" would push the person to fix something that is not broken, which is worse than the status
 * quo. An old CLI without an `auth` subcommand prints an error message instead of JSON, and that
 * means "unknown", not "not logged in".
 */
async function claudeLoggedIn(bin: ToolLaunch): Promise<boolean> {
  let out = ''
  try {
    out = (await exec(bin.command, [...bin.args, 'auth', 'status', '--json'], { timeout: 5000 })).stdout
  } catch (e) {
    // Even with exit code 1 (= not logged in), the JSON on stdout can still be trusted.
    out = typeof (e as { stdout?: unknown }).stdout === 'string' ? (e as { stdout: string }).stdout : ''
  }
  try {
    const flag = (JSON.parse(out) as { loggedIn?: unknown }).loggedIn
    return typeof flag === 'boolean' ? flag : true
  } catch {
    return true // If it is not JSON, this CLI does not know about auth status — when unknown, pass it through.
  }
}

/** What a test can change about how the adapter starts Claude; the host passes nothing */
export type ClaudeAdapterOptions = {
  platform?: NodeJS.Platform
  /** The data folder; the Windows links live under `<data>/tools/claude` */
  dataRoot?: () => string
  /** The `claude` on PATH, as the SDK takes it */
  executable?: () => string | null
  fs?: ExeFs
  /** Time between two Claude process starts. Default: 1.5 s on Windows, none elsewhere */
  startGapMs?: number
  /** Delay before resending a turn that lost the sign-in refresh race. Default: 3 to 6 s */
  retryDelay?: () => number
  /** How long `settle` waits on Windows. Default: 1.5 s, inside the app's 3 s stop grace */
  exitGraceMs?: number
}

/**
 * Why 1.5 s between starts on Windows (#353): a refresh is one request to the sign-in server and a
 * file write, well under a second on a working connection, and a Claude process takes about as
 * long to start on a laptop before it looks at the sign-in. Five sessions started together are all
 * running within six seconds. macOS keeps the sign-in in the keychain and has not shown the race,
 * so nothing waits there.
 */
const WINDOWS_START_GAP_MS = 1500

export class ClaudeAdapter implements AgentAdapter {
  readonly tool = 'claude' as const
  private readonly launch: ClaudeLaunch

  constructor(options: ClaudeAdapterOptions = {}) {
    const platform = options.platform ?? process.platform
    const executable = options.executable ?? (() => toolExecutable('claude'))
    this.launch = {
      platform,
      executable,
      links: new ClaudeLinks({ platform, root: options.dataRoot ?? dataRoot, fs: options.fs }),
      gate: new StartGate(options.startGapMs ?? (platform === 'win32' ? WINDOWS_START_GAP_MS : 0)),
      retryDelay: options.retryDelay ?? (() => 3000 + Math.floor(Math.random() * 3000)),
      closing: new Set(),
      exitGraceMs: options.exitGraceMs ?? 1500,
    }
    /*
     * Host start (Windows): links an earlier run left behind go, except the one the installed Claude
     * Code would start from. Nothing runs from them any more — the processes of the previous host
     * ended with it, and removing a name never disturbs a process still running from it.
     */
    if (platform === 'win32') {
      this.launch.links.keep(executable())
      this.launch.links.sweep()
    }
  }

  readonly descriptor: ToolDescriptor = {
    name: 'claude',
    label: 'Claude Code',
    mark: 'C',
    install: 'npm i -g @anthropic-ai/claude-code',
    login: 'claude auth login',
  }
  /**
   * The channel used to ask about usage.
   *
   * Usage is a property of the **account**, but the SDK only puts that method on a session
   * (Query). So this borrows one live query — the answer is the same no matter which session is
   * asked.
   */
  /**
   * Usage and the model list are both properties of the account, but the SDK puts both only on a
   * Query — a live query is borrowed for both.
   *
   * **Only live queries are kept here** (#157). This used to hold on to the single most-recently
   * started query even after that session closed or died, so it kept asking a dead query while an
   * older session was still alive. Insertion order is the same as start order.
   */
  static readonly liveQueries = new Set<UsageQuery & ModelQuery>()
  /** The most recently started query that is still alive. */
  static get lastQuery(): (UsageQuery & ModelQuery) | null {
    let last: (UsageQuery & ModelQuery) | null = null
    for (const q of ClaudeAdapter.liveQueries) last = q
    return last
  }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, // M0 validation: the global bypass can be overridden per session.
    contextUsage: 'exact',
    resume: true,
    autoTitle: true,
    attachments: ['image', 'file'],
    // The SDK 0.3.231 type has no response-length knob at all (only effortLevel — measured in #54).
    // If one appears, only this needs to be filled in — the UI draws its rows from this array.
    verbosities: [],
    // The conversation file (JSONL) has no lock — while we hold a session, a `claude` in a
    // terminal can still write into the same conversation. So there is no way to stamp "everything
    // up to the moment I set it down is mine." Reading history here already means the SDK reading
    // the local file anyway, so skipping it would only save a few milliseconds regardless.
    exclusiveWriter: false,
    // background_tasks_changed and the task messages (#290, ClaudeBackgroundTracker)
    backgroundTasks: true,
  }

  async detect(): Promise<DetectResult> {
    const path = whichTool('claude')
    try {
      let launch = launchFor(path ?? 'claude')
      /*
       * On Windows the version and sign-in are asked of the program sessions will start (#353): the
       * link, placed here already, so the first session does not wait for it, and npm's file is never
       * the one held. npm's placeholder is named as what it is, with the fix, rather than "not found".
       */
      const exe = this.launch.platform === 'win32' ? this.launch.executable() : null
      if (exe && /\.exe$/i.test(exe)) {
        try {
          launch = { command: this.launch.links.prepare(exe).path, args: [] }
        } catch (err) {
          if (!(err instanceof ClaudePlaceholderError)) throw err
          return { tool: 'claude', installed: false, loggedIn: false, detail: err.message }
        }
      }
      const { stdout } = await exec(launch.command, [...launch.args, '--version'], { timeout: 5000 })
      // Shows which install is actually being used — reduces confusion in an environment with several versions installed.
      const version = `${stdout.trim()} · ${path ?? 'PATH'}`
      const loggedIn = await claudeLoggedIn(launch)
      return {
        tool: 'claude',
        installed: true,
        loggedIn,
        detail: loggedIn ? version : `${version} · login required`,
      }
    } catch {
      return {
        tool: 'claude',
        installed: false,
        loggedIn: false,
        detail: 'claude CLI not found (check with `which claude` in a terminal)',
      }
    }
  }

  /**
   * The installed Claude Code (#297), from npm's `package.json` where it came from npm. On Windows
   * this never runs npm's `claude.exe` (#353: sessions start from the host's own link, and running
   * npm's file would hold it against the next update).
   */
  installedVersion(): Promise<string | null> {
    return installedCliVersion('claude', '@anthropic-ai/claude-code')
  }

  listExternalSessions(cwd: string, limit: number) {
    return listClaudeSessions(cwd, limit)
  }

  /** Deletes the original conversation ("actually delete") — the SDK's deleteSession knows its own file layout. */
  deleteExternalConversation(externalId: string, cwd: string) {
    return deleteClaudeSession(externalId, cwd)
  }

  /**
   * Account usage (FR-9).
   *
   * **This can only be asked about while a session is alive** — the SDK puts this method only on
   * a Query. It throws when there is no session at all, and the manager degrades with a reason.
   */
  async listUsage() {
    const q = ClaudeAdapter.lastQuery
    if (!q) throw new Error('A running session is required to read usage')
    return readUsage(q)
  }

  async listModels() {
    // The same situation as usage — the SDK also puts this method only on a Query.
    const q = ClaudeAdapter.lastQuery
    if (!q) throw new Error('A running session is required to list models')
    return readClaudeModels(q)
  }

  readExternalHistory(externalId: string, cwd: string, limit: number) {
    return readClaudeHistory(externalId, cwd, limit)
  }

  async createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle> {
    const s = new ClaudeSession(opts.sessionId, opts, emit, this.launch)
    await s.start()
    return s
  }

  /**
   * The host is on its way out (#353). On Windows a Node process takes its children with it when it
   * exits (libuv puts them in a job object that kills on close), so a Claude process that just got
   * EOF from `dispose` would be ended at once, possibly in the middle of writing a refreshed sign-in
   * — which leaves the next Claude process with a lock it waits out or fails on. This gives the
   * closed processes up to `exitGraceMs` to leave by themselves. Measured on Windows 11 (#353, CLI
   * 2.1.289, Node 24): a child PING.EXE was gone the moment its Node parent exited, and an idle
   * `claude -p --input-format stream-json` left 0.6 to 0.9 s after its stdin closed. Elsewhere
   * nothing waits: the SDK sends them SIGTERM on the host's exit, which they handle.
   */
  async settle(): Promise<void> {
    if (this.launch.platform !== 'win32' || this.launch.closing.size === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([...this.launch.closing]),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, this.launch.exitGraceMs))),
    ])
    clearTimeout(timer)
  }
}

export type { NormalizedEvent }
