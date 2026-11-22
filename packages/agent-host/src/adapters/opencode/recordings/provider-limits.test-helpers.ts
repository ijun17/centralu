/**
 * Real answers to OpenCode's own sign-ins (#2462), recorded on a Mac with opencode 1.19.4 on 2026-11-22, redacted: ids,
 * logins, orgs, tracking ids and endpoints removed; flags not read left out. Not yet read by a test
 */

/** `GET https://api.github.com/copilot_internal/user`, `Authorization: token <github-copilot access>`, status 200 */
export const COPILOT_USER_RECORDED = JSON.stringify({
  copilot_plan: 'individual',
  access_type_sku: 'free_educational_quota',
  can_upgrade_plan: true,
  token_based_billing: true,
  quota_reset_date: '2026-12-01',
  quota_reset_date_utc: '2026-12-01T00:00:00.000Z',
  quota_snapshots: {
    chat: { overage_count: 0, overage_permitted: false, percent_remaining: 100.0, quota_id: 'chat', quota_remaining: 0.0, unlimited: true, timestamp_utc: '2026-11-22T11:30:15.780Z', has_quota: true, quota_reset_at: 0, token_based_billing: true, credits_used: 0, overage_entitlement: 0, remaining: 0, entitlement: 0 },
    completions: { overage_count: 0, overage_permitted: false, percent_remaining: 100.0, quota_id: 'completions', quota_remaining: 0.0, unlimited: true, timestamp_utc: '2026-11-22T11:30:15.780Z', has_quota: true, quota_reset_at: 0, token_based_billing: true, credits_used: 0, overage_entitlement: 0, remaining: 0, entitlement: 0 },
    premium_interactions: { overage_count: 0, overage_permitted: false, percent_remaining: 100.0, quota_id: 'premium_interactions', quota_remaining: 200.0, unlimited: false, timestamp_utc: '2026-11-22T11:30:15.780Z', has_quota: true, quota_reset_at: 0, token_based_billing: true, credits_used: 0, overage_entitlement: 0, remaining: 200, entitlement: 200 },
  },
})

/** `GET https://chatgpt.com/backend-api/wham/usage` with OpenCode's `openai` access token, `expires` months past: status 401 */
export const WHAM_EXPIRED_RECORDED = JSON.stringify({
  error: { message: 'Could not find the appropriate key in your authentication token. Please try signing in again.', type: 'invalid_request_error', code: 'invalid_jwt', param: null },
  status: 401,
})
