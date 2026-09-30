import type { ApprovalDetail, NormalizedEvent, ToolSummary } from '@cc/protocol'

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
   */
  const parent = str(m.parent_tool_use_id)
  if (parent && (type === 'assistant' || type === 'user' || type === 'stream_event')) {
    if (type !== 'assistant') return out
    for (const block of ((m.message as Json | undefined)?.content ?? []) as Json[]) {
      if (str(block.type) !== 'tool_use') continue
      const s = toolSummary(str(block.name), (block.input ?? {}) as Json)
      out.push({ type: 'tool_output_delta', sessionId, callId: parent, text: `${stepLine(s)}\n` })
      const edited = editedPaths(s)
      if (edited.length) out.push({ type: 'files_touched', sessionId, paths: edited })
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
                note: `이 형식의 이미지는 아직 표시하지 못합니다 (source: ${str(source.type) || '없음'})`,
              })
              continue
            }
            const data = str(source.data)
            const mime = str(source.media_type) || 'image/png'
            // ~11M base64 characters is roughly an 8MB original. Beyond that, this explains why it is not shown instead of rendering it.
            if (data.length > 11_000_000) {
              out.push({
                type: 'message_image', sessionId, mime, data: '',
                note: `이미지가 너무 큽니다 (~${Math.round((data.length * 3) / 4 / 1048576)}MB)`,
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

  constructor(private readonly sessionId: string) {}

  /** The adapter interrupted the turn (see `stopping` above). */
  stopped(): void {
    this.stopping = true
  }

  push(msg: unknown): NormalizedEvent[] {
    const m = msg as Json
    const type = str(m.type)
    const subagent = str(m.parent_tool_use_id) !== ''

    if (type === 'system' && str(m.subtype) === 'task_notification') {
      const callId = str(m.tool_use_id)
      if (!this.background.delete(callId)) return []
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
      if (!this.textStreamed && !this.reasoningStreamed) return [done]
      this.deferred.push(done)
      return []
    }

    if (type === 'user' && !subagent) {
      const launched = backgroundLaunch(m)
      if (launched) this.background.add(launched)
    }

    let events = normalizeMessage(msg, this.sessionId, {
      textStreamed: this.textStreamed,
      reasoningStreamed: this.reasoningStreamed,
    })
    if (subagent) return events
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
    return out
  }
}
