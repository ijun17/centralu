import type { McpServerConfig, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { hostAccessEnv, toolProfileOf } from '../contract.js'
import type { randomUUID } from 'node:crypto'
import type { AgentProcess, CreateSessionOpts, InputOrigin } from '../contract.js'
import type { LocalSpawnSpec } from '../local-process.js'
import { agentTextOf } from '../../sessions/agent-text.js'
import { seatHas } from '../../sessions/tool-seats.js'
import { CLAUDE_SUBAGENT_TOOL } from './centralu-mcp.js'
import { withoutCrossSessionMessaging } from './cross-session.js'
import { probeIds } from './live-queries.js'
import type { ModelQuery } from './models.js'
import { settingSourcesFor } from './permissions.js'
import type { ClaudeMessage } from './json.js'
import type { ClaudeCards } from './session-cards.js'
import type { UsageQuery } from './usage.js'

/** One message for the CLI to read, as the session's input stream holds it. `sentAs`: the id the CLI is given it under when not its own (a resend, `ClaudeRaceRetry`) */
export type ClaudeInput = { text: string; uuid: ReturnType<typeof randomUUID>; parentNote: boolean; origin?: InputOrigin; quiet?: boolean; sentAs?: ReturnType<typeof randomUUID> }

/** Only the part of the SDK Query that we use, so external types do not leave the adapter */
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
     * **Replaces the whole set** of dynamically attached MCP servers (sdk.d.ts), the in-process server first passed via
     * `mcpServers` included (measured in sdk.mjs 0.3.263): every call carries the Assistant server too.
     */
    setMcpServers(servers: Record<string, McpServerConfig>): Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }>
  }

