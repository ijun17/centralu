/**
 * A turn the provider ended because its servers were at capacity (#1693). Codex words it `error: { message: "Selected
 * model is at capacity. Please try a different model.", codex_error_info: "server_overloaded" }` on `task_complete`
 * (measured in three rollouts, 2026-10-28), and sends it as `TurnError.codexErrorInfo: "serverOverloaded"` over the
 * app-server. It is no usage limit and no refusal of the model: the same request is served a moment later, which is why the
 * host retries this one error and no other (`OverloadRetry`).
 *
 * The marker `ProtocolError.data.reason` carries (`data` is free-form, so an older screen shows the error as any other).
 */
export const SERVER_OVERLOADED = 'server_overloaded'

/** Whether Codex's own classification of a failed turn (`TurnError.codexErrorInfo`: a bare string or an object keyed by the kind) is "the servers are at capacity" */
export function isServerOverloaded(errorInfo: unknown): boolean {
  return errorInfo === 'serverOverloaded' || (errorInfo !== null && typeof errorInfo === 'object' && 'serverOverloaded' in errorInfo)
}
