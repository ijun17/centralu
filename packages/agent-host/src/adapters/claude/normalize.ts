import type { ApprovalDetail, BackgroundTask, NormalizedEvent, SessionActivity, SessionGoal, ToolSummary } from '@cc/protocol'
import { UnmappedTypes } from '../unmapped.js'

/** The settings a Claude process was launched with — the snapshot a `settings_changed` the tool made carries (#304). */
export type ClaudeLaunchedSettings = { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null }

/**
 * Converts Claude SDK messages into NormalizedEvent (a pure function, so contract tests are
 * possible). SDK types end here — only protocol types ever leave.
 */

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task'])
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

type Json = Record<string, unknown>
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

export function toolSummary(name: string, input: Json): ToolSummary {
  const paths: string[] = []
  let title = name
  if (name === 'Bash') title = str(input.command, name)
  else if (FILE_EDIT_TOOLS.has(name) || name === 'Read') {
    const p = str(input.file_path ?? input.notebook_path)
    if (p) paths.push(p)
    title = `${name}: ${p || '?'}`
  } else if (name === 'Grep' || name === 'Glob') title = `${name}: ${str(input.pattern)}`
  // A proposal card (#63) uses the reason as its title — the only argument the UI shows the person as-is.
  else if (name.endsWith('propose_project')) title = str(input.reason, name)
  // The only channel through which a proposal card can pre-fill a branch name (#69) — carried in the title.
  else if (name.endsWith('propose_worktree_session')) title = str(input.branch, name)
  /*
   * An agent card's title is the work handed to it (#98). While it was just the name, every card
   * said "Agent Agent", and launching three agents side by side left no way to tell which card was
   * which (a dogfooding session: all three showed the same line).
   */
  else if (name === 'Agent' || name === 'Task') title = str(input.description, name)
  return { tool: name, title, readOnly: READ_ONLY.has(name), paths }
}

/**
 * The paths reported through `files_touched` — only from tools that **changed** a file (#185).
 *
 * `toolSummary`'s `paths` also include Read's own path (a handoff record uses it as "what was
 * looked at"). Emitting that as-is would tag a file the agent only read with "Edited by agent" in
 * the tree.
 */
function editedPaths(s: ToolSummary): string[] {
  return FILE_EDIT_TOOLS.has(s.tool) ? s.paths : []
}

/**
 * One line of a subagent's step — appended to that agent card's live output (#98).
 *
 * Uses the same title rule as the parent's own card (`toolSummary`), but with the tool name
 * prepended: Bash's title is the full command text, so without the name what remains is what was
 * typed, not what it actually did. A multi-line command (a heredoc) only keeps its first line —
 * the card's tail is three lines, so a single command would otherwise take up the whole thing.
 */
function stepLine(s: ToolSummary): string {
  const lines = s.title.split('\n')
  const first = lines[0] ?? ''
  const head = first.slice(0, 200) + (lines.length > 1 || first.length > 200 ? ' …' : '')
  return head === s.tool || head.startsWith(`${s.tool}:`) ? head : `${s.tool}: ${head}`
}

