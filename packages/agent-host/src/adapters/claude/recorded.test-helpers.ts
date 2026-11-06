import { loadRecording, recordedFolders } from '../frames/replay.test-helpers.js'
import type { ClaudeMessage } from './json.js'

/**
 * What the real Claude Code sent, for the tests that read a message rather than a whole session (#1498): the recordings of
 * `scripts/frames-record.mts`, as the SDK hands them to the adapter. A test takes a message from a recording instead of writing
 * one with the fields it happens to read; a case no real run can produce (a malformed block, a failure the CLI cannot be made
 * to give cheaply) stays written by hand, with its reason beside it.
 */

export const CLAUDE_RECORDINGS = `${import.meta.dirname}/recordings`

/**
 * The recorded CLI version's folder: the newest, as a re-recording on a version bump replaces the old one. Of `scenario`: the
 * newest that holds it, since a scenario recorded later comes from a later CLI than the rest
 */
export const recordedVersion = (scenario?: string): string => {
  const numbers = (dir: string) => dir.replace(/^claude-code-/, '').split('.').map(Number)
  const newer = (a: string, b: string) => numbers(a).reduce((order, n, i) => order || n - (numbers(b)[i] ?? 0), 0)
  return recordedFolders(CLAUDE_RECORDINGS)
    .filter((f) => scenario === undefined || f.names.includes(scenario))
    .map((f) => f.dir)
    .sort(newer)
    .at(-1)!
}

const fileOf = (scenario: string): string => recordedFolders(CLAUDE_RECORDINGS).find((f) => f.dir === recordedVersion(scenario))!.file(scenario)

/** Lines the SDK answers or reads itself and never hands to the adapter */
const CONTROL = new Set(['control_request', 'control_response', 'control_cancel_request', 'keep_alive'])

/** The messages the CLI sent in `scenario`, in order, as the adapter receives them */
export function recordedMessages(scenario: string): ClaudeMessage[] {
  const recording = loadRecording(fileOf(scenario))
  return recording.frames.flatMap((f) => (f.dir === 'in' && f.msg && !CONTROL.has(String(f.msg.type)) ? [f.msg as unknown as ClaudeMessage] : []))
}

/** The messages of `scenario` that `pick` accepts */
export const recordedWhere = (scenario: string, pick: (m: Record<string, unknown>) => boolean): ClaudeMessage[] => recordedMessages(scenario).filter((m) => pick(m as unknown as Record<string, unknown>))

/** The `can_use_tool` requests the CLI made in `scenario`: what the adapter was asked to approve */
export function recordedApprovals(scenario: string): { tool: string; input: Record<string, unknown> }[] {
  const recording = loadRecording(fileOf(scenario))
  return recording.frames.flatMap((f) => {
    const request = (f.msg as { type?: string; request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown> } } | undefined)?.request
    return f.dir === 'in' && f.msg?.type === 'control_request' && request?.subtype === 'can_use_tool' ? [{ tool: String(request.tool_name), input: request.input ?? {} }] : []
  })
}
