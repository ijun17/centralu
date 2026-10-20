import type { SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk'
import type { NormalizedEvent } from '@cc/protocol'
import { asObj } from '../../json-value.js'
import { inlineImageEvent, undrawnImageEvent } from '../images.js'
import { todoWritePlan } from '../plan.js'
import { tokenCount } from '../token-usage.js'
import { toolResultEvent } from '../tool-result.js'
import { messageBlocks, str, type AssistantBody, type UsageRead, type UserRead } from './json.js'
import { agentReport, agentStats, resultOutput, toolSummary } from './tool-summary.js'

/**
 * What the model says (`normalizeMessage`): its streaming deltas, its whole assistant messages, and the user messages
 * that carry its tools' results.
 */

/** What `normalizeMessage` is told about the assistant message being read (see its `opts`) */
export type AssistantStreamed = { textStreamed?: boolean; reasoningStreamed?: boolean }

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
export function backgroundLaunch(m: UserRead): string | null {
  const r = asObj(m.tool_use_result)
  if (str(r.status) !== 'async_launched' || !str(r.agentId)) return null
  const blocks = messageBlocks(m.message).filter((b) => b.type === 'tool_result')
  return blocks.length === 1 ? str(blocks[0]?.tool_use_id) || null : null
}

// Streaming deltas (needs includePartialMessages: true — confirmed in M0).
export function streamEventEvents(m: Pick<SDKPartialAssistantMessage, 'event'>, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  // Read as carefully as before the SDK's types (#1339): a message without its event, or a delta without its text, reads as none
  const e = m.event
  if (e?.type === 'content_block_delta') {
    const d = e.delta
    if (d?.type === 'text_delta') {
      out.push({ type: 'message_delta', sessionId, role: 'assistant', text: str(d.text) })
    }
    /*
     * Thinking (measured in #58, 2026-08-26): the whole body arrives encrypted, so `thinking`
     * is always "" and only `estimated_tokens` (an increment) comes through. So this can only
     * emit **the fact of progress** — "thinking, ~N tokens" — rather than the text; it never
     * pretends content exists that is not there. If the CLI ever starts sending readable text
     * here, the `text` field just flows through as-is.
     */
    if (d?.type === 'thinking_delta') {
      const text = str(d.thinking)
      // Not in the SDK's type: the CLI's own (measured, #58)
      const estTokens = 'estimated_tokens' in d && typeof d.estimated_tokens === 'number' ? d.estimated_tokens : undefined
      if (text || estTokens) {
        out.push({ type: 'reasoning_delta', sessionId, ...(text ? { text } : {}), ...(estTokens ? { estTokens } : {}) })
      }
    }
  }
  return out
}

export function assistantEvents(m: { readonly message?: AssistantBody }, sessionId: string, opts?: AssistantStreamed): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const content = messageBlocks(m.message)
  // The only way out for a body that arrives with no deltas at all (see the opts.textStreamed comment on normalizeMessage — /usage arrives this way).
  // Thinking follows the same rule as text, but on its own flag: a message can stream its thinking and
  // then call a tool without any text, and then only the thinking has already gone out.
  if (!opts?.reasoningStreamed) {
    const thinking = content
      .filter((b) => b.type === 'thinking')
      .map((b) => str(b.thinking))
      .join('')
    if (thinking) out.push({ type: 'reasoning_delta', sessionId, text: thinking })
  }
  if (!opts?.textStreamed) {
    const text = content
      .filter((b) => b.type === 'text')
      .map((b) => str(b.text))
      .join('')
    if (text) out.push({ type: 'message_delta', sessionId, role: 'assistant', text })
  }
  for (const block of content) {
    if (block.type === 'tool_use') {
      const name = str(block.name)
      const input = asObj(block.input)
      /*
       * `input` is the record (#221): a Write's content and an Edit's both sides, which the title reduces to a path.
       * The files it changes are marked when its result says it went through (`ClaudeStreamNormalizer`, #843).
       */
      out.push({
        type: 'tool_call',
        sessionId,
        callId: str(block.id),
        summary: toolSummary(name, input),
        ...(block.input !== undefined ? { input: block.input } : {}),
      })
      // The todo list is the session's plan too (#843); a subagent's is not, and its steps keep no plan
      out.push(...todoWritePlan(sessionId, name, block.input))
    }
  }
  // Usage also comes carried on an assistant message: this one request's, which `ClaudeStreamNormalizer` adds to the running reading
  const usage = m.message?.usage
  if (usage) {
    out.push({
      type: 'usage_update',
      sessionId,
      tokens: { ...requestInputTokens(usage), outputTokens: tokenCount(usage.output_tokens) },
    })
  }
  return out
}

/**
 * One request's input as an Anthropic `usage` block counts it (#850): uncached, read from the cache, and written to it.
 * Both the message's own reading (`assistantEvents`) and the cache accounting's request (`ClaudeStreamNormalizer`) read
 * it here.
 */
export function requestInputTokens(usage: UsageRead): { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } {
  return {
    inputTokens: tokenCount(usage.input_tokens),
    cacheReadTokens: tokenCount(usage.cache_read_input_tokens),
    cacheCreationTokens: tokenCount(usage.cache_creation_input_tokens),
  }
}

export function userEvents(m: UserRead, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  // Words only (the summary after /compact is a string) has no tool result in it and makes no event: the marker already told it
  const content = messageBlocks(m.message)
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
  const agent = asObj(m.tool_use_result)
  // The finished agent's whole report is the result's record (#221); the card shows its head
  const agentDone =
    str(agent.status) === 'completed' && str(agent.agentId) && Array.isArray(agent.content) &&
    content.filter((b) => b.type === 'tool_result').length === 1
      ? agentReport(
          agent.content.map((b: unknown) => str(asObj(b).text)).join('\n'),
          agentStats(agent.totalToolUseCount, agent.totalDurationMs),
        )
      : null
  for (const block of content) {
    if (block.type === 'tool_result') {
      const c = block.content
      /*
       * The card reads the answer as the record does (#843): a list of blocks used to be cut out of its JSON, so a
       * card, and every session reading it (read_session, recall, the handoff record), got `[{"type":"text",…` or
       * an image's base64 instead of the text.
       */
      out.push(toolResultEvent(sessionId, str(block.tool_use_id), block.is_error !== true, agentDone ?? resultOutput(c)))
      /*
       * An image carried in a tool result (#40). This is where one arrives when a screenshot is
       * taken or an image file is Read — the measured shape:
       * {type:'image', source:{type:'base64', data, media_type}}. (An assistant body never
       * carries an image — a tool result is the only way one arrives.)
       */
      if (Array.isArray(c)) {
        for (const item of c) {
          // Something in the list that is not a block reads as none, as in a message's own list (`messageBlocks`)
          const part = asObj(item)
          if (str(part.type) !== 'image') continue
          const source = asObj(part.source)
          /*
           * A non-base64 source (a URL, say) used to vanish silently (found during the #58
           * investigation). There is nothing we can do about failing to render it, but the fact
           * that it failed to render still has to be shown — this uses the same box as the
           * existing image-failure cases (too large, file missing).
           */
          if (str(source.type) !== 'base64' || !str(source.data)) {
            out.push(undrawnImageEvent(sessionId, `Cannot display an image of this format yet (source: ${str(source.type) || 'none'})`))
            continue
          }
          // Beyond the ceiling every image is held to (adapters/images.ts), this explains why it is not shown instead of rendering it
          out.push(inlineImageEvent(sessionId, str(source.media_type), str(source.data)))
        }
      }
    }
  }
  return out
}
