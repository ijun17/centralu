import type { NormalizedEvent, RequestInput, TokenUsage, ToolSummary } from '@cc/protocol'
import { asObj } from '../../json-value.js'
import { TouchedFiles } from '../file-changes.js'
import { planUpdate } from '../plan.js'
import { tokenCount } from '../token-usage.js'
import { toolResultEvent } from '../tool-result.js'
import { firstLine } from '../tool-titles.js'
import { blockText, ToolCallFields, type PromptResult, type SessionUpdate } from './wire.js'

/**
 * `session/update` → NormalizedEvent (docs/plans/acp-adapter.md §5). One instance per session: ACP sends a tool call as
 * an upsert by id and a compaction as chunks by id, so what has been said of each is kept here. Everything else is a
 * frame-by-frame translation.
 */

/** ACP's tool kinds, as the card names the tool (the same names the other two adapters give their cards) */
const KIND_TOOL: Record<string, string> = {
  execute: 'Bash',
  edit: 'Edit',
  delete: 'Edit',
  move: 'Edit',
  read: 'Read',
  search: 'Grep',
  fetch: 'WebFetch',
  think: 'Think',
}

type OpenCall = { output: string }

const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'

/** How much of a text's end could be the start of the closing tag, and so waits for the next chunk */
function heldTail(text: string): number {
  for (let n = Math.min(CLOSE_TAG.length - 1, text.length); n > 0; n--) if (CLOSE_TAG.startsWith(text.slice(text.length - n))) return n
  return 0
}

export class AcpNormalizer {
  /** Calls announced as `tool_call` and not yet ended, by `toolCallId` */
  private readonly open = new Map<string, OpenCall>()
  /** Every field said of each call this turn, merged: a permission request may carry less than the call did (measured, Cursor) */
  private readonly known = new Map<string, ToolCallFields>()
  /** Paths an edit call would change, reported once the call ends ok (#843): a denied edit marks nothing */
  private readonly touched: TouchedFiles
  private readonly compactions = new Map<string, string>()
  private segment = 0
  private lastChunk: 'message' | 'thought' | 'other' = 'other'

  constructor(
    private readonly sessionId: string,
    /** Who returns a call's output: an empty one can be a command that printed nothing or output the tool did not return
     *  (measured on Cursor: 60 KB arrived as `stdout: ""`), and which it was cannot be told: said as the tool not returning it */
    private readonly label = 'The tool',
  ) {
    this.touched = new TouchedFiles(sessionId)
  }

  /** The events one update says. `available_commands_update` and the like are read by the session, not here */
  update(u: SessionUpdate): NormalizedEvent[] {
    const sessionId = this.sessionId
    const held = u.sessionUpdate === 'agent_message_chunk' ? [] : this.releaseHeld()
    return [...held, ...this.translate(u, sessionId)]
  }

