import { z } from 'zod'
import type { UsageSnapshot, UsageWindow } from '@cc/protocol'
import type { DashboardMethod } from './usage-contract.js'
import { tokenExpiry } from './sign-in-token.js'
import { CursorUsageFailure, type CursorUsageFailureKind } from './usage-failure.js'

/** Connect JSON writes an int64 as a decimal string; a number is taken too */
const EPOCH_MS = z.union([z.string().regex(/^\d+$/).transform(Number), z.number()])

/**
 * The fields read of `GetCurrentPeriodUsage` (descriptor: `usage-contract.ts`). Proto3 JSON leaves out a field at its
 * default, so an absent `limit` is 0; the percents have presence (`optional double`), so an absent one is not a 0
 */
export const PERIOD = z.object({
  billingCycleEnd: EPOCH_MS.optional(),
  planUsage: z
    .object({
      limit: z.number().optional(),
      includedSpend: z.number().optional(),
      totalPercentUsed: z.number().optional(),
      autoPercentUsed: z.number().optional(),
      apiPercentUsed: z.number().optional(),
    })
    .optional(),
})

export const PLAN = z.object({ planInfo: z.object({ planName: z.string().optional(), billingCycleEnd: EPOCH_MS.optional() }).optional() })

/**
 * The CLI's `/usage` as numbers (its bundle, 2026.10.22: total percent, else included spend of the limit; the reset at the
 * cycle's end, else the plan's). A plan whose limit is 0 has nothing a percent could be of: measured on a Free plan, the
 * answer says 0% while prompts are refused as over the limit, so it is said as "no limit reported" and never as 0%
 */
export function planUsageSnapshot(period: unknown, plan: unknown): UsageSnapshot {
  const p = PERIOD.safeParse(period)
  if (!p.success) throw new CursorUsageFailure('unreadable', 'GetCurrentPeriodUsage: unexpected shape')
  const usage = p.data.planUsage
  const limit = usage?.limit ?? 0
  if (!usage || limit <= 0) throw new CursorUsageFailure('no-limit', usage ? 'planUsage.limit is 0' : 'no planUsage')
  const info = PLAN.safeParse(plan).data?.planInfo
  const end = p.data.billingCycleEnd || info?.billingCycleEnd || 0
  // A date out of range loses the reset, not the percents
  const at = new Date(end)
  const resetsAt = end > 0 && Number.isFinite(at.getTime()) ? at.toISOString() : null
  const window = (id: string, label: string, percent: number | undefined): UsageWindow[] =>
    percent === undefined || !Number.isFinite(percent) ? [] : [{ id, label, percent: Math.max(0, Math.min(100, percent)), resetsAt, scope: null }]
  return {
    plan: info?.planName?.trim() || null,
    windows: [
      ...window('included', 'Included', usage.totalPercentUsed ?? ((usage.includedSpend ?? 0) / limit) * 100),
      ...window('auto', 'Auto', usage.autoPercentUsed),
      ...window('api', 'API', usage.apiPercentUsed),
    ],
    daily: [],
  }
}

export type PlanUsageDeps = {
  token(): Promise<string>
  ask(method: DashboardMethod, token: string): Promise<unknown>
  now(): number
  log(line: string): void
}

/**
 * Cursor's `listUsage` (#2459): the token read for this request, both methods asked at once as the CLI's `/usage` asks
 * them, the plan's name optional. Any failure is thrown as its kind, whose message is the reason the panel shows; host.log
 * gets one line for each kind the first time it happens in this process
 */
export function cursorPlanUsage(deps: PlanUsageDeps): () => Promise<UsageSnapshot> {
  const logged = new Set<CursorUsageFailureKind>()
  return async () => {
    try {
      const token = await deps.token()
      const expiry = tokenExpiry(token)
      if (expiry !== null && expiry <= deps.now()) throw new CursorUsageFailure('signed-out', 'token past its exp')
      const [period, plan] = await Promise.all([deps.ask('GetCurrentPeriodUsage', token), deps.ask('GetPlanInfo', token).catch(() => null)])
      return planUsageSnapshot(period, plan)
    } catch (e) {
      const failure = e instanceof CursorUsageFailure ? e : new CursorUsageFailure('unreadable', e instanceof Error ? e.name : 'failed')
      if (!logged.has(failure.kind)) {
        logged.add(failure.kind)
        deps.log(`[usage] cursor: plan usage not read (${failure.kind}: ${failure.detail})`)
      }
      throw failure
    }
  }
}
