import type { NormalizedEvent, RequestInput, TokenUsage } from '@cc/protocol'
import { TouchedFiles } from '../file-changes.js'
import { addTokens, NO_TOKENS, tokenCount } from '../token-usage.js'
import { toolResultEvent } from '../tool-result.js'
import { firstLine } from '../tool-titles.js'
import type { AgyResult, AgyStep, AgyUsage } from './stream.js'
import { cardName, pathsOf, titleOf, toolKind } from './tool-kinds.js'

/**
 * `step_update` and `result` → NormalizedEvent (docs/plans/antigravity-adapter.md §4.1). One instance per process: `agy`
 * sends a step as several frames (an `ACTIVE` one, then its end), so what has been said of each is kept here.
 *
 * `agy` gives a tool step no call id. A step is named by its conversation and its index, and so is the gate's request
 * (`conversationId`, `stepIdx`): `${conversationId}:${stepIndex}`. The conversation is part of it since a sub-agent's
 * steps count from the same numbers as its parent's.
 */
export const callIdOf = (conversationId: string, stepIndex: number): string => `${conversationId}:${stepIndex}`

/**
 * A usage in our terms. Two readings of `agy`'s figures, each the one its `total_tokens` fits (every recording has `total = input +
 * output`; none has a cache read yet, so the first is not shown by a run): `input_tokens` counts the cached part, so the uncached
 * input is what is left of it; `output_tokens` already holds `thinking_tokens` (thinking never exceeds it), so it is not added again.
 */
export function tokensOf(u: AgyUsage | undefined): TokenUsage {
  const input = tokenCount(u?.input_tokens)
  const cached = Math.min(tokenCount(u?.cache_read_tokens), input)
  return { ...NO_TOKENS, inputTokens: input - cached, cacheReadTokens: cached, outputTokens: tokenCount(u?.output_tokens) }
}

const isZero = (t: TokenUsage): boolean => t.inputTokens + t.outputTokens + t.cacheReadTokens === 0
const same = (a: TokenUsage, b: TokenUsage): boolean => a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens && a.cacheReadTokens === b.cacheReadTokens

export class AgyNormalizer {
  /** Tool steps announced as `tool_call` and not yet ended */
  private readonly open = new Set<string>()
  /** Messages that have said any text, by id: a model call that only called tools ends with a bare newline, which is no message */
  private readonly spoke = new Set<string>()
  /** Paths an edit would change, reported once it ended ok (#843): a denied edit marks nothing */
  private readonly touched: TouchedFiles
  /** The conversation's token total as `agy` last said it (`result.usage` is cumulative, across processes) */
  private reading: TokenUsage
  /** The model calls of the running turn, which the reading does not hold yet */
  private turn = NO_TOKENS
  /** The reading last sent: a `result` that only confirms the sum of the calls sends nothing again */
  private sent: TokenUsage
  /** The conversation this process runs, learned at `init`; a frame names its own when it has one */
  conversationId = ''

  constructor(
    private readonly sessionId: string,
    private readonly label = 'Antigravity',
    /** The total a previous process of this conversation ended with: the new one's readings start from it, not from nothing */
    usageBefore: TokenUsage = NO_TOKENS,
  ) {
    this.touched = new TouchedFiles(sessionId)
    this.reading = usageBefore
    this.sent = usageBefore
  }

  step(s: AgyStep): NormalizedEvent[] {
    const conversation = s.conversation_id || this.conversationId
    switch (s.step_type) {
      case 'agent_response':
        return this.response(s, conversation)
      case 'tool':
        return this.tool(s, callIdOf(conversation, s.step_index))
      case 'subagent':
        return this.subagent(s, callIdOf(conversation, s.step_index))
      default:
        // `user_input` is our own input and `system_message` agy's notice (known-steps.ts); the wire logs the rest
        return []
    }
  }

