import type { NormalizedEvent, RequestInput, TokenUsage } from '@cc/protocol'
import { TouchedFiles } from '../file-changes.js'
import { addTokens, NO_TOKENS } from '../token-usage.js'
import { toolResultEvent } from '../tool-result.js'
import { subagentSteps } from '../subagent-steps.js'
import { UnmappedTypes } from '../unmapped.js'
import { RetryActivity } from '../retry-activity.js'
import { ClaudeBackgroundTracker } from './background-tracker.js'
import { activeGoalEvents, conversationResetEvents, systemEvents } from './cli-messages.js'
import { ClaudeGoalTracker } from './goal-tracker.js'
import { str, type Json } from './json.js'
import { assistantEvents, backgroundLaunch, requestInputTokens, streamEventEvents, userEvents } from './model-messages.js'
import { ClaudeTaskPlan } from './task-plan.js'
import { agentReport, agentStats, approvalDetail, editedPaths, toolSummary } from './tool-summary.js'
import { rateLimitEvents, resultEvents } from './turn-ending.js'

export { ClaudeBackgroundTracker, ClaudeGoalTracker, approvalDetail, toolSummary }

/** The settings a Claude process was launched with — the snapshot a `settings_changed` the tool made carries (#304). */
export type ClaudeLaunchedSettings = { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null }

/**
 * Converts Claude SDK messages into NormalizedEvent (a pure function, so contract tests are
 * possible). SDK types end here — only protocol types ever leave.
 */

/**
 * One SDK message to 0..N events.
 * `msg` is deliberately `unknown` — so SDK types never flow past this boundary.
 */
export function normalizeMessage(
  msg: unknown,
  sessionId: string,
  opts?: {
    /**
     * Whether this assistant message's body already went out as streaming deltas — the adapter
     * tracks this and passes it in.
     *
     * The body is normally drawn only from `stream_event` deltas, and an assistant message's own
     * text block is dropped — but **a response that arrives with no deltas at all is real**: an
     * answer the CLI synthesizes locally, like /usage, arrives as zero deltas and one whole-body
     * assistant message (measured — 0 deltas, a 1,046-character body). In that case, not emitting
     * it here means the command ran but the answer never shows up in the UI at all. Conversely,
     * emitting it again on a turn that was streamed appends the same text twice — hence the need
     * for this flag.
     */
    textStreamed?: boolean
    /**
     * The thinking of this assistant message already went out as streamed `thinking_delta`s. The finished
     * message repeats the whole thinking block, so emitting it again doubled every thought. That stayed
     * hidden while thinking arrived encrypted as "" (#58); once models sent readable thinking, a message
     * that thought and then called a tool (no text, so `textStreamed` stayed false) showed its thinking
     * twice, stored twice in one row.
     */
    reasoningStreamed?: boolean
  },
): NormalizedEvent[] {
  const m = msg as Json
  const type = str(m.type)
  const out: NormalizedEvent[] = []

  /*
   * A subagent's messages are not the parent's conversation (#98).
   *
   * The assistant and user messages of a subagent launched with the Agent tool arrive mixed into
   * the parent's own stream, carrying the id of the call that launched it in `parent_tool_use_id`
   * (sdk.d.ts SDKAssistantMessage: "parent_tool_use_id is non-null when the message was produced
   * inside a subagent started by that tool_use"). This field was never checked, so a subagent's
   * tool call would get stuck right in the middle of the parent writing its own text (mid-word —
   * split across `남았` / Bash / `는지`), and the full report (15-24KB) showed up once as the
   * parent's own answer and once again as the parent's summary.
   *
   * **Do not assume text will never arrive here.** The SDK docs say text only arrives with
   * `forwardSubagentText` turned on, but measured (CLI 2.1.282, with no such option set), a
   * subagent's final text arrived anyway. Everything is dropped from the parent's own
   * conversation, and only a tool call is routed — as **the live output of the card that launched
   * it** — with `callId` recording who did it. Because this never adds a new line to the
   * conversation, the parent's paragraph is no longer split either. Usage is dropped too: a
   * subagent's own tokens were overwriting the parent's usage figures.
   *
   * Files are the exception — a file a subagent edited is still a file changed inside this
   * session's own working folder, so it is still reported to conflict detection and highlighting
   * (FR-2, FR-5), from its steps, once the edit's result says it went through (`ClaudeStreamNormalizer`).
   *
   * **What the subagent did is kept, under its launch card** (#222). Its text, readable thinking,
   * tool calls and their results go out as `subagent_event`s tagged with that same
   * `parent_tool_use_id`, which the host stores apart from the conversation. They are read the way
   * the parent's own messages are read — `normalizeMessage` on the message as if it were the
   * parent's — and only the four kinds of step are kept: usage, images and a nested agent's
   * "launched" line are not the subagent's record. `forwardSubagentText` (index.ts) makes the
   * text and thinking arrive for every subagent; without it only tool blocks are promised. A
   * subagent's stream events carry no text of their own (measured: every stream_event had
   * parent=null), so its text comes from the whole assistant message, block by block.
   */
  const parent = str(m.parent_tool_use_id)
  if (parent && (type === 'assistant' || type === 'user' || type === 'stream_event')) {
    if (type === 'stream_event') return out
    return subagentSteps(sessionId, parent, normalizeMessage({ ...m, parent_tool_use_id: null }, sessionId))
  }

  /*
   * One family per file: what the CLI says about itself (cli-messages.ts), what the model says (model-messages.ts),
   * and how the turn ends (turn-ending.ts).
   */
  switch (type) {
    case 'conversation_reset':
      return conversationResetEvents(m, sessionId)
    case 'system':
      return systemEvents(m, sessionId)
    case 'active_goal':
      return activeGoalEvents(m, sessionId)
    case 'stream_event':
      return streamEventEvents(m, sessionId)
    case 'assistant':
      return assistantEvents(m, sessionId, opts)
    case 'user':
      return userEvents(m, sessionId)
    case 'rate_limit_event':
      return rateLimitEvents(m, sessionId)
    case 'result':
      return resultEvents(m, sessionId)
    default:
      return out
  }
}