/** What the options of a session's query are made from; the session computes each before its process starts */
export type ClaudeQueryInputs = {
  sessionId: string
  opts: CreateSessionOpts
  /** The `claude` to run (`ClaudeLinks.prepare`), or undefined for the SDK's own lookup */
  executablePath: string | undefined
  /** The Assistant's server and the attached apps' (`ClaudeServers.mcpServers`) */
  servers: Record<string, McpServerConfig>
  /** The permission mode the CLI starts in (`permissionOptionsFor`) */
  permissionOptions: { permissionMode: PermissionMode }
  /** `{ settings }` when code intelligence is off for this session (#686), or nothing */
  codeIntelligence: { settings?: { enabledPlugins: Record<string, false> } }
  /** Starts the CLI's process: in the keeper, or here (see `spawnClaudeCodeProcess` below) */
  spawn: (o: LocalSpawnSpec) => AgentProcess
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
export function claudeQueryOptions({ sessionId, opts, executablePath, servers, permissionOptions, codeIntelligence, spawn, canUseTool }: ClaudeQueryInputs) {
  const { role } = agentTextOf(opts, CLAUDE_SUBAGENT_TOOL)
  return withoutCrossSessionMessaging({
    env: hostAccessEnv(opts.hostAccess),
    cwd: opts.cwd,
    model: opts.model,
    // The person's installed `claude`, in dev too: a bundled host breaks the SDK's lookup ("Native CLI binary … not found")
    pathToClaudeCodeExecutable: executablePath,
    /*
     * Under the keeper (#280 step 2) the CLI is spawned there, or a running one adopted. Measured (CLI 2.1.282, SDK
     * 0.3.263, haiku, 2026-10-04): a new `query()` given another host's claude's pipes is accepted mid-turn; its
     * re-`initialize` re-delivers a pending approval to the new `canUseTool`, and the rest of the turn arrives through it.
     * Without a keeper the CLI is still spawned here, not by the SDK (which signals only the CLI's pid): in a process group
     * of its own (Windows: a tree), stopping or exiting ends its helpers too (a language server and its `tsserver`, MCP
     * servers; `local-process.ts`), and it ends with this host however the host ends (`endsWithHost`, #1654 Q3, as every
     * tool: `startToolProcess`); the keeper's spawn leaves that flag out.
     */
    spawnClaudeCodeProcess: spawn as (o: LocalSpawnSpec) => never,
    // Passed through: which models support it is the model list's to say (supportedModels)
    effort: opts.effort as never,
    includePartialMessages: true,
    // A subagent's text and thinking, not only its tool blocks (#222, sdk.d.ts); kept under the launch card (#98)
    forwardSubagentText: true,
    /*
     * Thinking as readable text (#2062). Current models send thinking blocks with no text unless asked for a summary
     * ("omitted" is their default). Measured (CLI 2.1.316, 2026-11-07): with
     * the flag the blocks carry summarized text, and the output tokens stay as they were; the API documents `display` as
     * what is shown, not what is thought or billed. A flag rather than the SDK's `thinking` option, which would also pass
     * `--thinking adaptive` and so decide for the model whether it thinks. The CLI takes it since 2.1.100 at least (that
     * version's SDK already passes it); an older CLI refuses an unknown option and would not start.
     */
    extraArgs: { 'thinking-display': 'summarized' },
    ...(Object.keys(servers).length > 0 ? { mcpServers: servers } : {}),
    /*
     * Which settings files get read (settingSourcesFor): assistant/coordination sessions **never read instructions from a
     * file**, since a worker could write one into the Assistant's folder and instruct every session through it. Measured:
     *   omitted       CLAUDE.md read, 3 of the user's global hooks ran
     *   ['project']   CLAUDE.md read, 0 hooks
     *   []            nothing read at all      ← this is the only one the control tower uses
     * The role comes through `systemPrompt` below instead, which no file can rewrite. A project's own session follows the
     * project's trust whether or not it receives tools (#92, #152).
     */
    ...settingSourcesFor(opts),
    // A folder to read outside the working folder (#142 — an inherited handoff note). Without it, this asks (measured in CreateSessionOpts.readableDirs).
    ...(opts.readableDirs?.length ? { additionalDirectories: opts.readableDirs } : {}),
    ...(role ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: role } } : {}),
    ...permissionOptions,
    ...flagSettings(opts, codeIntelligence),
    // A usage probe starts no server of the person's: those in ~/.claude.json would run for a read that needs none (#726)
    ...(probeIds.has(sessionId) ? { strictMcpConfig: true } : {}),
    /*
     * The agent an app hands a schema (M4 D-1), a per-query option so given only at start. Measured (SDK 0.3.263, CLI
     * 2.1.282, haiku): the CLI adds a `StructuredOutput` tool, never through `canUseTool`, and a plain-text answer gets a
     * "[structured-output-enforce]" message; the answer is `result.structured_output` (`turn_complete.output`).
     */
    ...(opts.outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: opts.outputSchema } } : {}),
    resume: opts.resumeExternalId,
    /*
     * A session with Centralu's mail asks the person through it (#1630): a question by mail does not hold the turn, lives past a host swap and a
     * dropped link, and is answered in the Inbox. The CLI's own choice tool is off for it.
     * A session without mail (a builder, an app's agent) keeps the card
     */
    ...(opts.centraluTools && seatHas(toolProfileOf(opts), 'mail') ? { disallowedTools: ['AskUserQuestion'] } : {}),
    // allowedTools is never set (M0: it would shadow canUseTool).
    /*
     * **The callback is passed even in auto** (#171): without it AskUserQuestion never reaches the person. Measured with
     * bypassPermissions (probe-auto-callback.mts in git history, CLI 2.1.282, SDK 0.3.263, haiku, 2026-09-27):
     *   AskUserQuestion                             reaches the callback (a tool asked about even before bypass)
     *   ordinary Bash                                does not reach it — bypass just lets it through
     *   Bash caught by an `ask` rule in the settings file   reaches the callback → answering allow runs it
     *   the same request, with no callback           denied — "Claude requested permissions to use Bash, but you haven't granted it yet."
     * So auto's callback accepts only question choices and Centralu's own tools (every preset's, #382) and **denies the
     * rest**: allowing it would approve an `ask` rule in a trusted project's `.claude/settings.json`, against #92. (The SDK
     * logs `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` for this combination.)
     */
    canUseTool,
  })
}
