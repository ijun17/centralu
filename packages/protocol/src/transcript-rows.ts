import type { StoredMessage } from './commands.js'
import { isRecord } from './tolerant.js'
import type { NormalizedEvent, SubagentStep } from './events.js'

// Which events become stored transcript rows and where a streamed message ends: the host's record and the mock's
// replay both read these, so a live screen and a reload draw the same rows.

export type StreamRowKind = 'text' | 'reasoning'

/** A person's message and an image take their own paths */
export type RecordedRowKind = Exclude<StoredMessage['kind'], StreamRowKind | 'image'>

/** A reasoning chunk with no text (Claude's `estTokens` alone) is only progress, never a row */
export function streamRowKind(e: NormalizedEvent): StreamRowKind | null {
  if (e.type === 'message_delta') return 'text'
  if (e.type === 'reasoning_delta' && e.text) return 'reasoning'
  return null
}

export type OpenStreamRow = { kind: StoredMessage['kind']; payload: unknown }

/**
 * One row is one message. A chunk naming another message starts a new row: Codex can say two things with nothing
 * recorded between them (a poll of a running command is not an item), which would merge into one (#212).
 */
export function continuesStreamRow(open: OpenStreamRow | undefined, e: NormalizedEvent): boolean {
  const kind = streamRowKind(e)
  if (!open || !kind || open.kind !== kind) return false
  const messageId = e.type === 'message_delta' ? e.messageId : undefined
  const openId = isRecord(open.payload) ? open.payload.messageId : undefined
  return !(messageId && typeof openId === 'string' && openId !== messageId)
}

/**
 * Null when not recorded. A failure is a marker so a turn that died leaves a reason, not an empty answer. Of an app
 * view only its raising or refusal is kept: the rest happens while the view is alive.
 */
export function recordedRowKind(e: NormalizedEvent): RecordedRowKind | null {
  switch (e.type) {
    case 'tool_call':
    case 'tool_result':
      return e.type
    case 'approval_request':
    case 'approval_resolved':
      return 'approval'
    case 'compaction':
    case 'conversation_reset':
    case 'notice':
    case 'error':
      return 'marker'
    case 'app_view':
      return e.phase === 'open' || e.phase === 'rejected' ? 'app_view' : null
    default:
      return null
  }
}

/**
 * A recorded event or a turn's end splits the stream; an unrecorded one (activity, usage_update) blends in. An image is
 * a row of its own, so the text around it is two rows, as the live screen draws it (#868).
 */
export function endsStreamRow(e: NormalizedEvent): boolean {
  return (
    recordedRowKind(e) !== null ||
    e.type === 'message_image' ||
    e.type === 'turn_complete' ||
    e.type === 'error' ||
    (e.type === 'state_change' && e.state !== 'working')
  )
}

/**
 * Never the body: the tool's input reaches the app as given, so what it holds is unknown (as an app run keeps only a
 * summary of its arguments), and the instance id means nothing once the host process ends.
 */
export function appViewRecord(e: Extract<NormalizedEvent, { type: 'app_view' }>): Record<string, unknown> {
  const { type, sessionId, callId, appId, projectId, tool, phase, reason } = e
  return { type, sessionId, callId, appId, projectId, tool, phase, ...(reason ? { reason } : {}) }
}

/** A subagent step's text arrives whole, so each step is one row as it comes */
export function subagentStepRow(step: SubagentStep): Pick<StoredMessage, 'kind' | 'role'> {
  const kind =
    step.type === 'message_delta' ? 'text' : step.type === 'reasoning_delta' ? 'reasoning' : step.type
  return { kind, role: kind === 'text' || kind === 'reasoning' ? 'assistant' : 'system' }
}

export function keepsSubagentStep(step: SubagentStep): boolean {
  return !((step.type === 'message_delta' || step.type === 'reasoning_delta') && !step.text)
}
