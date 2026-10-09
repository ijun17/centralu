import type { UsageSnapshot, UsageWindow } from '@cc/protocol'

/**
 * Claude usage and limits (FR-9).
 *
 * **Only subscription limits are handled here.** `extra_usage` (extra paid credits) is out of
 * scope and is not read.
 *
 * The SDK marks this API as unstable in its own name
 * (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`).
 * We use it anyway, because it is still better than scraping files. If it disappears, the call
 * throws, so we **find out**, and at that point we only need to collapse that one card. Silently
 * showing a wrong number would be far worse.
 *
 * Measured windows (max plan):
 *   kind=session       group=session   8%  → 5-hour window
 *   kind=weekly_all    group=weekly   15%  → weekly, all models
 *   kind=weekly_scoped group=weekly    6%  → weekly, per model
 */

const LABEL: Record<string, string> = {
  session: '5 hours',
  weekly_all: 'Weekly',
  weekly_scoped: 'Weekly (per model)',
}

type RawLimit = {
  kind?: unknown
  group?: unknown
  percent?: unknown
  resets_at?: unknown
  scope?: { model?: { id?: unknown; display_name?: unknown } | null } | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Response shape to our shape. This is the boundary that keeps the tool's type from leaking out. */
export function toSnapshot(raw: unknown): UsageSnapshot {
  const res = (raw ?? {}) as { subscription_type?: unknown; rate_limits?: { limits?: unknown } | null }
  const limits = Array.isArray(res.rate_limits?.limits) ? (res.rate_limits.limits as RawLimit[]) : []

  const windows: UsageWindow[] = []
  for (const l of limits) {
    const kind = str(l.kind)
    const percent = num(l.percent)
    if (!kind || percent === null) continue
    const model = str(l.scope?.model?.display_name) ?? str(l.scope?.model?.id)
    windows.push({
      id: kind,
      label: LABEL[kind] ?? kind,
      percent: Math.max(0, Math.min(100, percent)),
      resetsAt: str(l.resets_at),
      scope: model,
    })
  }

  return {
    plan: str(res.subscription_type),
    windows,
    // Claude's plan limits have no daily window (measured). Leaving it empty makes the UI collapse that row.
    daily: [],
  }
}

/** Only the usage part of the SDK Query. */
export type UsageQuery = {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>
}

export const UNSUPPORTED =
  'The installed Claude Code SDK does not support usage queries (update the SDK)'

export async function readUsage(q: UsageQuery | null): Promise<UsageSnapshot> {
  const fn = q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
  if (typeof fn !== 'function') throw new Error(UNSUPPORTED)
  return toSnapshot(await fn.call(q))
}

/** How long one live session gets to answer before the next is asked (#481); the manager allows 15 s in all */
export const USAGE_ASK_MS = 4_000

/**
 * Usage from the first of `queries` that answers, newest first (#481).
 *
 * Any live session can answer for the account, but not every one does: one still re-attaching after
 * an update, an app's agent session, a query that is ending but not yet removed. Asking only the
 * newest one showed "Usage unavailable" while an older session was working fine. Each gets
 * `timeoutMs`; every failure is logged with its session so the next report can be traced.
 * When none answers, the newest one's reason is thrown.
 */
export async function readUsageFromAny(
  queries: readonly { query: UsageQuery; sessionId: string | null }[],
  { timeoutMs = USAGE_ASK_MS, log = (line: string) => console.error(line) }: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<UsageSnapshot> {
  let first: unknown = null
  for (const [i, { query, sessionId }] of queries.entries()) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        readUsage(query),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs)
        }),
      ])
    } catch (e) {
      first ??= e
      const why = e instanceof Error ? e.message : String(e)
      log(`[usage] claude: session ${sessionId ?? 'unknown'} could not read usage (${i + 1} of ${queries.length}): ${why}`)
      if (why === UNSUPPORTED) break // the same SDK serves every session
    } finally {
      clearTimeout(timer)
    }
  }
  throw first instanceof Error ? first : new Error('A running session is required to read usage')
}