/**
 * Every message type the adapter handles or leaves out on purpose, keyed as `type`, or `system/<subtype>` for system
 * messages. Anything else is said once per session in host.log (`UnmappedTypes`, #58). The groups follow the #58
 * survey (2026-10-04, CLI 2.1.282, SDK 0.3.263, 39 `SDKMessage` members plus `active_goal`):
 *
 *   - mapped: a branch in `normalizeMessage`, this class, or `system/init` read in index.ts
 *   - ignored by #58's body as progress detail
 *   - correctly ignored: types only sent for options or features Centralu does not use (`side_question`, synchronous
 *     plugin installs, session-state events, the remote bridge, file checkpoints, URL elicitation, prompt suggestions,
 *     a `SessionStore`)
 *
 * The types the survey would show or store but nobody has wired yet stay out on purpose: `system/permission_denied`,
 * `system/commands_changed` and `system/memory_recall` among them. Their log line is how a real instance gets noticed.
 */
export const CLAUDE_KNOWN_TYPES: ReadonlySet<string> = new Set([
  // mapped
  'assistant', 'user', 'result', 'stream_event', 'rate_limit_event', 'active_goal', 'system/init', 'system/status',
  'system/compact_boundary', 'system/local_command_output', 'system/task_notification',
  // mapped by #290 (ClaudeBackgroundTracker)
  'system/background_tasks_changed', 'system/task_started', 'system/task_updated',
  // mapped by #304: resets, notices, retries and the refusal pair
  'conversation_reset', 'system/informational', 'system/notification', 'system/api_retry',
  'system/model_refusal_fallback', 'system/model_refusal_no_fallback',
  // ignored by #58
  'tool_progress', 'system/task_progress', 'system/hook_started', 'system/hook_progress', 'system/hook_response',
  'system/thinking_tokens',
  // correctly ignored
  'system/control_request_progress', 'system/plugin_install', 'system/session_state_changed',
  'system/worker_shutting_down', 'system/files_persisted', 'system/elicitation_complete', 'prompt_suggestion',
  'system/mirror_error',
])