  private translate(u: SessionUpdate, sessionId: string): NormalizedEvent[] {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = blockText(u.content)
        if (u.content.type === 'image' && u.content.data && u.content.mimeType) {
          return [{ type: 'message_image', sessionId, mime: u.content.mimeType, data: u.content.data }]
        }
        if (this.lastChunk !== 'message') this.segment++
        this.lastChunk = 'message'
        return this.messageText(u.messageId ?? `acp-${this.segment}`, text)
      }
      case 'agent_thought_chunk': {
        this.lastChunk = 'thought'
        const text = blockText(u.content)
        return text ? [{ type: 'reasoning_delta', sessionId, text }] : []
      }
      case 'tool_call':
      case 'tool_call_update':
        this.lastChunk = 'other'
        return this.toolCall(u)
      case 'plan':
        return [planUpdate(sessionId, u.entries, 'content')]
      case 'session_info_update':
        return u.title ? [{ type: 'session_title', sessionId, title: u.title, auto: true }] : []
      case 'compaction_summary_chunk':
        this.compactions.set(u.compactionId, (this.compactions.get(u.compactionId) ?? '') + blockText(u.content))
        return []
      case 'compaction_update':
        return this.compaction(u)
      case 'notice':
        return [{ type: 'notice', sessionId, level: u.severity === 'error' ? 'error' : u.severity === 'warning' ? 'warning' : 'info', text: [u.title, u.description].filter(Boolean).join('\n') }]
      default:
        return []
    }
  }

  /**
   * A message's text, without the `</think>` a model leaves where it put its reasoning in the reply (OpenCode's free
   * model, measured in its own store: a step's text is the reasoning, then `</think>`, then the reply, with no `<think>`
   * before it). The first such tag of a message is dropped with the space after it; a tag split over two chunks is held
   * until the next one says whether it is one. The reasoning before it stays reply text: it was shown as it came.
   */
  private messageText(messageId: string, text: string): NormalizedEvent[] {
    const before = this.lastMessage === messageId ? [] : this.releaseHeld()
    const m = this.messages.get(messageId) ?? { held: '', settled: false, trim: false }
    this.messages.set(messageId, m)
    let out = m.held + text
    m.held = ''
    if (m.trim) {
      out = out.replace(/^\s+/, '')
      m.trim = out === ''
    }
    if (!m.settled) {
      const open = out.indexOf(OPEN_TAG)
      const close = out.indexOf(CLOSE_TAG)
      if (close !== -1 && (open === -1 || open > close)) {
        const after = out.slice(close + CLOSE_TAG.length).replace(/^\s+/, '')
        m.trim = after === ''
        out = out.slice(0, close) + after
        m.settled = true
      } else if (open !== -1) m.settled = true
      else {
        const keep = heldTail(out)
        m.held = out.slice(out.length - keep)
        out = out.slice(0, out.length - keep)
      }
    }
    this.lastMessage = messageId
    return [...before, ...(out ? [{ type: 'message_delta' as const, sessionId: this.sessionId, role: 'assistant' as const, text: out, messageId }] : [])]
  }

  /** What a message held back, once something else comes: it was no tag */
  private releaseHeld(): NormalizedEvent[] {
    const m = this.lastMessage === null ? undefined : this.messages.get(this.lastMessage)
    if (!m?.held || this.lastMessage === null) return []
    const text = m.held
    m.held = ''
    return [{ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text, messageId: this.lastMessage }]
  }

  private readonly messages = new Map<string, { held: string; settled: boolean; trim: boolean }>()
  private lastMessage: string | null = null

  /** Calls the person (or a Stop) refused this turn: whatever the agent says of them after, they did not run as asked */
  private readonly refused = new Set<string>()

  /**
   * What this turn has heard of a call, merged with `u`. `asked`: `u` is a permission request's, which may carry less than
   * the call did (no input, measured on Cursor) and a looser kind: Cursor asks about a `delete` call as `kind: edit`
   * (measured), so the call's own kind wins over the request's label
   */
  call(u: ToolCallFields, asked = false): ToolCallFields {
    const before = this.known.get(u.toolCallId)
    const merged = { ...before, ...definedFields(u) }
    return ToolCallFields.parse(asked && before?.kind ? { ...merged, kind: before.kind } : merged)
  }

  /** The call was answered no (a reject, or cancelled by a Stop): its end is said as not ok */
  refuse(callId: string): void {
    this.refused.add(callId)
  }

  private toolCall(u: ToolCallFields): NormalizedEvent[] {
    const id = u.toolCallId
    const seen = this.call(u)
    this.known.set(id, seen)
    const events: NormalizedEvent[] = []
    let call = this.open.get(id)
    if (!call) {
      // ACP's first frame of a call comes before its input (measured): it is announced once the input or a status is there
      const ready = hasInput(seen.rawInput) || (seen.status !== undefined && seen.status !== 'pending')
      if (!ready) return []
      call = { output: '' }
      this.open.set(id, call)
      events.push({ type: 'tool_call', sessionId: this.sessionId, callId: id, summary: summaryOf(seen), ...(seen.rawInput === undefined ? {} : { input: seen.rawInput }) })
      if (seen.kind === 'edit' || seen.kind === 'delete' || seen.kind === 'move') {
        const paths = pathsOf(seen)
        this.touched.call(id, paths)
      }
    }
    const output = outputOf(u)
    // An update's content is the whole output so far (measured), so the delta is what it adds
    if (output !== null && output.startsWith(call.output) && output.length > call.output.length && u.status !== 'completed' && u.status !== 'failed') {
      events.push({ type: 'tool_output_delta', sessionId: this.sessionId, callId: id, text: output.slice(call.output.length) })
      call.output = output
    }
    if (u.status === 'completed' || u.status === 'failed') {
      this.open.delete(id)
      const refused = this.refused.delete(id)
      // Measured on Cursor: a refused call ends `completed` with nothing else
      const ok = u.status === 'completed' && !refused && rawOutputOk(seen.rawOutput)
      const text = output ?? rawOutputText(seen.rawOutput) ?? call.output
      events.push(toolResultEvent(this.sessionId, id, ok, text || (refused ? 'Not run: the request was refused.' : ''), `${this.label} did not return the output`), ...this.touched.result(id, ok))
    }
    return events
  }

  /** Calls still open when the turn ended: closed as failed, so no card spins forever (`why`: what ended them) */
  endTurn(why = 'the turn ended before this call finished'): NormalizedEvent[] {
    const events = [...this.releaseHeld(), ...[...this.open.keys()].map((id) => toolResultEvent(this.sessionId, id, false, '', why))]
    this.open.clear()
    this.known.clear()
    this.refused.clear()
    this.messages.clear()
    this.lastChunk = 'other'
    return events
  }

  private compaction(u: Extract<SessionUpdate, { sessionUpdate: 'compaction_update' }>): NormalizedEvent[] {
    if (u.status === 'in_progress') return [{ type: 'activity', sessionId: this.sessionId, activity: 'compacting' }]
    const summary = u.summary?.map(blockText).join('') || this.compactions.get(u.compactionId) || ''
    this.compactions.delete(u.compactionId)
    const done: NormalizedEvent = { type: 'activity', sessionId: this.sessionId, activity: null }
    if (u.status === 'completed') return [done, { type: 'compaction', sessionId: this.sessionId, failed: false, ...(summary ? { reason: firstLine(summary, 300) } : {}) }]
    if (u.status === 'failed') return [done, { type: 'compaction', sessionId: this.sessionId, failed: true, ...(u.error ? { reason: u.error } : {}) }]
    return [done]
  }
}

