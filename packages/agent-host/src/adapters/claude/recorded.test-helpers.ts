import { loadRecording, newestVersion, recordedFolders } from '../frames/replay.test-helpers.js'
import { ClaudeAdapter } from './index.js'
import type { ClaudeMessage } from './json.js'

/**
 * What the real Claude Code sent, for the tests that read a message rather than a whole session (#1498): the recordings of
 * `scripts/frames-record.mts`, as the SDK hands them to the adapter. A test takes a message from a recording instead of writing
 * one with the fields it happens to read; a case no real run can produce (a malformed block, a failure the CLI cannot be made
 * to give cheaply) stays written by hand, with its reason beside it.
 */

export const CLAUDE_RECORDINGS = `${import.meta.dirname}/recordings`

/** The adapter a replay drives: no start gap, and no `claude` looked for on the machine */
export const replayedClaudeAdapter = (): ClaudeAdapter => new ClaudeAdapter({ platform: 'linux', executable: () => '/usr/local/bin/claude' })

/** What a recording was made with, which a replay's session is given again: the smallest model, and no settings file read */
export const CLAUDE_REPLAY_SESSION = { noSettingFiles: true, model: 'haiku' } as const

/**
 * The recorded CLI version's folder: the newest, as a re-recording on a version bump replaces the old one. Of `scenario`: the
 * newest that holds it, since a scenario recorded later comes from a later CLI than the rest
 */
export const recordedVersion = (scenario?: string): string => newestVersion(CLAUDE_RECORDINGS, scenario)

const fileOf = (scenario: string, version = recordedVersion(scenario)): string => recordedFolders(CLAUDE_RECORDINGS).find((f) => f.dir === version)!.file(scenario)

/** Lines the SDK answers or reads itself and never hands to the adapter */
const CONTROL = new Set(['control_request', 'control_response', 'control_cancel_request', 'keep_alive'])

/**
 * The messages the CLI sent in `scenario`, in order, as the adapter receives them. `version` (a folder, `claude-code-2.1.296`)
 * names one run when a test needs what happened on it, not on every run: the model chose to think, the account was near a limit
 */
export function recordedMessages(scenario: string, version?: string): ClaudeMessage[] {
  const recording = loadRecording(fileOf(scenario, version))
  return recording.frames.flatMap((f) => (f.dir === 'in' && f.msg && !CONTROL.has(String(f.msg.type)) ? [f.msg as unknown as ClaudeMessage] : []))
}

/** The messages of `scenario` that `pick` accepts */
export const recordedWhere = (scenario: string, pick: (m: Record<string, unknown>) => boolean, version?: string): ClaudeMessage[] =>
  recordedMessages(scenario, version).filter((m) => pick(m as unknown as Record<string, unknown>))

/** The `can_use_tool` requests the CLI made in `scenario`: what the adapter was asked to approve */
export function recordedApprovals(scenario: string): { tool: string; input: Record<string, unknown> }[] {
  const recording = loadRecording(fileOf(scenario))
  return recording.frames.flatMap((f) => {
    const request = (f.msg as { type?: string; request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown> } } | undefined)?.request
    return f.dir === 'in' && f.msg?.type === 'control_request' && request?.subtype === 'can_use_tool' ? [{ tool: String(request.tool_name), input: request.input ?? {} }] : []
  })
}
