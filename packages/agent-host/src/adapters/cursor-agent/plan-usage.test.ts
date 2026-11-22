import { describe, expect, it } from 'vitest'
import type { UsageSnapshot } from '@cc/protocol'
import { NO_LIMITS, type LimitsAnswer } from '../contract.js'
import { cursorPlanUsage, PERIOD, PLAN, planUsageAnswer, type PlanUsageDeps } from './plan-usage.js'
import { PERIOD_FREE_RECORDED, PERIOD_PAID_HAND_MADE, PLAN_FREE_RECORDED, PLAN_PAID_HAND_MADE } from './recordings/dashboard.test-helpers.js'
import { LimitsFailure } from '../token-limits/failure.js'
import { failureOf } from '../token-limits/failure.test-helpers.js'
import { jwt } from './usage.test-helpers.js'
import { CURSOR_USAGE_CONTRACT } from './usage-contract.js'

const json = (text: string): unknown => JSON.parse(text)
const RESETS = new Date(1795522358574).toISOString()
const NOW = 1_790_000_000_000

const TOKEN = jwt({ sub: 'person', exp: NOW / 1000 + 3600 })

/** The answer of a plan that has a limit */
function limited(answer: LimitsAnswer): UsageSnapshot {
  if (answer === NO_LIMITS) throw new Error('the plan has no limit')
  return answer
}
const planUsageSnapshot = (period: unknown, plan: unknown) => limited(planUsageAnswer(period, plan))

describe("Cursor's plan usage from its dashboard's answers (#2459)", () => {
  it('reads a paid plan as the CLI shows it: Included, Auto and API, each resetting at the cycle end, the plan by name', () => {
    expect(planUsageSnapshot(json(PERIOD_PAID_HAND_MADE), json(PLAN_PAID_HAND_MADE))).toEqual({
      plan: 'Pro',
      windows: [
        { id: 'included', label: 'Included', percent: 35, resetsAt: RESETS, scope: null },
        { id: 'auto', label: 'Auto', percent: 20, resetsAt: RESETS, scope: null },
        { id: 'api', label: 'API', percent: 61.5, resetsAt: RESETS, scope: null },
      ],
      daily: [],
    })
  })

  it('says the recorded Free plan has no limits, never 0%: its limit is 0 while prompts are refused as over it', () => {
    expect(planUsageAnswer(json(PERIOD_FREE_RECORDED), json(PLAN_FREE_RECORDED))).toBe(NO_LIMITS)
  })

  it('says no limits when the answer has no planUsage at all', () => {
    expect(planUsageAnswer({ billingCycleEnd: '1' }, null)).toBe(NO_LIMITS)
  })

  it('takes the included spend of the limit when the total percent is absent, as the CLI does', () => {
    const snap = planUsageSnapshot({ planUsage: { limit: 2000, includedSpend: 500 } }, null)
    expect(snap.windows).toEqual([{ id: 'included', label: 'Included', percent: 25, resetsAt: null, scope: null }])
    expect(planUsageSnapshot({ planUsage: { limit: 2000 } }, null).windows[0]?.percent).toBe(0)
  })

  it('leaves out a bucket the answer does not carry rather than drawing it as 0', () => {
    const ids = (usage: object) => planUsageSnapshot({ planUsage: { limit: 1, totalPercentUsed: 5, ...usage } }, null).windows.map((w) => w.id)
    expect(ids({})).toEqual(['included'])
    expect(ids({ autoPercentUsed: 0 })).toEqual(['included', 'auto'])
    expect(ids({ apiPercentUsed: 3 })).toEqual(['included', 'api'])
  })

  it('keeps a percent within 0 and 100', () => {
    const percents = planUsageSnapshot({ planUsage: { limit: 1, totalPercentUsed: 140, autoPercentUsed: -2 } }, null).windows.map((w) => w.percent)
    expect(percents).toEqual([100, 0])
  })

  it("resets at the cycle's end, else the plan's, else says it does not know", () => {
    const resets = (period: object, plan: unknown) => planUsageSnapshot({ planUsage: { limit: 1 }, ...period }, plan).windows[0]?.resetsAt
    expect(resets({ billingCycleEnd: '1795522358574' }, { planInfo: { billingCycleEnd: '1' } })).toBe(RESETS)
    expect(resets({ billingCycleEnd: '0' }, { planInfo: { billingCycleEnd: '1795522358574' } })).toBe(RESETS)
    expect(resets({}, { planInfo: { billingCycleEnd: 1795522358574 } })).toBe(RESETS)
    expect(resets({}, null)).toBeNull()
    // In nanoseconds, past what a date can hold: the percents stay, the reset is not known
    expect(resets({ billingCycleEnd: '1795522358574000000' }, null)).toBeNull()
  })

  it('has no plan name when the plan answer is missing, of another shape or blank', () => {
    const plan = (p: unknown) => planUsageSnapshot({ planUsage: { limit: 1 } }, p).plan
    expect(plan(null)).toBeNull()
    expect(plan({ planInfo: 'Pro' })).toBeNull()
    expect(plan({ planInfo: { planName: '  ' } })).toBeNull()
    expect(plan({ planInfo: { planName: ' Pro ' } })).toBe('Pro')
  })

  it('says the answer could not be read when its shape changed', async () => {
    for (const period of [null, 'text', { planUsage: 'x' }, { planUsage: { limit: '2000' } }, { billingCycleEnd: 'soon', planUsage: { limit: 1 } }]) {
      expect((await failureOf(() => planUsageSnapshot(period, null))).kind).toBe('unreadable')
    }
  })

  it('reads only fields the drift contract names, so a renamed field fails the drift check first', () => {
    const descriptors = CURSOR_USAGE_CONTRACT.answers.join('|')
    const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
    const keys = [...Object.keys(PERIOD.shape), ...Object.keys(PERIOD.shape.planUsage.unwrap().shape), ...Object.keys(PLAN.shape), ...Object.keys(PLAN.shape.planInfo.unwrap().shape)]
    for (const key of keys) expect(descriptors).toContain(` ${snake(key)} `)
  })
})

