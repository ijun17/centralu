/**
 * What reading Cursor's plan usage depends on in the installed CLI (#2459; docs/agent-host/adapters/vendor-drift-checks.md),
 * as text its bundle carries, read in 2026.10.22-27dcf5f. A CLI that drops one fails `pnpm drift:cursor-usage`, not the
 * person's panel. Names move between chunk files from one version to the next (2026.11.22 put the method paths in
 * `connect-pool-worker.js`), so every file of the version is searched
 */
/** The one host the token is sent to: the bundle names it, so a moved backend fails the drift check before the panel */
export const DASHBOARD_HOST = 'api2.cursor.sh'
export const DASHBOARD_SERVICE = 'aiserver.v1.DashboardService/'

/** The methods `dashboard.ts` calls */
export const DASHBOARD_METHODS = ['GetCurrentPeriodUsage', 'GetPlanInfo'] as const
export type DashboardMethod = (typeof DASHBOARD_METHODS)[number]

export const CURSOR_USAGE_CONTRACT = {
  /** Where the token is (`os.ts` `cursorSignInStore`): its credential module's naming and paths */
  signIn: ['domain:"cursor"', '-access-token`', '-user`', '"auth.json"', 'toWindowsTitleCase', 'XDG_CONFIG_HOME', 'find-${'],
  host: [DASHBOARD_HOST],
  methods: DASHBOARD_METHODS.map((m) => DASHBOARD_SERVICE + m),
  /** The answers' descriptors: the field names their JSON is spelled from, and each field's number and type */
  answers: [
    'GetCurrentPeriodUsageResponse|1 billing_cycle_start 3|2 billing_cycle_end 3|3 plan_usage #0',
    'GetCurrentPeriodUsageResponse.PlanUsage|1 total_spend 5|2 included_spend 5|3 bonus_spend 5|4 remaining 5|5 limit 5|',
    '|12 auto_percent_used 1?|13 api_percent_used 1?|14 total_percent_used 1?',
    'GetPlanInfoResponse|1 plan_info #0?',
    'GetPlanInfoResponse.PlanInfo|1 plan_name 9|2 included_amount_cents 5|3 price 9?|4 billing_cycle_end 3?|',
  ],
} as const

/** The contract's texts that no file of the bundle carries */
export function missingFromBundle(files: Iterable<string>): string[] {
  const wanted = new Set<string>(Object.values(CURSOR_USAGE_CONTRACT).flat())
  for (const text of files) {
    for (const name of wanted) if (text.includes(name)) wanted.delete(name)
    if (wanted.size === 0) break
  }
  return [...wanted]
}