/**
 * Normalizes while following one parent stream — memory for things that cannot be decided by
 * looking at a single message alone.
 *
 * Both of these used to live in the adapter loop, or did not exist at all:
 *
 *  1. **Whether the body already went out as deltas** (`textStreamed`, see `normalizeMessage`'s
 *     opts). This flag is cleared every time an assistant message arrives, but a subagent's own
 *     assistant message was also being counted as "assistant" (#98). If a subagent's message
 *     landed between the parent's last delta and the parent's own body, the flag was cleared
 *     early, before the parent's body arrived, and **the parent's whole text was appended a
 *     second time.** Now only the parent's own messages are counted.
 *
 *  2. **A background agent that is still running** (#98). The `tool_result` from the moment it is
 *     launched does not close the card (`backgroundLaunch`). News that it finished arrives as
 *     `system/task_notification` (measured: `tool_use_id`, `status`, `summary`,
 *     `usage{tool_uses, duration_ms}`), and that is what closes it. Only a card left open gets
 *     closed — the notification also arrives (measured) for a background Bash the parent launched
 *     directly, and for a Bash inside a subagent (`owned_by_subagent`), but those cards are already
 *     closed by their own result.
 *
 *     **Closing is deferred while the parent is mid-write.** Running three agents side by side
 *     routinely means the parent is writing an update about a different agent at the exact moment
 *     one of them finishes (a dogfooding session). Because `tool_result` marks a chunk boundary on
 *     the storage side (`manager persistMessage`), emitting it right there splits the parent's
 *     paragraph into two rows — the UI renders it joined back together, but the handoff record and
 *     the preview both read by row. To keep an event the parent did not emit from cutting the
 *     parent's own text, this is sent after the assistant message that closes that chunk instead.
 */
/**
 * How long what a request wrote stays cached, from the API's split of its writes (`cache_creation`:
 * `ephemeral_1h_input_tokens`, `ephemeral_5m_input_tokens`). Claude Code decides the lifetime per request (CLI 2.1.289:
 * one hour for a subscriber's main conversation and SDK calls when not on overage, five minutes for subagents, API
 * keys and overage, with `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL` and the `promptCacheTtl` setting
 * over it), and that decision is not visible from outside; what the API reports it wrote is.
 */
function ttlOf(split: unknown): { cacheTtl?: '5m' | '1h' } {
  const c = (split ?? {}) as Json
  if (Number(c.ephemeral_1h_input_tokens ?? 0) > 0) return { cacheTtl: '1h' }
  if (Number(c.ephemeral_5m_input_tokens ?? 0) > 0) return { cacheTtl: '5m' }
  return {}
}

/** The tokens of the `usage_update` among some events, if there is one */
function readingOf(events: readonly NormalizedEvent[]): TokenUsage | undefined {
  for (const e of events) if (e.type === 'usage_update') return e.tokens
  return undefined
}

