import type { NormalizedEvent, TokenUsage, ToolSummary } from '@cc/protocol'
import { asObj } from '../../json-value.js'
import { planUpdate } from '../plan.js'
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

export class AcpNormalizer {
  /** Calls announced as `tool_call` and not yet ended, by `toolCallId` */
  private readonly open = new Map<string, OpenCall>()
  /** Every field said of each call this turn, merged: a permission request may carry less than the call did (measured, Cursor) */
  private readonly known = new Map<string, ToolCallFields>()
  private readonly compactions = new Map<string, string>()
  private segment = 0
  private lastChunk: 'message' | 'thought' | 'other' = 'other'

  constructor(private readonly sessionId: string) {}

  /** The events one update says. `available_commands_update` and the like are read by the session, not here */
  update(u: SessionUpdate): NormalizedEvent[] {
    const sessionId = this.sessionId
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = blockText(u.content)
        if (u.content.type === 'image' && u.content.data && u.content.mimeType) {
          return [{ type: 'message_image', sessionId, mime: u.content.mimeType, data: u.content.data }]
        }
        if (this.lastChunk !== 'message') this.segment++
        this.lastChunk = 'message'
        return text ? [{ type: 'message_delta', sessionId, role: 'assistant', text, messageId: u.messageId ?? `acp-${this.segment}` }] : []
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
        if (paths.length) events.push({ type: 'files_touched', sessionId: this.sessionId, paths })
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
      const ok = u.status === 'completed' && !refused && rawOutputOk(u.rawOutput)
      const text = output ?? rawOutputText(u.rawOutput) ?? call.output
      events.push(toolResultEvent(this.sessionId, id, ok, text || (refused ? 'Not run: the request was refused.' : ''), 'no output'))
    }
    return events
  }

  /** Calls still open when the turn ended: closed as failed, so no card spins forever (`why`: what ended them) */
  endTurn(why = 'the turn ended before this call finished'): NormalizedEvent[] {
    const events = [...this.open.keys()].map((id) => toolResultEvent(this.sessionId, id, false, '', why))
    this.open.clear()
    this.known.clear()
    this.refused.clear()
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

/** The prompt answer's token counts in our terms, or null when it carries none (Cursor, a `/compact`) */
export function tokenUsage(result: PromptResult): TokenUsage | null {
  const u = result.usage
  if (!u || (u.inputTokens === undefined && u.outputTokens === undefined)) return null
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: (u.outputTokens ?? 0) + (u.thoughtTokens ?? 0),
    cacheReadTokens: u.cachedReadTokens ?? 0,
    cacheCreationTokens: u.cachedWriteTokens ?? 0,
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
