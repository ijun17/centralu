import type { StoredMessage } from './commands.js'
import { isRecord } from './tolerant.js'
import type { NormalizedEvent, SubagentStep } from './events.js'

/**
 * Which events become stored transcript rows, and where a streamed message ends (#66, #77, #212).
 *
 * The host records a session's events (`SessionRecord.persistMessage`) and the mock replays the same record in
 * memory (`SessionStore.record`, platform mock). Both used to spell these rules out by hand and drifted: the mock
 * merged two messages with different `messageId`s into one row, kept no row for an error, and stored a subagent's
 * empty chunks. What one screen draws from a live event and from the row read back (`messagesToChat`) depends on
 * these rules, so they live here once and both sides read them.
 */

/** The two kinds of row a streamed chunk grows */
export type StreamRowKind = 'text' | 'reasoning'

/** The row kinds an event is recorded as outside a stream (a person's message and an image take their own paths) */
export type RecordedRowKind = Exclude<StoredMessage['kind'], StreamRowKind | 'image'>

/**
 * The kind of streamed row a chunk belongs to, or null when the event is not a recorded chunk.
 *
 * A reasoning summary (#58) only counts once text is attached: a chunk with nothing but `estTokens` (claude) lives
 * only as a progress indicator, and stacking up content-free rows would turn the record into noise.
 */
export function streamRowKind(e: NormalizedEvent): StreamRowKind | null {
  if (e.type === 'message_delta') return 'text'
  if (e.type === 'reasoning_delta' && e.text) return 'reasoning'
  return null
}

/** The open streamed row, as far as deciding whether the next chunk grows it: its kind and the payload it opened with */
export type OpenStreamRow = { kind: StoredMessage['kind']; payload: unknown }

/**
 * Whether a chunk grows the open row rather than starting a new one: one row is one message (#77).
 *
 * A chunk of another kind (answer <-> reasoning) starts a new row. So does a chunk that names a different message than
 * the open row (#212): Codex can say two things in a row with nothing recorded between them (a poll of a running
 * command is not an item), and with no boundary there the two became one row: "…polling it now.It is still running…".
 * A chunk that names no message continues the open row.
 */
export function continuesStreamRow(open: OpenStreamRow | undefined, e: NormalizedEvent): boolean {
  const kind = streamRowKind(e)
  if (!open || !kind || open.kind !== kind) return false
  const messageId = e.type === 'message_delta' ? e.messageId : undefined
  const openId = isRecord(open.payload) ? open.payload.messageId : undefined
  return !(messageId && typeof openId === 'string' && openId !== messageId)
}

/**
 * The row kind an event that is not a stream is recorded as, or null when it is not recorded.
 *
 * - `marker`: a compaction point and a fresh conversation (#304) (the model forgot, our record did not), what the tool
 *   wanted the person to read (#304), and a failure (#107: a turn that died with a 400 used to leave an empty answer
 *   and nothing saying why).
 * - `app_view`: only that an app's view was raised under a card, or refused (M4 B-1). A result, a cancellation or a
 *   close happen while the view is alive and are not recorded.
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
 * Whether the event ends the open streamed row: any recorded event (a tool call in the middle of an answer splits it),
 * and the end of a turn (turn_complete, error, a state_change that is not working), which records nothing but ends the
 * message. An event that is never recorded, like activity or usage_update, blends with the stream.
 *
 * An agent's image ends it too (#868): it is a row of its own between the text before it and the text after it. The
 * host left the text row open across it, so "a", an image, "b" was stored as "ab" above the image, while the live
 * screen drew a, the image, b.
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
 * The stored payload of an app view row: **never the body**. The tool's input is passed to the app as given, so what it
 * contains is unknown (the same reason an app run record keeps only a summary of its arguments), and the instance id
 * means nothing once the host process ends.
 */
export function appViewRecord(e: Extract<NormalizedEvent, { type: 'app_view' }>): Record<string, unknown> {
  const { type, sessionId, callId, appId, projectId, tool, phase, reason } = e
  return { type, sessionId, callId, appId, projectId, tool, phase, ...(reason ? { reason } : {}) }
}

/**
 * A native subagent's step (#222) as a row under its launch card: its kind and role. A step's text arrives whole, so
 * it is one row as it comes.
 */
export function subagentStepRow(step: SubagentStep): Pick<StoredMessage, 'kind' | 'role'> {
  const kind = step.type === 'message_delta' ? 'text' : step.type === 'reasoning_delta' ? 'reasoning' : step.type
  return { kind, role: kind === 'text' || kind === 'reasoning' ? 'assistant' : 'system' }
}

/** Whether a subagent's step is kept at all: a chunk with no text carries nothing to read */
export function keepsSubagentStep(step: SubagentStep): boolean {
  return !((step.type === 'message_delta' || step.type === 'reasoning_delta') && !step.text)
}
