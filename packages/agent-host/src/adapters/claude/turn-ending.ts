import type { NormalizedEvent } from '@cc/protocol'
import { tokenCount } from '../token-usage.js'
import { str, type Json } from './json.js'

/** How a turn ends or is held up (`normalizeMessage`): a usage limit, and the turn's result. */

/*
 * A limit (M0 finding: `rate_limit_event.rate_limit_info`).
 *
 * **Only an actual block counts as a limit.** There are three statuses (SDK:
 * 'allowed' | 'allowed_warning' | 'rejected'). While this checked `!== 'allowed'`,
 * `allowed_warning` — "getting close, but still going through" — was treated the same as
 * `rejected`, and a limit banner appeared on a session that was never actually blocked
 * (dogfooding: "it showed up in the tab even though the limit had not been reached").
 *
 * The Codex adapter fixed the same mistake first and cited this file as its own reference, but
 * the reference itself was wrong. Codex has it right now — this only reacts to the explicit
 * signal the tool actually gives. The warning is not discarded: the usage window
 * (agents.usage) still shows remaining headroom as a percentage. The banner says "cannot be
 * used right now", and showing it while it can still be used would make that a lie.
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
     * Context usage is never computed here.
     *
     * `modelUsage` is a **session-wide accumulation**. Re-reading the cache
     * (`cacheReadInputTokens`) adds to it every single turn, so summing it here quickly exceeds
     * the window size — this actually showed up as "context 533%". What is currently in the
     * window is instead known by the SDK's own `getContextUsage()`, which the adapter asks at
     * the end of a turn to emit `context_update`.
     */
    /*
     * **Every model is summed.** `modelUsage` has one entry per model (sdk.d.ts: meant to
     * count tokens and cost across everything, including internal calls like the main loop, a
     * subagent, or compaction), and a single turn can involve more than one model — a small
     * model used to title something or shorten a tool result can appear before the main model
     * does. While only the first entry was read, an app-requested agent's own run was recorded
     * as "1.1k tokens": the log lines were 1108/13 and 1038/16, while the model actually seen in
     * the CLI log (Opus) used only 200/363 output tokens against 24k-80k cache input tokens.
     * What got recorded was the small model's share.
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
     * A failed ending has no `result`, only `errors` (a list of strings) (sdk.d.ts
     * `SDKResultError`). If both are empty, this still carries at least the name of how it
     * ended — when an app-requested agent (M4 D-1) never manages to match its structured output
     * (`error_max_structured_output_retries`), that name is the only reason the app ever
     * receives.
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
