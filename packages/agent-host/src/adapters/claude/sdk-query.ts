import type { McpServerConfig, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { randomUUID } from 'node:crypto'
import type { AgentProcess, CreateSessionOpts, InputOrigin } from '../contract.js'
import type { LocalSpawnSpec } from '../local-process.js'
import { withoutCrossSessionMessaging } from './cross-session.js'
import { probeIds } from './live-queries.js'
import type { ModelQuery } from './models.js'
import { settingSourcesFor } from './permissions.js'
import type { ClaudeMessage } from './json.js'
import type { requestTurnHooks } from './request-hook.js'
import type { ClaudeCards } from './session-cards.js'
import type { UsageQuery } from './usage.js'

/** The SDK query a Claude session runs on: the surface of it we use, what its input carries, and its options. */

/** One message for the CLI to read, as the session's input stream holds it */
export type ClaudeInput = { text: string; uuid: ReturnType<typeof randomUUID>; parentNote: boolean; origin?: InputOrigin; quiet?: boolean }

/**
 * Only the part of the SDK Query that we use.
 * We write down only the minimal surface, so external types do not leave the adapter.
 */
export type QueryHandle = AsyncIterable<ClaudeMessage> &
  UsageQuery &
  ModelQuery & {
    getContextUsage(): Promise<{ totalTokens?: number; maxTokens?: number; model?: string; autoCompactThreshold?: number } | undefined>
    /** Interrupts the turn in progress. Only works in streaming input mode — which is the mode we use. */
    interrupt(options?: { cancelQueued: boolean }): Promise<unknown>
    /** Optional on older SDKs; cancel_async_message removes one UUID-stamped queued input. */
    cancelAsyncMessage?(uuid: string): Promise<boolean>
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

/** What the options of a session's query are made from; the session computes each before its process starts */
export type ClaudeQueryInputs = {
  sessionId: string
  opts: CreateSessionOpts
  /** The `claude` to run (`ClaudeLinks.prepare`), or undefined for the SDK's own lookup */
  executablePath: string | undefined
  /** The orchestrator's server and the attached apps' (`ClaudeServers.mcpServers`) */
  servers: Record<string, McpServerConfig>
  /** The permission mode the CLI starts in (`permissionOptionsFor`) */
  permissionOptions: { permissionMode: PermissionMode }
  /** `{ settings }` when code intelligence is off for this session (#686), or nothing */
  codeIntelligence: { settings?: { enabledPlugins: Record<string, false> } }
  /** Starts the CLI's process: in the keeper, or here (see `spawnClaudeCodeProcess` below) */
  spawn: (o: LocalSpawnSpec) => AgentProcess
  /** The person's card for every step of the CLI's own in a session's request (`requestTurnHooks`); none for a session that is not given a request turn */
  hooks?: ReturnType<typeof requestTurnHooks>
  /** The session's approval and question cards, for the preset it runs under */
  canUseTool: (toolName: string, toolInput: Record<string, unknown>, options?: { signal?: AbortSignal; matchedAskRule?: unknown; decisionReason?: string }) => ReturnType<ClaudeCards['canUseTool']>
}

/** What the CLI accepts as `autoCompactWindow` (its settings schema and `--autocompact`): 100k to 1M tokens */
export const CLAUDE_AUTO_COMPACT_MIN = 100_000
export const CLAUDE_AUTO_COMPACT_MAX = 1_000_000
/**
 * The CLI compacts when context reaches its auto-compact window **minus 33,000 tokens**. Measured on CLI 2.1.296 with
 * `getContextUsage()`: `autoCompactThreshold` was `maxTokens - 33,000` with the setting and without it, at 200k and at 1M
 * (167,000 of 200,000; 967,000 of 1,000,000; 100,000 for a window of 133,000). The adapter checks its own constant against what
 * the CLI reports (`reportContext`). To land the point at the tokens Centralu means, the window passed is that many more.
 */
export const CLAUDE_AUTO_COMPACT_BUFFER = 33_000

/**
 * Where the CLI should compact for a process passed `passed` as its auto-compact window, when the point it reports
 * (`getContextUsage().autoCompactThreshold`) is not it; null when it is, or when nothing can be said. A model whose window
 * is smaller than the one passed compacts at its own point, which is not a difference of buffers. `passed` is what the process
 * was started with: for an adopted one that is what its original host kept, not what the setting gives now (#1376).
 */
export function compactPointOff(passed: number | undefined, reported: number, modelWindow: number | null): number | null {
  if (!passed || !(reported > 0)) return null
  const expected = passed - CLAUDE_AUTO_COMPACT_BUFFER
  if (Math.abs(reported - expected) <= 1_000) return null
  if (reported < expected && modelWindow !== null && modelWindow < passed) return null
  return expected
}

/**
 * The compaction point to tell with a context reading (#1553): where the CLI says it compacts (`getContextUsage().autoCompactThreshold`),
 * which is not always the tokens Centralu asked for (the CLI clamps the window to its range and to the model's: asked 40k on a
 * 200k model it compacts at 67k). Only for a process Centralu's control started: a fresh one given `autoCompactTokens`, an adopted one
 * with the ceiling its host kept; the CLI reports a threshold whether or not anyone set it.
 */
export function claudeCompactAt(opts: Pick<CreateSessionOpts, 'autoCompactTokens' | 'autoCompactCeiling' | 'processSource'>, threshold: number): number | undefined {
  const controlled = opts.processSource?.adopt ? opts.autoCompactCeiling !== undefined : opts.autoCompactTokens !== undefined
  return controlled && threshold > 0 ? threshold : undefined
}

/** The `autoCompactWindow` that makes the CLI compact at `tokens`, inside what it accepts */
export function claudeAutoCompactWindow(tokens: number): number {
  return Math.min(CLAUDE_AUTO_COMPACT_MAX, Math.max(CLAUDE_AUTO_COMPACT_MIN, Math.round(tokens) + CLAUDE_AUTO_COMPACT_BUFFER))
}

/**
 * The settings Centralu passes in the CLI's flag layer, for this session alone (no file is touched): language-server
 * plugins off when code intelligence is (#686), and where the CLI compacts by itself (#1376). `autoCompactEnabled` goes
 * with the window, so Centralu's control means what it says when the person's own config turned it off. Nothing when
 * Centralu does not control it. (The CLI's `CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment variable still takes precedence
 * over a setting.)
 */
export function flagSettings(opts: Pick<CreateSessionOpts, 'autoCompactTokens'>, codeIntelligence: ClaudeQueryInputs['codeIntelligence']): { settings?: Record<string, unknown> } {
  const settings = {
    ...codeIntelligence.settings,
    ...(opts.autoCompactTokens ? { autoCompactEnabled: true, autoCompactWindow: claudeAutoCompactWindow(opts.autoCompactTokens) } : {}),
  }
  return Object.keys(settings).length ? { settings } : {}
}

/** The options a session's `query()` starts with */
export function claudeQueryOptions({ sessionId, opts, executablePath, servers, permissionOptions, codeIntelligence, spawn, canUseTool, hooks }: ClaudeQueryInputs) {
  return withoutCrossSessionMessaging({
    cwd: opts.cwd,
    model: opts.model,
    /**
     * The SDK looks for the native CLI it bundles itself, and bundling the host breaks that
     * path ("Native CLI binary for darwin-arm64 not found" — every session creation failed in
     * the packaged app). This points directly at the `claude` the user already has installed.
     * It behaves the same way in dev.
     */
    pathToClaudeCodeExecutable: executablePath,
    /*
     * Under the keeper (#280 step 2) the CLI is spawned there, or an already running one is
     * adopted, so the process outlives this host. Measured (CLI 2.1.282, SDK 0.3.263, haiku,
     * 2026-10-04): a new `query()` whose `spawnClaudeCodeProcess` returns the pipes of a
     * claude another host started is accepted mid-turn — its re-`initialize` re-delivers a
     * pending approval to the new `canUseTool` at once, and the rest of a running turn
     * (three more Bash calls, the result) arrives through it.
     *
     * Without a keeper the CLI is still spawned here rather than by the SDK, which signals only
     * the CLI's own pid: in a process group of its own (Windows: a tree), stopping it also ends
     * the helpers it started (a language server and its `tsserver`, MCP servers), and so does
     * its exit (`local-process.ts`). Started here, it also ends with this host however the host ends, stdin's end or not
     * (`endsWithHost`, #1654 Q3, as every tool: core/tool-process.ts); the keeper's spawn leaves that flag out.
     */
    spawnClaudeCodeProcess: (o: LocalSpawnSpec) => spawn({ ...o, endsWithHost: true }) as never,
    /*
     * Reasoning effort. It only matters when the model supports it, so deciding support is
     * left to whatever provides the list (supportedModels) — this just passes through the
     * value it received.
     */
    effort: opts.effort as never,
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
    ...settingSourcesFor(opts),
    // A folder to read outside the working folder (#142 — an inherited handoff note). Without it, this asks (measured in CreateSessionOpts.readableDirs).
    ...(opts.readableDirs?.length ? { additionalDirectories: opts.readableDirs } : {}),
    ...(opts.orchestratorTools
      ? {
          /*
           * The role is guaranteed here, not by a file. AGENTS.md is a file the person can
           * and should edit, so nothing that must never be erased belongs there.
           */
          ...(opts.systemPromptAppend
            ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: opts.systemPromptAppend } }
            : {}),
        }
      : {}),
    ...permissionOptions,
    // Every tool call of a session's request in front of the person, in any permission mode (request-hook.ts)
    ...(hooks ? { hooks } : {}),
    ...flagSettings(opts, codeIntelligence),
    // A usage probe starts no server of the person's: those in ~/.claude.json would run for a read that needs none (#726)
    ...(probeIds.has(sessionId) ? { strictMcpConfig: true } : {}),
    /*
     * The agent an app hands a schema and asks for output (M4 D-1). It is a per-query option,
     * so it can only be given when the session starts. Measured (SDK 0.3.263, CLI 2.1.282,
     * haiku): the CLI adds a `StructuredOutput` tool, and if the model answers in plain text
     * first, a "[structured-output-enforce]" message makes it call that tool instead. That
     * tool never went through `canUseTool` (no approval card appears). The answer arrives on
     * `result.structured_output` — the normalizer moves it to `turn_complete.output`.
     */
    ...(opts.outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: opts.outputSchema } } : {}),
    resume: opts.resumeExternalId,
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
     * So auto's own callback only accepts question choices and Centralu's own tools (which every
     * preset lets through, #382), and **denies everything else the way it used to.** Allowing it here would let our own callback approve an `ask` rule
     * written into a trusted project's own `.claude/settings.json` — the opposite direction
     * from #92, which exists so files from the repo cannot decide approvals. (The SDK leaves a
     * `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning line for this combination.)
     */
    canUseTool,
  })
}