describe("Cursor's listUsage: token, both methods, a reason per failure kind (#2459)", () => {
  function deps(over: Partial<PlanUsageDeps> = {}): PlanUsageDeps & { asked: string[]; lines: string[] } {
    const asked: string[] = []
    const lines: string[] = []
    return {
      asked,
      lines,
      token: async () => TOKEN,
      ask: async (method) => {
        asked.push(method)
        return json(method === 'GetPlanInfo' ? PLAN_PAID_HAND_MADE : PERIOD_PAID_HAND_MADE)
      },
      now: () => NOW,
      log: (line) => lines.push(line),
      ...over,
    }
  }

  it('asks both methods with the token and answers the snapshot, or no limits for a Free plan, with no log line', async () => {
    const d = deps()
    const snap = limited(await cursorPlanUsage(d)())
    expect(snap.plan).toBe('Pro')
    expect(d.asked.sort()).toEqual(['GetCurrentPeriodUsage', 'GetPlanInfo'])
    const free = deps({ ask: async (method) => json(method === 'GetPlanInfo' ? PLAN_FREE_RECORDED : PERIOD_FREE_RECORDED) })
    expect(await cursorPlanUsage(free)()).toBe(NO_LIMITS)
    expect([...d.lines, ...free.lines]).toEqual([])
  })

  it('still answers the limits when only the plan answer fails', async () => {
    const d = deps({ ask: async (method) => (method === 'GetPlanInfo' ? Promise.reject(new LimitsFailure('refused', 'HTTP 403')) : json(PERIOD_PAID_HAND_MADE)) })
    const snap = limited(await cursorPlanUsage(d)())
    expect(snap.plan).toBeNull()
    expect(snap.windows).toHaveLength(3)
  })

  it('asks nothing with a token past its exp, and says to sign in again; a token not past it, or with no exp, is sent', async () => {
    const expired = deps({ token: async () => jwt({ exp: NOW / 1000 }) })
    await expect(cursorPlanUsage(expired)()).rejects.toMatchObject({ kind: 'expired', message: 'Sign in to Cursor again to see its usage' })
    expect(expired.asked).toEqual([])
    for (const token of [jwt({ exp: NOW / 1000 + 1 }), jwt({ sub: 'person' }), 'not-a-jwt']) {
      const d = deps({ token: async () => token })
      await cursorPlanUsage(d)()
      expect(d.asked).toContain('GetCurrentPeriodUsage')
    }
  })

  it('throws each failure as its kind, its message the reason shown', async () => {
    const d = deps({ token: async () => Promise.reject(new LimitsFailure('no-token', 'auth file ENOENT')) })
    await expect(cursorPlanUsage(d)()).rejects.toMatchObject({ kind: 'no-token', message: "Cursor's sign-in could not be read on this computer" })
    const odd = deps({ ask: async () => Promise.reject(new TypeError('boom')) })
    await expect(cursorPlanUsage(odd)()).rejects.toMatchObject({ kind: 'unreadable', message: "Cursor's usage answer could not be read" })
  })
})