/** The prompt answer's token counts in our terms (this turn's alone), or null when it carries none (Cursor, a `/compact`) */
export function tokenUsage(result: PromptResult): TokenUsage | null {
  const u = result.usage
  if (!u || (u.inputTokens === undefined && u.outputTokens === undefined)) return null
  return {
    inputTokens: tokenCount(u.inputTokens),
    outputTokens: tokenCount(u.outputTokens) + tokenCount(u.thoughtTokens),
    cacheReadTokens: tokenCount(u.cachedReadTokens),
    cacheCreationTokens: tokenCount(u.cachedWriteTokens),
  }
}

/**
 * What the prompt cache accounting reads of a turn: its input, split as the agent reports it (uncached input apart from
 * cache reads, measured). The spec reports a turn's usage, which can hold several model requests; OpenCode's recordings read as one request (its total matches the context size), so this is the turn as
 * one reading. A write figure is given only when the agent reports one. Null when the turn read no input.
 */
export function requestInput(result: PromptResult): RequestInput | null {
  const u = result.usage
  const inputTokens = tokenCount(u?.inputTokens)
  const cacheReadTokens = tokenCount(u?.cachedReadTokens)
  if (!u || inputTokens + cacheReadTokens <= 0) return null
  return {
    inputTokens,
    cacheReadTokens,
    ...(u.cachedWriteTokens !== undefined ? { cacheCreationTokens: tokenCount(u.cachedWriteTokens) } : {}),
    ...(u.outputTokens !== undefined ? { outputTokens: tokenCount(u.outputTokens) + tokenCount(u.thoughtTokens) } : {}),
  }
}

function definedFields(u: ToolCallFields): Partial<ToolCallFields> {
  // The fields this frame said: an update leaves out what did not change
  return Object.fromEntries(Object.entries(u).filter(([k, v]) => v !== undefined && k !== 'sessionUpdate'))
}

function hasInput(v: unknown): boolean {
  return typeof v === 'object' && v !== null && Object.keys(v).some((k) => k !== 'cwd')
}

function pathsOf(u: ToolCallFields): string[] {
  const fromDiffs = (u.content ?? []).flatMap((c) => (c.type === 'diff' && c.path ? [c.path] : []))
  return [...new Set([...(u.locations ?? []).map((l) => l.path), ...fromDiffs])]
}

function summaryOf(u: ToolCallFields): ToolSummary {
  const tool = (u.kind && KIND_TOOL[u.kind]) || u.title || 'tool'
  // A command reads as itself: Cursor titles it in backticks (measured)
  const command = u.kind === 'execute' ? commandOf(u) : ''
  return { tool, title: firstLine(command || u.title || tool), paths: pathsOf(u) }
}

/** The text a tool call's content holds, or null when this frame carries none */
function outputOf(u: ToolCallFields): string | null {
  if (!u.content?.length) return null
  return u.content
    .map((c) => (c.type === 'content' ? blockText(c.content) : c.type === 'diff' ? `${c.path ?? ''}\n${c.newText ?? ''}` : ''))
    .join('')
}

/**
 * A call's output from its `rawOutput` when its content carries none: OpenCode's `{output}`, Cursor's command
 * `{exitCode, stdout, stderr}` (measured), an `{error}`
 */
function rawOutputText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  const o = asObj(raw)
  if (typeof o.output === 'string') return o.output
  const streams = [o.stdout, o.stderr].filter((s): s is string => typeof s === 'string' && s.length > 0)
  if (streams.length) return streams.join(streams[0]?.endsWith('\n') ? '' : '\n')
  if (typeof o.error === 'string') return o.error
  return null
}

/** What `rawOutput` says of the call's success: a command that exited non-zero, or an MCP call's `success: false`, failed */
function rawOutputOk(raw: unknown): boolean {
  const o = asObj(raw)
  if (typeof o.exitCode === 'number' && o.exitCode !== 0) return false
  return o.success !== false
}

/** The command an `execute` call runs, as its input names it */
export function commandOf(u: ToolCallFields): string {
  const command = asObj(u.rawInput).command
  return typeof command === 'string' ? command : ''
}