/** "34 tool uses · 2m 13s" — the opening of an agent card's result (#98). */
function agentStats(toolUses: unknown, durationMs: unknown, status?: string): string {
  const parts: string[] = []
  if (status && status !== 'completed') parts.push(status)
  if (typeof toolUses === 'number') parts.push(`${toolUses} tool use${toolUses === 1 ? '' : 's'}`)
  if (typeof durationMs === 'number') {
    const s = Math.round(durationMs / 1000)
    parts.push(s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`)
  }
  return parts.join(' · ')
}

/**
 * An agent card's result body — the step count plus the opening of the report.
 *
 * A card's result is cut at 300 characters for every tool (see `tool_result` below). An agent's
 * report routinely runs to tens of thousands of characters (dogfooding: 15-24KB), so only the
 * opening lands on the card, while the parent receives the full text and writes it in its own
 * words — if the card rendered the full text too, that is exactly what "the answer appears
 * twice" means.
 *
 * This returns the report uncut: its first 300 characters are the card's `summary`, and the whole of it is the
 * result's `output`, the record (#221).
 */
function agentReport(report: string, stats: string): string {
  return stats ? `${stats}\n\n${report}` : report
}

/**
 * The whole text of a `tool_result` block — its `output` (#221): the string itself, or the blocks' text joined.
 *
 * Images are left out: they are saved as attachments (#40), and base64 would make the row as large as the picture.
 * So is any other block that carries base64 (a document, say). Other blocks are kept as their JSON, which is how the
 * card's summary has always shown them. Measured on this machine's transcripts (2026-09-30), a result is a string
 * (25,150), text blocks (3,167), an image (493), image and text (26) or a `tool_reference` from ToolSearch (235);
 * joining only the text would leave a ToolSearch result empty.
 */
function resultOutput(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  return (content as Json[])
    .filter((b) => str(b?.type) !== 'image' && str((b?.source as Json | undefined)?.type) !== 'base64')
    .map((b) => (str(b?.type) === 'text' ? str(b.text) : JSON.stringify(b)))
    .join('\n')
}

/**
 * Is this user message **the result of launching a background agent** (#98)?
 *
 * Measured (probe-subagent-stream.mts): the Agent call's `tool_result` arrives the instant it is
 * launched, and its body is text meant for the model — "Async agent launched successfully. (This
 * tool result is internal metadata — never quote or paste any part of it … into a user-facing
 * reply.)". The agent's actual completion is the `system/task_notification` that arrives much
 * later. The judgment is made from the shape of `tool_use_result` (sdk-tools.d.ts `AgentOutput`):
 * only an agent has `status === 'async_launched'` together with an `agentId` (a workflow instead
 * carries a `taskId`). This only applies when there is exactly one result block — a message has
 * only one `tool_use_result`, so with more than one block there is no way to tell which block it
 * belongs to.
 */
function backgroundLaunch(m: Json): string | null {
  const r = (m.tool_use_result ?? {}) as Json
  if (str(r.status) !== 'async_launched' || !str(r.agentId)) return null
  const blocks = (((m.message as Json | undefined)?.content ?? []) as Json[]).filter((b) => str(b.type) === 'tool_result')
  return blocks.length === 1 ? str(blocks[0]?.tool_use_id) || null : null
}

/** Normalizes an approval request into one of 3 kinds the banner can judge (core/approval decides based on `kind` alone). */
export function approvalDetail(name: string, input: Json, cwd: string): ApprovalDetail {
  if (name === 'Bash') return { kind: 'command', command: str(input.command), cwd }
  if (FILE_EDIT_TOOLS.has(name)) {
    const path = str(input.file_path ?? input.notebook_path, '?')
    const preview =
      str(input.new_string) || str(input.content) || str(input.new_source) || JSON.stringify(input).slice(0, 400)
    return { kind: 'file_edit', path, diffPreview: preview.slice(0, 400), multi: false }
  }
  return { kind: 'other', raw: `${name} ${JSON.stringify(input).slice(0, 300)}` }
}

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
   * (FR-2, FR-5).
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
    for (const e of normalizeMessage({ ...m, parent_tool_use_id: null }, sessionId)) {
      if (e.type === 'message_delta' || (e.type === 'reasoning_delta' && e.text)) {
        out.push({ type: 'subagent_event', sessionId, parentCallId: parent, step: e })
      } else if (e.type === 'tool_call') {
        out.push({ type: 'tool_output_delta', sessionId, callId: parent, text: `${stepLine(e.summary)}\n` })
        out.push({ type: 'subagent_event', sessionId, parentCallId: parent, step: e })
      } else if (e.type === 'tool_result') {
        out.push({ type: 'subagent_event', sessionId, parentCallId: parent, step: e })
      } else if (e.type === 'files_touched') {
        out.push(e)
      }
    }
    return out
  }

  /*
   * What is currently happening.
   *
   * A probe confirmed the actual ordering:
   *   status:'compacting' → (39 seconds) → status:null + compact_result:'success' → compact_boundary
   * For those 39 seconds, the UI looked no different from ordinary "waiting for response" — a
   * problem that surfaced from dogfooding.
   */
  /*
   * `/clear` (#304). Measured (CLI 2.1.289 through SDK 0.3.263, haiku, 2026-10-04): `/clear` passes straight through
   * to the CLI, which sends `conversation_reset {new_conversation_id, trigger: 'clear', user_message_uuid}`, then an
   * `init` carrying a **new `session_id`** (19eced5a… → b7843a7a…) and a result with `num_turns: 0`. The adapter
   * already follows the new id; what was missing is any sign on screen that the model now knows nothing above this
   * point. The context gauge read 15,967 before and 14,093 after (the system prompt alone).
   */
  if (type === 'conversation_reset') {
    const trigger = str(m.trigger)
    out.push({ type: 'conversation_reset', sessionId, ...(trigger ? { trigger } : {}) })
    return out
  }

  /*
   * Text the CLI shows its own user (#304). `system/informational` carries hook feedback: measured (CLI 2.1.289), a
   * `UserPromptSubmit` hook that exits 2 sends `{content: "UserPromptSubmit operation blocked by hook:\n[<command>]:
   * <its stderr>\n\nOriginal prompt: …", level: 'warning', prevent_continuation: true}`, then a result with
   * `num_turns: 0`. Nothing reached the screen before: the prompt simply went unanswered. The SDK says level `info`
   * "shows only in transcript mode", so the CLI itself hides it, and so does this.
   */
  if (type === 'system' && str(m.subtype) === 'informational') {
    const text = str(m.content).trim()
    const level = str(m.level)
    if (text && level !== 'info') out.push({ type: 'notice', sessionId, level: level === 'warning' ? 'warning' : 'info', text })
    return out
  }

  /*
   * The CLI's notification queue (#304, not exercised: it carries things like fast-mode credits running out or a model
   * the organization denies). Its colour and priority fold into the notice's level. "Error compacting conversation" is
   * left out: the failed-compaction marker (`status` below) already says so, with the reason.
   */
  if (type === 'system' && str(m.subtype) === 'notification') {
    const text = str(m.text).trim()
    if (!text || str(m.key) === 'error-compacting-conversation') return out
    const color = str(m.color)
    const priority = str(m.priority)
    const level = color === 'error' ? 'error' : color === 'warning' || priority === 'high' || priority === 'immediate' ? 'warning' : 'info'
    out.push({ type: 'notice', sessionId, level, text })
    return out
  }

  /*
   * The CLI is retrying a failed API call (#304), the twin of Codex's `error {willRetry}`. Measured (CLI 2.1.289, an
   * `ANTHROPIC_BASE_URL` answering 529, `CLAUDE_CODE_MAX_RETRIES=2`): `{attempt: 1, max_retries: 2, retry_delay_ms: 556,
   * error_status: 529, error: 'overloaded'}`, the same for attempt 2, then a synthetic assistant message "API Error: 529
   * Overloaded…" and an error result. Nothing came between the attempts, so the screen read "waiting for a reply" for
   * the whole time. It shows as the `retrying` activity (`ClaudeStreamNormalizer` puts back what was showing once output
   * flows again) and goes to host.log with the reason.
   */
  if (type === 'system' && str(m.subtype) === 'api_retry') {
    const status = typeof m.error_status === 'number' ? `${m.error_status} ` : ''
    const delay = typeof m.retry_delay_ms === 'number' ? ` in ${m.retry_delay_ms}ms` : ''
    console.error(
      `[claude] ${sessionId.slice(0, 8)} retrying after: ${status}${str(m.error, 'connection error')} (attempt ${String(m.attempt ?? '?')}/${String(m.max_retries ?? '?')}${delay})`,
    )
    out.push({ type: 'activity', sessionId, activity: 'retrying' })
    return out
  }

  if (type === 'system' && str(m.subtype) === 'status') {
    out.push({ type: 'activity', sessionId, activity: m.status === 'compacting' ? 'compacting' : null })
    /*
     * A failure is never swallowed. If compaction fails, the context stays exactly as it was, but
     * the UI would otherwise look as if nothing had happened — a case that measured, actually
     * occurred ("Not enough messages to compact.").
     */
    if (str(m.compact_result) === 'failed') {
      out.push({ type: 'compaction', sessionId, failed: true, reason: str(m.compact_error, 'Unknown reason') })
    }
    return out
  }

  /*
   * A goal-status notification (2026-09-07 — /goal's Stop hook, SDKActiveGoalMessage). The same
   * category as #58: while this type was not handled, goal state was silently dropped. A `value`
   * of null means the goal was cleared (including having been achieved), and while one is set,
   * Claude's status vocabulary has exactly one word, 'active' — the iteration count and the reason
   * it has not been reached are the actual content.
   *
   * **The installed CLI does not send this to us** (measured 2026-10-03, CLI 2.1.282 through SDK
   * 0.3.263, whose runtime does pass the type through): the CLI's headless loop folds the event into
   * its own state, and writes it to stdout only in a remote (`CLAUDE_CODE_REMOTE`) session. So the
   * badge is driven by `ClaudeGoalTracker` below; this stays for a CLI that starts sending it, and
   * when one does, the tracker stands down.
   */
  if (type === 'active_goal') {
    const v = (m.value ?? null) as Json | null
    out.push({
      type: 'goal',
      sessionId,
      goal: v
        ? {
            objective: str(v.condition),
            status: 'active',
            ...(typeof v.iterations === 'number' ? { iterations: v.iterations } : {}),
            ...(str(v.last_reason) ? { reason: str(v.last_reason) } : {}),
          }
        : null,
    })
    return out
  }

  /*
   * The output of a local command (SDKLocalCommandOutputMessage — the **generalized channel** for
   * things like /usage).
   *
   * This is the sibling of the dogfooding incident where /usage's answer arrived as a delta-less
   * assistant message and never showed up: the output of a command the CLI handles locally can
   * also arrive as this system message, and dropping it means the command ran but only the answer
   * disappeared. To the person, this occupies the same place as something the assistant said.
   */
  if (type === 'system' && str(m.subtype) === 'local_command_output') {
    const content = str(m.content)
    if (content) out.push({ type: 'message_delta', sessionId, role: 'assistant', text: content })
    return out
  }

  /*
   * The point where compaction finished (FR-14).
   *
   * Without this, **a compaction marker never once appeared in a Claude session** — only Codex
   * had one. Without a marker, there is no way to know where the fold is, so "scroll back past
   * this point" cannot work either.
   */
  if (type === 'system' && str(m.subtype) === 'compact_boundary') {
    const meta = (m.compact_metadata ?? {}) as Json
    out.push({
      type: 'compaction',
      sessionId,
      failed: false,
      before: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : undefined,
      after: typeof meta.post_tokens === 'number' ? meta.post_tokens : undefined,
    })
    return out
  }

  // Streaming deltas (needs includePartialMessages: true — confirmed in M0).
  if (type === 'stream_event') {
    const e = m.event as Json | undefined
    if (str(e?.type) === 'content_block_delta') {
      const d = e?.delta as Json | undefined
      if (str(d?.type) === 'text_delta') {
        out.push({ type: 'message_delta', sessionId, role: 'assistant', text: str(d?.text) })
      }
      /*
       * Thinking (measured in #58, 2026-08-26): the whole body arrives encrypted, so `thinking`
       * is always "" and only `estimated_tokens` (an increment) comes through. So this can only
       * emit **the fact of progress** — "thinking, ~N tokens" — rather than the text; it never
       * pretends content exists that is not there. If the CLI ever starts sending readable text
       * here, the `text` field just flows through as-is.
       */
      if (str(d?.type) === 'thinking_delta') {
        const text = str(d?.thinking)
        const estTokens = typeof d?.estimated_tokens === 'number' ? d.estimated_tokens : undefined
        if (text || estTokens) {
          out.push({ type: 'reasoning_delta', sessionId, ...(text ? { text } : {}), ...(estTokens ? { estTokens } : {}) })
        }
      }
    }
    return out
  }

  if (type === 'assistant') {
    const content = ((m.message as Json | undefined)?.content ?? []) as Json[]
    // The only way out for a body that arrives with no deltas at all (see the opts.textStreamed comment above — /usage arrives this way).
    // Thinking follows the same rule as text, but on its own flag: a message can stream its thinking and
    // then call a tool without any text, and then only the thinking has already gone out.
    if (!opts?.reasoningStreamed) {
      const thinking = content
        .filter((b) => str(b.type) === 'thinking')
        .map((b) => str(b.thinking))
        .join('')
      if (thinking) out.push({ type: 'reasoning_delta', sessionId, text: thinking })
    }
    if (!opts?.textStreamed) {
      const text = content
        .filter((b) => str(b.type) === 'text')
        .map((b) => str(b.text))
        .join('')
      if (text) out.push({ type: 'message_delta', sessionId, role: 'assistant', text })
    }
    for (const block of content) {
      if (str(block.type) === 'tool_use') {
        const name = str(block.name)
        const input = (block.input ?? {}) as Json
        // `input` is the record (#221): a Write's content and an Edit's both sides, which the title reduces to a path
        out.push({
          type: 'tool_call',
          sessionId,
          callId: str(block.id),
          summary: toolSummary(name, input),
          ...(block.input !== undefined ? { input: block.input } : {}),
        })
        const paths = editedPaths(toolSummary(name, input))
        if (paths.length) out.push({ type: 'files_touched', sessionId, paths })
      }
    }
    // Usage also comes carried on an assistant message.
    const usage = (m.message as Json | undefined)?.usage as Json | undefined
    if (usage) {
      out.push({
        type: 'usage_update',
        sessionId,
        tokens: {
          inputTokens: Number(usage.input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
          cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
          cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0),
        },
      })
    }
    return out
  }

  if (type === 'user') {
    const content = ((m.message as Json | undefined)?.content ?? []) as Json[]
    /*
     * The result of launching a background agent is **not actually a result** (#98). Closing the
     * card here would show the text meant only for the model ("never quote…") as its result, and
     * make the card look already finished while the agent is still genuinely working. This leaves
     * the card open with only a one-line status, and `task_notification` closes it when the agent
     * actually finishes (`ClaudeStreamNormalizer`).
     */
    const launched = backgroundLaunch(m)
    if (launched) return [{ type: 'tool_output_delta', sessionId, callId: launched, text: 'Running in the background\n' }]
    /*
     * A foreground agent's result is drawn from `tool_use_result` — the SDK says to do exactly
     * that (sdk.d.ts: "For the Agent/Task tool the completed shape is the subagent's final report
     * without the model-directed agentId/usage trailer, plus run totals — render from it
     * instead of parsing the tool_result text."). Using the body as-is would put JSON starting
     * with "[Subagent hand-back] The text below is…" on the card (measured).
     */
    const agent = (m.tool_use_result ?? {}) as Json
    // The finished agent's whole report is the result's record (#221); the card shows its head
    const agentDone =
      str(agent.status) === 'completed' && str(agent.agentId) && Array.isArray(agent.content) &&
      content.filter((b) => str(b.type) === 'tool_result').length === 1
        ? agentReport(
            (agent.content as Json[]).map((b) => str(b.text)).join('\n'),
            agentStats(agent.totalToolUseCount, agent.totalDurationMs),
          )
        : null
    for (const block of content) {
      if (str(block.type) === 'tool_result') {
        const c = block.content
        const output = agentDone ?? resultOutput(c)
        out.push({
          type: 'tool_result',
          sessionId,
          callId: str(block.tool_use_id),
          ok: block.is_error !== true,
          summary: agentDone?.slice(0, 300) ?? (typeof c === 'string' ? c : JSON.stringify(c ?? '')).slice(0, 300),
          ...(output ? { output } : {}),
        })
        /*
         * An image carried in a tool result (#40). This is where one arrives when a screenshot is
         * taken or an image file is Read — the measured shape:
         * {type:'image', source:{type:'base64', data, media_type}}. (An assistant body never
         * carries an image — a tool result is the only way one arrives.)
         */
        if (Array.isArray(c)) {
          for (const part of c as Json[]) {
            if (str(part.type) !== 'image') continue
            const source = (part.source ?? {}) as Json
            /*
             * A non-base64 source (a URL, say) used to vanish silently (found during the #58
             * investigation). There is nothing we can do about failing to render it, but the fact
             * that it failed to render still has to be shown — this uses the same box as the
             * existing image-failure cases (too large, file missing).
             */
            if (str(source.type) !== 'base64' || !str(source.data)) {
              out.push({
                type: 'message_image', sessionId, mime: '', data: '',
                note: `Cannot display an image of this format yet (source: ${str(source.type) || 'none'})`,
              })
              continue
            }
            const data = str(source.data)
            const mime = str(source.media_type) || 'image/png'
            // ~11M base64 characters is roughly an 8MB original. Beyond that, this explains why it is not shown instead of rendering it.
            if (data.length > 11_000_000) {
              out.push({
                type: 'message_image', sessionId, mime, data: '',
                note: `Image is too large (~${Math.round((data.length * 3) / 4 / 1048576)}MB)`,
              })
            } else {
              out.push({ type: 'message_image', sessionId, mime, data })
            }
          }
        }
      }
    }
    return out
  }

  /*
   * A limit (M0 finding: `rate_limit_event.rate_limit_info`).
   *
   * **Only an actual block counts as a limit.** There are three statuses (SDK:
   * 'allowed' | 'allowed_warning' | 'rejected'). While this checked `!== 'allowed'`,
   * `allowed_warning` — "getting close, but still going through" — was treated the same as
   * `rejected`, and a limit banner appeared on a session that was never actually blocked
   * (dogfooding: "it showed up in the tab even though the limit had not been reached").
   *
   * The Codex adapter fixed the same mistake first and cited this file as its own reference, but
   * the reference itself was wrong. Codex has it right now — this only reacts to the explicit
   * signal the tool actually gives. The warning is not discarded: the usage window
   * (agents.usage) still shows remaining headroom as a percentage. The banner says "cannot be
   * used right now", and showing it while it can still be used would make that a lie.
   */
  if (type === 'rate_limit_event') {
    const info = (m.rate_limit_info ?? {}) as Json
    if (str(info.status) === 'rejected') {
      const resetsAt = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : undefined
      out.push({
        type: 'limit_reached',
        sessionId,
        resumeAt: resetsAt,
        windowMins: str(info.rateLimitType) === 'five_hour' ? 300 : undefined,
      })
    }
    return out
  }

  if (type === 'result') {
    const modelUsage = (m.modelUsage ?? {}) as Record<string, Json>
    const models = Object.values(modelUsage)
    if (models.length > 0) {
      /*
       * Context usage is never computed here.
       *
       * `modelUsage` is a **session-wide accumulation**. Re-reading the cache
       * (`cacheReadInputTokens`) adds to it every single turn, so summing it here quickly exceeds
       * the window size — this actually showed up as "context 533%". What is currently in the
       * window is instead known by the SDK's own `getContextUsage()`, which the adapter asks at
       * the end of a turn to emit `context_update`.
       */
      /*
       * **Every model is summed.** `modelUsage` has one entry per model (sdk.d.ts: meant to
       * count tokens and cost across everything, including internal calls like the main loop, a
       * subagent, or compaction), and a single turn can involve more than one model — a small
       * model used to title something or shorten a tool result can appear before the main model
       * does. While only the first entry was read, an app-requested agent's own run was recorded
       * as "1.1k tokens": the log lines were 1108/13 and 1038/16, while the model actually seen in
       * the CLI log (Opus) used only 200/363 output tokens against 24k-80k cache input tokens.
       * What got recorded was the small model's share.
       */
      const sum = (field: string) => models.reduce((n, u) => n + Number(u[field] ?? 0), 0)
      out.push({
        type: 'usage_update',
        sessionId,
        tokens: {
          inputTokens: sum('inputTokens'),
          outputTokens: sum('outputTokens'),
          cacheReadTokens: sum('cacheReadInputTokens'),
          cacheCreationTokens: sum('cacheCreationInputTokens'),
          costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined,
        },
      })
    }
    if (str(m.subtype) !== 'success' || m.is_error === true) {
      /*
       * A failed ending has no `result`, only `errors` (a list of strings) (sdk.d.ts
       * `SDKResultError`). If both are empty, this still carries at least the name of how it
       * ended — when an app-requested agent (M4 D-1) never manages to match its structured output
       * (`error_max_structured_output_retries`), that name is the only reason the app ever
       * receives.
       */
      const errors = Array.isArray(m.errors) ? m.errors.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
      out.push({
        type: 'error',
        sessionId,
        error: { code: 'internal', message: str(m.result) || errors.join('\n') || `Turn failed: ${str(m.subtype)}`, retryable: true },
      })
    } else {
      // The answer of a turn that answered with a schema (M4 D-1) — it never arrives as text, only here (see protocol's turn_complete comment).
      out.push(m.structured_output === undefined ? { type: 'turn_complete', sessionId } : { type: 'turn_complete', sessionId, output: m.structured_output })
    }
    return out
  }

  return out
}

/** The text of a message's content, a string or its text blocks joined. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Json[]).filter((b) => str(b?.type) === 'text').map((b) => str(b.text)).join('')
}

/**
 * What a Claude session's `/goal` is doing, read from what the CLI actually puts on the stream
 * (2026-10-03) — so a Claude goal draws the same badge a Codex goal does.
 *
 * The CLI's own goal event (`active_goal`) does not reach a headless session (see `normalizeMessage`),
 * and the SDK has no goal API. What does arrive, measured through `query()` with streaming input and
 * the installed CLI 2.1.282 (SDK 0.3.263, haiku, a temp git folder):
 *
 *   /goal <condition>    an assistant message with no stream deltas (model "<synthetic>"), text
 *                        "Goal set: <condition>"; then the model works in the same turn
 *   /goal                "Goal active: <condition> (not yet evaluated | N turn[s])" plus an optional
 *                        "\nLast check: <reason>" line, or "No goal set. Usage: `/goal <condition>`";
 *                        a result with num_turns 0 follows
 *   /goal clear          "Goal cleared: <condition>" or "No goal set" (stop, off, reset, none and cancel
 *                        are the same command)
 *   not met at Stop      a user message with isSynthetic: true, text
 *                        "Stop hook feedback:\n[<condition>]: <reason>"; the CLI keeps the same turn
 *                        going by itself, and there is still exactly one result at the end
 *   met                  **nothing** — no message between the model's last words and the turn's
 *                        result (includeHookEvents adds nothing either: the goal hook is a prompt hook)
 *   interrupted          the result is subtype success too, and the goal stays set ("Goal active" after)
 *   resumed              the CLI restores the goal from its transcript and says nothing on the stream
 *
 * Those replies are the CLI's words, not a typed field — so a reply is only read as one while a
 * `/goal` we passed through is waiting for its answer (`commandSent`), and Stop hook feedback only
 * while its bracket holds the condition we know is set (a person's own prompt Stop hook has the same
 * shape). "Met" is inferred: the goal's Stop hook blocks every stop until the condition holds, so a
 * turn in which the model ran under the goal and that ends in success, without us interrupting it,
 * ended because the hook let it. That is the CLI's met, its "impossible" (it gives up and clears)
 * and its unrecoverable-error clear alike — all three clear the goal. Two endings it cannot tell
 * apart, read in the CLI rather than measured: a check deferred while background work is still
 * running, and an evaluator timeout. There the badge clears early; `/goal` shows the truth again.
 */
export class ClaudeGoalTracker {
  private goal: SessionGoal | null = null
  /** `/goal` commands passed to the CLI whose reply has not arrived yet. */
  private replies = 0
  /** A model call ran while a goal was set, since the last result — this turn's end went past the goal's Stop hook. */
  private drove = false
  /** The CLI announced the goal itself (`active_goal`) — its word replaces our reading for the rest of the session. */
  private announced = false

  constructor(private readonly sessionId: string) {}

  /** The adapter passed a `/goal` command through to the CLI. */
  commandSent(): void {
    this.replies++
  }

  /**
   * The goal the host last knew of, handed to a process that resumes the conversation. The CLI restores
   * the goal from its transcript without a word on the stream (measured), so without this the new process
   * would not know the goal it is running, and a met goal would leave the badge up.
   */
  seed(goal: SessionGoal | null | undefined): void {
    if (goal && goal.status === 'active') this.goal = goal
  }

  /** Reads one parent-stream message. `streamed`: this assistant message's body came as deltas, i.e. a model call. */
  push(m: Json, opts: { streamed: boolean; interrupted: boolean }): NormalizedEvent[] {
    const type = str(m.type)
    if (type === 'active_goal') {
      this.announced = true
      return []
    }
    if (this.announced) return []

    if (type === 'stream_event' && str((m.event as Json | undefined)?.type) === 'message_start') {
      if (this.goal) this.drove = true
      return []
    }

    if (type === 'assistant' && this.replies > 0 && !opts.streamed) {
      const reply = this.readReply(textOfContent((m.message as Json | undefined)?.content))
      if (reply === undefined) return []
      this.replies--
      if (reply === 'other') return []
      return this.set(reply)
    }

    if (type === 'user' && m.isSynthetic === true && this.goal) {
      const prefix = `Stop hook feedback:\n[${this.goal.objective}]: `
      const text = textOfContent((m.message as Json | undefined)?.content)
      if (!text.startsWith(prefix)) return []
      const reason = text.slice(prefix.length).trim()
      return this.set({ ...this.goal, iterations: (this.goal.iterations ?? 0) + 1, ...(reason ? { reason } : {}) })
    }

    if (type === 'result') {
      const drove = this.drove
      this.drove = false
      const success = str(m.subtype) === 'success' && m.is_error !== true
      if (this.goal && drove && success && !opts.interrupted) return this.set(null)
    }
    return []
  }

  /**
   * One synthetic reply to a `/goal` command — the goal it states (null for none), `'other'` for the
   * command's own refusals (an untrusted folder, hooks disabled, a condition too long), and undefined
   * for a message that is not the reply.
   */
  private readReply(text: string): SessionGoal | null | 'other' | undefined {
    const set = /^Goal set: ([\s\S]+)$/.exec(text)
    if (set) return { objective: set[1]!.trim(), status: 'active' }
    const active = /^Goal active: ([\s\S]+?) \((not yet evaluated|(\d+) turns?)\)(?:\nLast check: ([\s\S]*))?$/.exec(text)
    if (active) {
      const reason = active[4]?.trim()
      return {
        objective: active[1]!.trim(),
        status: 'active',
        ...(active[3] ? { iterations: Number(active[3]) } : {}),
        ...(reason ? { reason } : {}),
      }
    }
    if (/^Goal cleared: /.test(text) || /^No goal set/.test(text)) return null
    if (/^\/goal /.test(text) || /^Goal condition is limited to /.test(text)) return 'other'
    return undefined
  }

  private set(goal: SessionGoal | null): NormalizedEvent[] {
    if (goal === null && this.goal === null) return []
    this.goal = goal
    return [{ type: 'goal', sessionId: this.sessionId, goal }]
  }
}

type TaskInfo = { kind: BackgroundTask['kind']; description: string; parentCallId?: string; ambient?: boolean; nested?: boolean }

/** A Claude task type to the kind the screen shows (#290). Read loosely: the SDK documents the field as open. */
function taskKind(type: string): BackgroundTask['kind'] {
  if (/agent|teammate/.test(type)) return 'agent'
  if (/bash|shell/.test(type)) return 'shell'
  if (/mcp|monitor/.test(type)) return 'mcp'
  return 'other'
}

/**
 * The session's background work, read off the parent stream (#290).
 *
 * `system/background_tasks_changed` is the level: every live task after a change (`task_id`, `task_type`,
 * `description`, `ambient`), with REPLACE semantics (sdk.d.ts). It carries no tool_use_id, so the launching call
 * comes from `task_started`, which arrived just after the level for the same task every time it was measured
 * (probe-background-tasks.mts). `task_notification` is how a task ended: `completed`, `failed` or `stopped`.
 *
 * What interrupting the turn does was measured, and is what `stopsWithTurn` says: a background subagent stops with
 * the turn (`task_notification` stopped, in the same millisecond), a backgrounded shell keeps running. A task a
 * subagent started, and any other kind, was not measured, so it carries nothing. Every task can be stopped on its own
 * (`Query.stopTask`, measured on a shell: the same three messages as an interrupt's).
 *
 * The level is per process and nothing is sent at startup (sdk.d.ts), so a new tracker starts empty. When the
 * process goes away its tasks go with it, silently (measured: `close()` killed a running shell and nothing was
 * emitted) — `release` says so.
 */
export class ClaudeBackgroundTracker {
  /** Ids in the last level, in its order. */
  private live: string[] = []
  /** Every id the level ever listed — only those are background work (a foreground task's ending is its card's). */
  private readonly seen = new Set<string>()
  private readonly info = new Map<string, TaskInfo>()

  constructor(private readonly sessionId: string) {}

  push(m: Json): NormalizedEvent[] {
    if (str(m.type) !== 'system') return []
    const subtype = str(m.subtype)
    if (subtype === 'background_tasks_changed') {
      const tasks = (Array.isArray(m.tasks) ? m.tasks : []) as Json[]
      this.live = []
      for (const t of tasks) {
        const id = str(t.task_id)
        if (!id) continue
        const prev = this.info.get(id)
        this.info.set(id, {
          ...prev,
          kind: taskKind(str(t.task_type)),
          description: str(t.description, prev?.description ?? ''),
          ...(t.ambient === true ? { ambient: true } : { ambient: undefined }),
        })
        this.live.push(id)
        this.seen.add(id)
      }
      return [this.event()]
    }
    if (subtype === 'task_started' || subtype === 'task_updated') {
      const id = str(m.task_id)
      const prev = this.info.get(id)
      if (!id) return []
      if (subtype === 'task_started') {
        const callId = str(m.tool_use_id)
        const depth = typeof m.spawn_depth === 'number' ? m.spawn_depth : 1
        this.info.set(id, {
          ...prev,
          kind: str(m.task_type) ? taskKind(str(m.task_type)) : (prev?.kind ?? 'other'),
          description: prev?.description || str(m.description),
          ...(callId ? { parentCallId: callId } : {}),
          ...(m.owned_by_subagent === true || depth > 1 ? { nested: true } : {}),
          ...(m.ambient === true ? { ambient: true } : {}),
        })
      } else {
        const description = str((m.patch as Json | undefined)?.description)
        if (!prev || !description) return []
        this.info.set(id, { ...prev, description })
      }
      return this.live.includes(id) ? [this.event()] : []
    }
    if (subtype === 'task_notification') {
      const id = str(m.task_id)
      const known = this.info.get(id)
      if (!this.seen.has(id)) return []
      this.seen.delete(id)
      this.info.delete(id)
      this.live = this.live.filter((x) => x !== id)
      const raw = str(m.status)
      const status = raw === 'failed' || raw === 'stopped' ? raw : 'completed'
      const summary = str(m.summary).slice(0, 300)
      return [this.event([{ ...this.entry(id, known), status, ...(summary ? { summary } : {}) }])]
    }
    return []
  }

  /** The process went away and took its tasks with it — each live one ends as stopped, with the reason. */
  release(why: string): NormalizedEvent[] {
    if (this.live.length === 0) return []
    const ended = this.live.map((id) => ({ ...this.entry(id, this.info.get(id)), status: 'stopped' as const, summary: why }))
    this.live = []
    this.info.clear()
    this.seen.clear()
    return [this.event(ended)]
  }

  private entry(id: string, i: TaskInfo | undefined): BackgroundTask {
    const kind = i?.kind ?? 'other'
    const stopsWithTurn = i?.nested ? undefined : kind === 'agent' ? true : kind === 'shell' ? false : undefined
    return {
      id,
      kind,
      description: i?.description || id,
      ...(i?.parentCallId ? { parentCallId: i.parentCallId } : {}),
      ...(i?.ambient ? { ambient: true } : {}),
      ...(stopsWithTurn !== undefined ? { stopsWithTurn } : {}),
      stoppable: true,
      status: 'running',
    }
  }

  private event(ended?: BackgroundTask[]): NormalizedEvent {
    return {
      type: 'background_tasks',
      sessionId: this.sessionId,
      live: this.live.map((id) => this.entry(id, this.info.get(id))),
      ...(ended ? { ended } : {}),
    }
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
const CLAUDE_KNOWN_TYPES: ReadonlySet<string> = new Set([
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
  /** The session's /goal, read off the stream (see `ClaudeGoalTracker`). */
  readonly goal: ClaudeGoalTracker
  /** Message types this session received that nothing maps or ignores on purpose, said once each in host.log (#58) */
  private readonly unmapped: UnmappedTypes

  /** The session's background work (see `ClaudeBackgroundTracker`). */
  readonly tasks: ClaudeBackgroundTracker
  /**
   * The CLI is retrying a failed API call (`system/api_retry`, #304): the `retrying` activity is up, and
   * `activityBefore` is what was showing before it. The CLI sends no "recovered" message — the next stream event or
   * assistant message is the sign that output flows again, so that is where the previous activity is put back. The
   * same shape as the Codex adapter's.
   */
  private retrying = false
  private activityBefore: SessionActivity | null = null
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
    this.unmapped = new UnmappedTypes('claude', sessionId, CLAUDE_KNOWN_TYPES)
    this.tasks = new ClaudeBackgroundTracker(sessionId)
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
      { type: 'notice', sessionId: this.sessionId, level: 'warning', text },
      { type: 'settings_changed', sessionId: this.sessionId, ...this.settings(), model: to, by: 'tool' },
    ]
  }

  /** The adapter interrupted the turn (see `stopping` above). */
  stopped(): void {
    this.stopping = true
  }

  /** Raises `retrying` once per episode and puts the previous activity back when output flows again (see `retrying`). */
  private followRetry(type: string, events: NormalizedEvent[]): NormalizedEvent[] {
    const out: NormalizedEvent[] = []
    for (const e of events) {
      if (e.type === 'activity' && e.activity === 'retrying') {
        // Each attempt sends its own message; one indication is enough
        if (this.retrying) continue
        this.retrying = true
      } else if (e.type === 'activity') {
        // A status message says what is happening now by itself, which ends the retry indication too
        this.activityBefore = e.activity
        this.retrying = false
      }
      out.push(e)
    }
    if (this.retrying && (type === 'stream_event' || type === 'assistant')) {
      this.retrying = false
      out.unshift({ type: 'activity', sessionId: this.sessionId, activity: this.activityBefore })
    }
    // A finished turn takes its activity with it (the state machine clears it on leaving working)
    if (type === 'result') {
      this.retrying = false
      this.activityBefore = null
    }
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
      const done: NormalizedEvent = {
        type: 'tool_result',
        sessionId: this.sessionId,
        callId,
        ok: status === 'completed',
        summary: output.slice(0, 300),
        ...(output ? { output } : {}),
      }
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
    if (subagent) return events
    events = this.followRetry(type, events)
    if (type === 'result' && this.refusal !== null) {
      const refusal = this.refusal
      this.refusal = null
      const failed = events.some((e) => e.type === 'error')
      events = failed
        ? events.map((e) => (e.type === 'error' ? { ...e, error: { ...e.error, message: refusal } } : e))
        : [{ type: 'notice', sessionId: this.sessionId, level: 'warning', text: refusal }, ...events]
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
