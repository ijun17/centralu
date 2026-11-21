import type { NormalizedEvent } from '@cc/protocol'
import { tokenCount } from '../token-usage.js'
import { str, type Json } from './json.js'

/** How a turn ends or is held up (`normalizeMessage`): a usage limit, and the turn's result. */

/*
 * A limit (M0 finding: `rate_limit_event.rate_limit_info`). **Only `rejected` is a limit** of the SDK's three statuses
 * ('allowed' | 'allowed_warning' | 'rejected'): the banner says "cannot be used right now", and `allowed_warning` still
 * goes through. The warning's headroom shows in the usage window (agents.usage) as a percentage.
 */
export function rateLimitEvents(m: Json, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const info = (m.rate_limit_info ?? {}) as Json
  if (str(info.status) === 'rejected') {
    const resetsAt = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : undefined
    out.push({
      type: 'limit_reached',
      sessionId,
      resumeAt: resetsAt,
      windowMins: str(info.rateLimitType) === 'five_hour' ? 300 : undefined,
    })
  }
  return out
}

export function resultEvents(m: Json, sessionId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = []
  const modelUsage = (m.modelUsage ?? {}) as Record<string, Json>
  const models = Object.values(modelUsage)
  if (models.length > 0) {
    /*
     * Context usage is never computed here: `modelUsage` is a **session-wide accumulation** that every cache read adds to
     * (summed, it read "context 533%"). The window's content comes from `getContextUsage()` at a turn's end (`context_update`).
     * **Every model is summed**: one entry per model (sdk.d.ts: across everything, the main loop, a subagent, compaction),
     * and a small model that titles something or shortens a tool result can come before the main one (measured: the first
     * entry alone read 1108/13 where Opus used 200/363 output tokens against 24k-80k cache input).
     */
    const sum = (field: string) => models.reduce((n, u) => n + tokenCount(u[field]), 0)
    out.push({
      type: 'usage_update',
      sessionId,
      tokens: {
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        cacheReadTokens: sum('cacheReadInputTokens'),
        cacheCreationTokens: sum('cacheCreationInputTokens'),
        costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined,
      },
    })
  }
  if (str(m.subtype) !== 'success' || m.is_error === true) {
    /*
     * A failed ending has no `result`, only `errors` (sdk.d.ts `SDKResultError`); with both empty its subtype is the reason,
     * the only one an app's agent (M4 D-1) gets for `error_max_structured_output_retries`.
     */
    const errors = Array.isArray(m.errors) ? m.errors.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
    out.push({
      type: 'error',
      sessionId,
      error: { code: 'internal', message: str(m.result) || errors.join('\n') || `Turn failed: ${str(m.subtype)}`, retryable: true },
    })
  } else {
    // The answer of a turn that answered with a schema (M4 D-1) — it never arrives as text, only here (see protocol's turn_complete comment).
    out.push(m.structured_output === undefined ? { type: 'turn_complete', sessionId } : { type: 'turn_complete', sessionId, output: m.structured_output })
  }
  return out
}