  private response(s: AgyStep, conversation: string): NormalizedEvent[] {
    const messageId = callIdOf(conversation, s.step_index)
    const events: NormalizedEvent[] = []
    const text = s.text_delta ?? ''
    // A bare newline closes a model call that only called tools; it is a message only after text
    if (text && (this.spoke.has(messageId) || text.trim())) {
      this.spoke.add(messageId)
      events.push({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text, messageId })
    }
    if (s.state === 'DONE' && s.usage) events.push(...this.request(s.usage))
    return events
  }

  /** A model call's usage: the running reading with this call added, and the call's own input for the cache ledger */
  private request(usage: AgyUsage): NormalizedEvent[] {
    const call = tokensOf(usage)
    if (isZero(call)) return []
    this.turn = addTokens(this.turn, call)
    const request: RequestInput = { inputTokens: call.inputTokens, cacheReadTokens: call.cacheReadTokens, outputTokens: call.outputTokens }
    this.sent = addTokens(this.reading, this.turn)
    return [{ type: 'usage_update', sessionId: this.sessionId, tokens: this.sent, request }]
  }

  private announce(id: string, name: string, args: unknown): NormalizedEvent[] {
    if (this.open.has(id)) return []
    this.open.add(id)
    if (toolKind(name) === 'edit') this.touched.call(id, pathsOf(args))
    return [
      {
        type: 'tool_call',
        sessionId: this.sessionId,
        callId: id,
        summary: { tool: cardName(name), title: firstLine(titleOf(name, args)), paths: pathsOf(args) },
        ...(args === undefined ? {} : { input: args }),
      },
    ]
  }

  private tool(s: AgyStep, id: string): NormalizedEvent[] {
    const name = s.tool_name || s.tool_info?.name || 'tool'
    const events = this.announce(id, name, s.tool_info?.parameters)
    if (s.state === 'ACTIVE') return events
    return [...events, ...this.finish(id, s.state === 'DONE', s.state === 'DONE' ? (s.tool_info?.output ?? '') : errorText(s))]
  }

  /** A sub-agent starts and its step ends at once (measured); the child's own steps are not in this stream (§4.3) */
  private subagent(s: AgyStep, id: string): NormalizedEvent[] {
    const events = this.announce(id, s.tool_name || 'invoke_subagent', undefined)
    if (s.state === 'ACTIVE') return events
    const started = (s.subagent_info?.subagents ?? []).map((a) => [`Started sub-agent "${a.role || a.type_name || 'agent'}".`, a.initial_prompt].filter(Boolean).join('\n'))
    return [...events, ...this.finish(id, s.state === 'DONE', started.join('\n\n'))]
  }

  private finish(id: string, ok: boolean, output: string): NormalizedEvent[] {
    if (!this.open.delete(id)) return []
    return [toolResultEvent(this.sessionId, id, ok, output, `${this.label} did not return the output`), ...this.touched.result(id, ok)]
  }

  /** Calls still open when the turn or the process ended: closed as failed, so no card spins forever */
  endTurn(why = 'the turn ended before this call finished'): NormalizedEvent[] {
    const events = [...this.open].flatMap((id) => [toolResultEvent(this.sessionId, id, false, '', why)])
    this.open.clear()
    this.spoke.clear()
    return events
  }

  /** What a turn's `result` says beyond how it ended: the calls it left open, the total it reports, what `agy` refused */
  result(r: AgyResult): NormalizedEvent[] {
    const events = this.endTurn()
    const total = tokensOf(r.usage)
    // `result.usage` is the conversation's total; a result that carries none leaves the calls' own sum as the reading
    this.reading = isZero(total) ? addTokens(this.reading, this.turn) : total
    this.turn = NO_TOKENS
    if (!isZero(this.reading) && !same(this.reading, this.sent)) events.push({ type: 'usage_update', sessionId: this.sessionId, tokens: this.reading })
    this.sent = this.reading
    const denied = (r.denied_actions ?? []).map((d) => d.display_name || d.action).filter(Boolean)
    if (denied.length > 0) {
      events.push({ type: 'notice', sessionId: this.sessionId, level: 'warning', from: this.label, text: `${this.label} refused: ${denied.join(', ')}.` })
    }
    return events
  }
}

function errorText(s: AgyStep): string {
  const e = s.tool_info?.error
  return e?.message || e?.type || ''
}