export class ClaudeStreamNormalizer {
  private textStreamed = false
  /** Readable thinking of the current assistant message already went out as deltas (see normalizeMessage's opts) */
  private reasoningStreamed = false
  /**
   * We interrupted the turn — the first `result` that arrives after that is the ending of the
   * interrupted turn (#168).
   *
   * The CLI closes an interrupted turn with an `error_during_execution` result. Emitting that as
   * an ordinary error would leave a turn the person stopped on purpose recorded with a "Turn
   * failed: error_during_execution" marker and an error state. Since `interrupt()` has already
   * returned the state to waiting-for-input, that ending emits nothing at all. An
   * `error_during_execution` for any other reason is still a failure, as before.
   */
  private stopping = false
  private readonly background = new Set<string>()
  /** Agent card closures waiting for the parent's text chunk to close. */
  private deferred: NormalizedEvent[] = []
  /** The id of the model call whose chunks are streaming now (`message_start`). */
  private streamMessageId: string | undefined
  /**
   * The model requests whose input already went out as a `request` (prompt cache accounting, docs/agent-host.md
   * §6.1). The CLI can send one response as several assistant messages (one per content block), each carrying the
   * same usage under the same message id; counting each would multiply that request. Bounded: a subagent's messages
   * interleave with the parent's, so this holds a few recent ids, not just the last one.
   */
  private readonly requestsSeen: string[] = []
  /** The parent's last `usage_update` reading, which a subagent's request repeats (see `withRequest`) */
  private lastTokens: TokenUsage | null = null
  /** The last turn result's reading, the process's total then, and the parent's requests since (see `withRequest`) */
  private resultTokens: TokenUsage | null = null
  private sinceResult: TokenUsage = NO_TOKENS
  /** Claude Code's task list, kept as the plan (see `followTasks`) */
  private readonly taskPlan: ClaudeTaskPlan
  /** Edits whose result has not come yet (see `touch`) */
  private readonly touched: TouchedFiles
  /** The session's /goal, read off the stream (see `ClaudeGoalTracker`). */
  readonly goal: ClaudeGoalTracker
  /** Message types this session received that nothing maps or ignores on purpose, said once each in host.log (#58) */
  private readonly unmapped: UnmappedTypes

  /** The session's background work (see `ClaudeBackgroundTracker`). */
  readonly tasks: ClaudeBackgroundTracker
  /** The CLI is retrying a failed API call (`system/api_retry`, #304): the same rule as Codex's (`RetryActivity`) */
  private readonly retry: RetryActivity
  /**
   * What the CLI said when the model refused and no fallback ran (`model_refusal_no_fallback`, #304), held until the
   * turn's result: if the turn failed, this is its message (the result itself only says *that* it failed); if not, it
   * goes out as a notice.
   */
  private refusal: string | null = null

  constructor(
    private readonly sessionId: string,
    /**
     * The settings the CLI was launched with, for the snapshot a model switch the tool made carries (#304). The
     * host applies only what differs from what it launched, so an absent getter means "nothing but the model".
     */
    private readonly settings: () => ClaudeLaunchedSettings = () => ({ model: null, effort: null, verbosity: null, serviceTier: null }),
  ) {
    this.goal = new ClaudeGoalTracker(sessionId)
    this.touched = new TouchedFiles(sessionId)
    this.taskPlan = new ClaudeTaskPlan(sessionId)
    this.unmapped = new UnmappedTypes('claude', sessionId, CLAUDE_KNOWN_TYPES)
    this.tasks = new ClaudeBackgroundTracker(sessionId)
    this.retry = new RetryActivity(sessionId)
  }

