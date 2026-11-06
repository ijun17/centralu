import { loadRecording, recordedFolders } from '../frames/replay.test-helpers.js'

/**
 * What the real Codex app-server sent, for the tests that read one answer or notification rather than a whole session
 * (#1498): the recordings of `scripts/frames-record.mts` (`recordings/codex-<version>/<scenario>.jsonl`). A test takes a frame
 * from a recording instead of writing one with the fields it happens to read; a case no real run can produce stays written
 * by hand, with its reason beside it.
 */

export const CODEX_RECORDINGS = `${import.meta.dirname}/recordings`

/** The recorded app-server version's folder: the newest, as a re-recording on a version bump replaces the old one */
export const recordedVersion = (): string => {
  const numbers = (dir: string) => dir.replace(/^codex-/, '').split('.').map(Number)
  const newer = (a: string, b: string) => numbers(a).reduce((order, n, i) => order || n - (numbers(b)[i] ?? 0), 0)
  return recordedFolders(CODEX_RECORDINGS).map((f) => f.dir).sort(newer).at(-1)!
}

const fileOf = (scenario: string): string => recordedFolders(CODEX_RECORDINGS).find((f) => f.dir === recordedVersion())!.file(scenario)

export type Frame = { dir: 'in' | 'out'; msg: Record<string, unknown> }

/** The frames of `scenario` in the order they went, the process lines of every process it started */
export function recordedFrames(scenario: string): Frame[] {
  return loadRecording(fileOf(scenario)).frames.flatMap((f) => (f.dir !== 'exit' && f.msg ? [{ dir: f.dir, msg: f.msg }] : []))
}

/** The notifications the app-server sent in `scenario`, in order, with the given method (any when absent) */
export const recordedNotifications = (scenario: string, method?: string): { method: string; params?: unknown }[] =>
  recordedFrames(scenario).flatMap((f) => (f.dir === 'in' && typeof f.msg.method === 'string' && f.msg.id === undefined && (method === undefined || f.msg.method === method) ? [{ method: f.msg.method, params: f.msg.params }] : []))

/** The requests the app-server made to the client (approvals) in `scenario`, with their ids */
export const recordedServerRequests = (scenario: string): { id: number | string; method: string; params?: unknown }[] =>
  recordedFrames(scenario).flatMap((f) => (f.dir === 'in' && typeof f.msg.method === 'string' && (typeof f.msg.id === 'string' || typeof f.msg.id === 'number') ? [{ id: f.msg.id, method: f.msg.method, params: f.msg.params }] : []))

/** The answers to the client's requests of `method` in `scenario` (`result` or `error`), in order */
export function recordedAnswers(scenario: string, method: string): { result?: Record<string, unknown>; error?: unknown }[] {
  const frames = recordedFrames(scenario)
  const asked = new Set(frames.flatMap((f) => (f.dir === 'out' && f.msg.method === method ? [String(f.msg.id)] : [])))
  return frames.flatMap((f) => (f.dir === 'in' && f.msg.method === undefined && asked.has(String(f.msg.id)) ? [{ result: f.msg.result as Record<string, unknown> | undefined, error: f.msg.error }] : []))
}
