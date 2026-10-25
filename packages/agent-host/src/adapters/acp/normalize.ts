import type { NormalizedEvent, TokenUsage, ToolSummary } from '@cc/protocol'
import { planUpdate } from '../plan.js'
import { toolResultEvent } from '../tool-result.js'
import { firstLine } from '../tool-titles.js'
import { blockText, type PromptResult, type SessionUpdate, type ToolCallFields } from './wire.js'

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
  /** Calls seen but not yet announced: ACP's first frame comes before the input (measured) */
  private readonly unannounced = new Map<string, ToolCallFields>()
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

  /** What this turn has heard of a call, merged with `u` (a permission request names the call it asks about) */
  call(u: ToolCallFields): ToolCallFields {
    return { ...this.known.get(u.toolCallId), ...definedFields(u) } as ToolCallFields
  }

  private toolCall(u: ToolCallFields): NormalizedEvent[] {
    const id = u.toolCallId
    this.known.set(id, this.call(u))
    const events: NormalizedEvent[] = []
    if (!this.open.has(id)) {
      const seen = { ...this.unannounced.get(id), ...definedFields(u) } as ToolCallFields
      const ready = hasInput(seen.rawInput) || (seen.status !== undefined && seen.status !== 'pending')
      if (!ready) {
        this.unannounced.set(id, seen)
        return []
      }
      this.unannounced.delete(id)
      this.open.set(id, { output: '' })
      events.push({ type: 'tool_call', sessionId: this.sessionId, callId: id, summary: summaryOf(seen), ...(seen.rawInput === undefined ? {} : { input: seen.rawInput }) })
      if (seen.kind === 'edit' || seen.kind === 'delete' || seen.kind === 'move') {
        const paths = pathsOf(seen)
        if (paths.length) events.push({ type: 'files_touched', sessionId: this.sessionId, paths })
      }
    }
    const call = this.open.get(id)!
    const output = outputOf(u)
    // An update's content is the whole output so far (measured), so the delta is what it adds
    if (output !== null && output.startsWith(call.output) && output.length > call.output.length && u.status !== 'completed' && u.status !== 'failed') {
      events.push({ type: 'tool_output_delta', sessionId: this.sessionId, callId: id, text: output.slice(call.output.length) })
      call.output = output
    }
    if (u.status === 'completed' || u.status === 'failed') {
      this.open.delete(id)
      events.push(toolResultEvent(this.sessionId, id, u.status === 'completed', output ?? rawOutputText(u.rawOutput) ?? call.output, 'no output'))
    }
    return events
  }

  /** Calls still open when the turn ended: closed as failed, so no card spins forever */
  endTurn(): NormalizedEvent[] {
    const events = [...this.open.keys()].map((id) => toolResultEvent(this.sessionId, id, false, '', 'the turn ended before this call finished'))
    this.open.clear()
    this.unannounced.clear()
    this.known.clear()
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

function rawOutputText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>
    if (typeof o.output === 'string') return o.output
    if (typeof o.error === 'string') return o.error
  }
  return null
}

/** The command an `execute` call runs, as its input names it */
export function commandOf(u: ToolCallFields): string {
  const input = u.rawInput
  return typeof input === 'object' && input !== null && typeof (input as { command?: unknown }).command === 'string' ? (input as { command: string }).command : ''
}
