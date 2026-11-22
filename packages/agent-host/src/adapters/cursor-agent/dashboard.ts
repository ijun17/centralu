import { DASHBOARD_SERVICE, type DashboardMethod } from './usage-contract.js'
import { CursorUsageFailure } from './usage-failure.js'

/** The service the CLI's own `/usage` asks (Connect JSON); the token is sent to this origin and nowhere else */
export const DASHBOARD_URL = `https://api2.cursor.sh/${DASHBOARD_SERVICE}`

/** Measured on Windows (Free plan): each method answers in about 0.7 s */
const ASK_MS = 5_000

/**
 * One call with the person's token, as the CLI makes it. A redirect is refused rather than followed, so the token cannot
 * be carried to another address; every failure is a kind (`usage-failure.ts`) whose detail is the status or the error's name
 */
export async function askDashboard(method: DashboardMethod, token: string, fetchFn: typeof fetch = fetch): Promise<unknown> {
  let status: number
  let text: string
  try {
    const res = await fetchFn(DASHBOARD_URL + method, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(ASK_MS),
    })
    status = res.status
    text = await res.text()
  } catch (e) {
    throw new CursorUsageFailure('unreachable', `${method}: ${e instanceof Error ? e.name : 'failed'}`)
  }
  if (status === 401) throw new CursorUsageFailure('signed-out', `${method}: HTTP 401`)
  if (status >= 500) throw new CursorUsageFailure('unreachable', `${method}: HTTP ${status}`)
  if (status < 200 || status >= 300) throw new CursorUsageFailure('refused', `${method}: HTTP ${status}`)
  try {
    const answer: unknown = JSON.parse(text)
    return answer
  } catch {
    throw new CursorUsageFailure('unreadable', `${method}: not JSON`)
  }
}
