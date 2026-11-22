import { describe, expect, it } from 'vitest'
import { askDashboard, DASHBOARD_URL } from './dashboard.js'
import { PERIOD_FREE_RECORDED } from './recordings/dashboard.test-helpers.js'

const TOKEN = 'header.payload-that-is-secret.signature'

function answering(status: number, body: string, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init: init ?? {} })
    return new Response(body, { status })
  }
}

describe("asking Cursor's dashboard with the person's token (#2459)", () => {
  it('posts an empty Connect JSON request to the fixed address, the token as bearer, refusing redirects', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    await expect(askDashboard('GetCurrentPeriodUsage', TOKEN, answering(200, PERIOD_FREE_RECORDED, calls))).resolves.toMatchObject({ billingCycleEnd: '1795522358574' })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.url).toBe(`${DASHBOARD_URL}GetCurrentPeriodUsage`)
    expect(new URL(call?.url ?? '').origin).toBe('https://api2.cursor.sh')
    expect(call?.init).toMatchObject({ method: 'POST', body: '{}', redirect: 'error' })
    expect(call?.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' })
  })
})