  /**
   * The refusal pair (#304), not exercised: a refusal cannot be asked for. Shapes from sdk.d.ts (SDK 0.3.263) and the
   * CLI's own code (2.1.289).
   *
   *   model_refusal_fallback      the model ended with stop_reason "refusal" and the turn is retried once on
   *                               `fallback_model`. With `scope` session (or absent, older CLIs) the CLI keeps the
   *                               fallback for the rest of the session, so the model the screen shows would be wrong:
   *                               a `settings_changed` the tool made, plus a notice saying why. With scope `local` only
   *                               a subagent's or a side question's answer came from the fallback, and the session model
   *                               is unchanged: host.log only. (`retracted_message_uuids`, the refused partial the SDK
   *                               asks hosts to remove, is not acted on: the conversation keeps what was shown.)
   *   model_refusal_no_fallback   no retry ran. The CLI's main-thread paths send it with `content: ""`, so the line
   *                               falls back to the refusal's explanation, then its category.
   */
  private refusalEvents(m: Json): NormalizedEvent[] {
    const subtype = str(m.subtype)
    const explanation = str(m.api_refusal_explanation)
    if (subtype === 'model_refusal_no_fallback') {
      const category = str(m.api_refusal_category)
      this.refusal =
        str(m.content).trim() || explanation || `The model declined to answer${category ? ` (${category})` : ''}`
      return []
    }
    const from = str(m.original_model, 'the model')
    const to = str(m.fallback_model)
    if (str(m.scope) === 'local') {
      console.error(`[claude] ${this.sessionId.slice(0, 8)} a subagent's answer came from ${to} after ${from} declined`)
      return []
    }
    if (!to) return []
    const text =
      str(m.content).trim() ||
      `${from} declined to answer, so Claude Code switched this session to ${to}${explanation ? `: ${explanation}` : ''}`
    return [
      { type: 'notice', sessionId: this.sessionId, level: 'warning', text, from: 'Claude Code', label: 'model switch' },
      { type: 'settings_changed', sessionId: this.sessionId, ...this.settings(), model: to, by: 'tool' },
    ]
  }

  /**
   * Marks an assistant message's usage as one model request's input, the first time its message id is seen (see
   * `requestsSeen`).
   *
   * A subagent's requests count too: they read and write the same account's cache, and its first request writes its
   * whole prompt. Its usage is dropped from the parent's events (a subagent's tokens used to overwrite the parent's
   * figures, see `normalizeMessage`), so its request rides on a `usage_update` that repeats the parent's last reading:
   * every reader of `tokens` takes the last value, so the repeat changes nothing there. A parent always has a reading
   * by then, since it launched the subagent from a message of its own.
   */
  private withRequest(m: Json, events: NormalizedEvent[], subagent: boolean): NormalizedEvent[] {
    const message = (m.message ?? {}) as Json
    const id = str(message.id)
    const usage = message.usage as Json | undefined
    const fresh = !!usage && !(id && this.requestsSeen.includes(id))
    if (!subagent) {
      /*
       * `TokenUsage` is a running reading (#843): the turn's result carries the process's total, and an assistant
       * message only its own request. Sent as it came, that request replaced the session's figures mid-turn (a reading
       * of 2M dropped to one request's 80k), and the result put them back. The running reading is the last result's
       * plus each request since, each counted once however many messages repeat it.
       */
      const request = readingOf(events)
      if (request && fresh) this.sinceResult = addTokens(this.sinceResult, request)
      if (request) {
        const running = addTokens(this.resultTokens ?? NO_TOKENS, this.sinceResult)
        events = events.map((e) => (e.type === 'usage_update' ? { ...e, tokens: running } : e))
        this.lastTokens = running
      }
    }
    if (!id || !usage || !fresh) return events
    this.requestsSeen.push(id)
    if (this.requestsSeen.length > 32) this.requestsSeen.shift()
    const request: RequestInput = {
      ...requestInputTokens(usage),
      ...(subagent ? { agent: str(m.parent_tool_use_id) } : {}),
      ...ttlOf(usage.cache_creation),
    }
    if (subagent) {
      return this.lastTokens ? [...events, { type: 'usage_update', sessionId: this.sessionId, tokens: this.lastTokens, request }] : events
    }
    return events.map((e) => (e.type === 'usage_update' ? { ...e, request } : e))
  }

  /**
   * The files an edit changed, marked by its result rather than its call (#843), for the parent's own calls and a
   * subagent's steps alike: a denied edit's result is an error, and it marks nothing.
   */
  private touch(events: NormalizedEvent[]): NormalizedEvent[] {
    const out: NormalizedEvent[] = []
    for (const e of events) {
      out.push(e)
      const step = e.type === 'subagent_event' ? e.step : e
      if (step.type === 'tool_call') this.touched.call(step.callId, editedPaths(step.summary))
      else if (step.type === 'tool_result') out.push(...this.touched.result(step.callId, step.ok))
    }
    return out
  }

