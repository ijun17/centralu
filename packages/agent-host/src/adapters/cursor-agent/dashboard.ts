import { askFixed } from '../token-limits/ask.js'
import { DASHBOARD_SERVICE, type DashboardMethod } from './usage-contract.js'

/** The service the CLI's own `/usage` asks (Connect JSON); the token is sent to this origin and nowhere else */
export const DASHBOARD_URL = `https://api2.cursor.sh/${DASHBOARD_SERVICE}`

/** One call with the person's token, as the CLI makes it */
export function askDashboard(method: DashboardMethod, token: string, fetchFn: typeof fetch = fetch): Promise<unknown> {
  return askFixed(
    method,
    DASHBOARD_URL + method,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: '{}' },
    fetchFn,
  )
}
