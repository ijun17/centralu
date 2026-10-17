import { asObj, finite } from '../../json-value.js'
import { type NormalizedEvent, type RequestInput } from '@cc/protocol'

/**
 * The model request a `thread/tokenUsage/updated` closes, for prompt cache accounting (docs/agent-host.md §6.1).
 *
 * `last` is the most recent request (`ThreadTokenUsage`, generated/v2), and `total` grows with every request. A
 * notification whose `total` has not moved since the previous one repeats a request already counted (Codex sends the
 * token count again with other updates), so it gives nothing. Codex counts cached input inside `inputTokens`, as in
 * the `usage_update` beside it, and says nothing of writing to the cache: `cacheCreationTokens` stays absent rather
 * than 0. (codex-cli 0.160's breakdown has a `cacheWriteInputTokens` field; whether it is ever non-zero for OpenAI
 * models, and whether `inputTokens` includes it, is not measured, so it is not read.)
 */
export class CodexRequestInputs {
  private lastTotal: string | null = null

  take(params: unknown): RequestInput | undefined {
    const usage = asObj(asObj(params).tokenUsage)
    const total = asObj(usage.total)
    const at = [total.totalTokens, total.inputTokens, total.cachedInputTokens, total.outputTokens].map((v) => finite(v) ?? 0).join(',')
    if (at === this.lastTotal) return undefined
    this.lastTotal = at
    const last = asObj(usage.last)
    const input = finite(last.inputTokens) ?? 0
    const cached = Math.min(finite(last.cachedInputTokens) ?? 0, input)
    if (input <= 0) return undefined
    return { inputTokens: input - cached, cacheReadTokens: cached }
  }
}

/** A `thread/tokenUsage/updated` notification's events: the running reading, and how full the window is */
export function tokenUsageEvents(sessionId: string, p: Record<string, unknown>): NormalizedEvent[] {
  const usage = asObj(asObj(p.tokenUsage).total)
  /*
   * Context occupancy comes from `last`, not `total`.
   *
   * `ThreadTokenUsage` carries both (generated/v2/ThreadTokenUsage.ts): `total` is what
   * the thread has spent since it began, `last` is the most recent turn. Reading `total`
   * put a running sum against a fixed window, so the gauge climbed forever — it reached
   * **149,084%** on a real session (1,235,017,921 against a 828,400 window) before this
   * was noticed. Cumulative spend is a billing number and stays with `usage_update`;
   * how full the window is describes one request.
   */
  const lastTurn = asObj(asObj(p.tokenUsage).last)
  const input = finite(usage.inputTokens) ?? 0
  const output = finite(usage.outputTokens) ?? 0
  const cached = finite(usage.cachedInputTokens) ?? 0
  /*
   * The field is `modelContextWindow`, on the tokenUsage object — see
   * generated/v2/ThreadTokenUsage.ts. We read `contextWindow` for a long time, found
   * nothing, and skipped the event: `usage_update` still went out, so tokens worked
   * and only the percentage was missing. The adapter meanwhile declared
   * `contextUsage: 'exact'`, so the app promised a number it never sent.
   *
   * The older names stay in the chain because a running Codex may predate the rename,
   * and reading a field that isn't there costs nothing.
   */
  const usageObj = asObj(p.tokenUsage)
  const window =
    finite(usageObj.modelContextWindow) ?? finite(p.contextWindow) ?? finite(usageObj.contextWindow)
  const events: NormalizedEvent[] = [
    /*
     * Codex counts cached input inside `inputTokens` (its `totalTokens` is input + output). The protocol's
     * TokenUsage keeps the two apart, as Anthropic does, so the uncached part is what goes in `inputTokens`.
     */
    { type: 'usage_update', sessionId, tokens: { inputTokens: Math.max(0, input - cached), outputTokens: output, cacheReadTokens: cached, cacheCreationTokens: 0 } },
  ]
  const occupied = finite(lastTurn.totalTokens)
  if (window && occupied !== undefined && occupied <= window) {
    events.push({ type: 'context_update', sessionId, used: occupied, window, exactness: 'exact' })
  } else if (window && occupied !== undefined) {
    /*
     * More tokens than the window holds is not a reading, it is a misread field — the
     * shape this bug took the first time. Emit nothing and say so: a blank gauge is
     * honest, and 149,084% was not.
     */
    warnImpossibleContext(occupied, window)
  } else {
    // Say it out loud. A silent skip here is what let a renamed field hide for weeks.
    warnMissingContextWindow(usageObj)
  }
  return events
}

/*
 * Warn once per process: this fires on every token update of every Codex session, and a
 * repeating line would be noise rather than a signal.
 */
let warnedContextWindow = false
function warnMissingContextWindow(usage: Record<string, unknown>): void {
  if (warnedContextWindow) return
  warnedContextWindow = true
  console.error(
    '[codex] token usage carried no context window — the context gauge will stay empty. ' +
      `Fields present: ${Object.keys(usage).join(', ') || '(none)'}`,
  )
}

/** Warn once per process — this would otherwise repeat on every turn of every session. */
let warnedImpossible = false
function warnImpossibleContext(used: number, window: number): void {
  if (warnedImpossible) return
  warnedImpossible = true
  console.error(
    `[codex] context reading exceeds the window (${used} of ${window}) — gauge left empty. ` +
      'A used-vs-window ratio above 1 means the wrong field was read, not a full context.',
  )
}

/**
 * Reset the warn-once flags. Tests only.
 *
 * The flags exist so a misread field doesn't print on every turn of every session, but that
 * makes them process state: the second test to check for a warning would find it already
 * spent and pass for the wrong reason. Same shape as `__setSessionApiForTest` in the Claude
 * adapter — production keeps the behaviour, tests get a way to start clean.
 */
export function __resetWarningsForTest(): void {
  warnedContextWindow = false
  warnedImpossible = false
}