  /**
   * The task list as the plan (`ClaudeTaskPlan`, #843), from the parent's own calls: a subagent's tasks are not the
   * session's plan. The message's `tool_use_result` is read only when it carries one result.
   */
  private followTasks(m: Json, events: NormalizedEvent[]): NormalizedEvent[] {
    const results = (((m.message as Json | undefined)?.content ?? []) as Json[]).filter((b) => str(b?.type) === 'tool_result')
    const record = results.length === 1 && typeof m.tool_use_result === 'object' && m.tool_use_result !== null ? (m.tool_use_result as Json) : undefined
    const out: NormalizedEvent[] = []
    for (const e of events) {
      out.push(e)
      if (e.type === 'tool_call') this.taskPlan.call(e.callId, e.summary.tool, e.input)
      else if (e.type === 'tool_result') out.push(...this.taskPlan.result(e.callId, e.ok, e.output ?? '', record))
    }
    return out
  }

  /** The adapter interrupted the turn (see `stopping` above). */
  stopped(): void {
    this.stopping = true
  }

  /** The interrupt did not reach the CLI: the turn goes on, and however it ends is its own ending (see `stopping`). */
  stopFailed(): void {
    this.stopping = false
  }

  /** Raises `retrying` once per episode and puts the previous activity back when output flows again (see `retry`). */
  private followRetry(type: string, events: NormalizedEvent[]): NormalizedEvent[] {
    const out = events.filter((e) => e.type !== 'activity' || this.retry.admit(e.activity))
    const resumed = type === 'stream_event' || type === 'assistant' ? this.retry.resumed() : null
    if (resumed) out.unshift(resumed)
    if (type === 'result') this.retry.ended()
    return out
  }

  push(msg: unknown): NormalizedEvent[] {
    const m = msg as Json
    const type = str(m.type)
    const subagent = str(m.parent_tool_use_id) !== ''
    this.unmapped.note(type === 'system' ? `system/${str(m.subtype)}` : type)
    const tasks = this.tasks.push(m)

    if (type === 'system' && str(m.subtype) === 'task_notification') {
      const callId = str(m.tool_use_id)
      if (!this.background.delete(callId)) return tasks
      const status = str(m.status, 'completed')
      const usage = (m.usage ?? {}) as Json
      /*
       * The notification's `summary` is the agent's whole final report, not a one-line status (#221). Read in the
       * CLI (2.1.282): a finished local agent's task is closed with `summary: <its final content joined by "\n"> ||
       * <description>`, and the task_notification carries that summary as it is. (The model-facing notification
       * puts `Agent "…" finished` in its own <summary> and the report in <result>; the SDK message has only the
       * one field.) So the whole of it is the result's record, as for a foreground agent.
       */
      const output = agentReport(str(m.summary), agentStats(usage.tool_uses, usage.duration_ms, status))
      const done = toolResultEvent(this.sessionId, callId, status === 'completed', output)
      if (!this.textStreamed && !this.reasoningStreamed) return [...tasks, done]
      this.deferred.push(done)
      return tasks
    }

    if (type === 'user' && !subagent) {
      const launched = backgroundLaunch(m)
      if (launched) this.background.add(launched)
    }

    if (type === 'system' && /^model_refusal_(no_)?fallback$/.test(str(m.subtype))) return [...tasks, ...this.refusalEvents(m)]

    let events = [
      ...tasks,
      ...normalizeMessage(msg, this.sessionId, {
        textStreamed: this.textStreamed,
        reasoningStreamed: this.reasoningStreamed,
      }),
    ]
    if (type === 'assistant') events = this.withRequest(m, events, subagent)
    // The turn's result is a running reading too: a subagent's request repeats whichever came last
    else if (type === 'result' && !subagent) {
      const total = readingOf(events)
      if (total) {
        this.lastTokens = total
        this.resultTokens = total
        this.sinceResult = NO_TOKENS
      }
    }
    events = this.touch(events)
    if (!subagent) events = this.followTasks(m, events)
    if (subagent) return events
    events = this.followRetry(type, events)
    if (type === 'result' && this.refusal !== null) {
      const refusal = this.refusal
      this.refusal = null
      const failed = events.some((e) => e.type === 'error')
      events = failed
        ? events.map((e) => (e.type === 'error' ? { ...e, error: { ...e.error, message: refusal } } : e))
        : [{ type: 'notice', sessionId: this.sessionId, level: 'warning', text: refusal, from: 'Claude Code', label: 'refusal' }, ...events]
    }
    /*
     * Which message a chunk of text belongs to (#212, Claude edition). A model call announces its id in
     * `message_start` and its chunks carry none; a message that arrives whole carries its own. Two
     * messages with nothing recorded between them used to become one row — measured with /goal
     * (2026-10-03): the CLI's own "Goal set: <condition>" and the model's first words, and the model's
     * words on either side of a Stop hook that sent it back to work, read as one sentence.
     */
    if (type === 'stream_event') {
      const e = (m.event ?? {}) as Json
      if (str(e.type) === 'message_start') this.streamMessageId = str((e.message as Json | undefined)?.id) || undefined
    }
    const wholeId = type === 'assistant' ? str((m.message as Json | undefined)?.id) || undefined : undefined
    const messageId = type === 'stream_event' ? this.streamMessageId : wholeId
    if (messageId) events = events.map((e) => (e.type === 'message_delta' && !e.messageId ? { ...e, messageId } : e))
    events.push(
      ...this.goal.push(m, {
        streamed: wholeId !== undefined && wholeId === this.streamMessageId,
        interrupted: type === 'result' && this.stopping,
      }),
    )
    if (type === 'stream_event' && events.some((e) => e.type === 'message_delta')) this.textStreamed = true
    // Only thinking that carried text counts: encrypted thinking streams token estimates, and its block is ""
    if (type === 'stream_event' && events.some((e) => e.type === 'reasoning_delta' && !!e.text)) this.reasoningStreamed = true
    /*
     * An assistant message marks the end of one body — the next body starts counting again from
     * scratch. **A result also marks an end** (#168): stopping mid-write means that chunk's
     * assistant message never arrives, so the flag stayed set into the next turn and dropped a
     * whole-response message that arrived with no deltas (a local response like /usage, or an API
     * error the CLI synthesized).
     */
    if (type === 'assistant' || type === 'result') {
      this.textStreamed = false
      this.reasoningStreamed = false
    }
    if (type === 'result' && this.stopping) {
      this.stopping = false
      if (str(m.subtype) === 'error_during_execution') events = events.filter((e) => e.type !== 'error')
    }
    // The chunk closed (or the turn ended with no body) — the deferred card closures are emitted now.
    if ((type === 'assistant' || type === 'result') && this.deferred.length > 0) events.push(...this.deferred.splice(0))
    return events
  }

  /**
   * A card for an agent that never reported back is **never left open silently.**
   *
   * A background agent runs inside the CLI process (`task_type: 'local_agent'`) — closing or
   * losing the process makes it disappear along with it, and the notification never arrives at
   * all. Left alone, the card would stay marked "still working" forever. This is the same rule as
   * releasing approval and question cards in `dispose`.
   */
  release(why: string): NormalizedEvent[] {
    // Something that already reported back but was waiting for the parent's text to close is closed with its own result — it already finished.
    const out: NormalizedEvent[] = this.deferred.splice(0)
    for (const callId of this.background) out.push({ type: 'tool_result', sessionId: this.sessionId, callId, ok: false, summary: why })
    this.background.clear()
    // The reason above names an agent's card; a background shell went the same way, so its ending says what happened
    out.push(...this.tasks.release('Ended with the session process'))
    return out
  }
}
