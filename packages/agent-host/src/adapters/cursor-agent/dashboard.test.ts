import { describe, expect, it } from 'vitest'
import { askDashboard, DASHBOARD_URL } from './dashboard.js'
import { PERIOD_FREE_RECORDED } from './recordings/dashboard.test-helpers.js'
import { failureOf } from './usage.test-helpers.js'

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

  it('reads each status as its kind: 2xx answered, 401 signed out, other 4xx and 3xx refused, 429 and 5xx unreachable', async () => {
    await expect(askDashboard('GetPlanInfo', TOKEN, answering(299, '{}'))).resolves.toEqual({})
    const kinds: [number, string][] = [
      [401, 'signed-out'],
      [300, 'refused'],
      [400, 'refused'],
      [403, 'refused'],
      [404, 'refused'],
      [428, 'refused'],
      [429, 'unreachable'],
      [430, 'refused'],
      [499, 'refused'],
      [500, 'unreachable'],
      [503, 'unreachable'],
    ]
    for (const [status, kind] of kinds) {
      const f = await failureOf(askDashboard('GetPlanInfo', TOKEN, answering(status, '{"code":"x"}')))
      expect([status, f.kind]).toEqual([status, kind])
      expect(f.detail).toBe(`GetPlanInfo: HTTP ${status}`)
    }
  })

  it('says unreachable when the request fails or times out, unreadable when a 200 is not JSON', async () => {
    const timeout: typeof fetch = async () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    expect(await failureOf(askDashboard('GetCurrentPeriodUsage', TOKEN, timeout))).toMatchObject({ kind: 'unreachable', detail: 'GetCurrentPeriodUsage: TimeoutError' })
    const offline: typeof fetch = async () => Promise.reject(new TypeError('fetch failed'))
    expect(await failureOf(askDashboard('GetCurrentPeriodUsage', TOKEN, offline))).toMatchObject({ kind: 'unreachable', detail: 'GetCurrentPeriodUsage: TypeError' })
    expect(await failureOf(askDashboard('GetCurrentPeriodUsage', TOKEN, answering(200, '<html>')))).toMatchObject({ kind: 'unreadable' })
  })

  it('never puts the token in a failure', async () => {
    const leaky: typeof fetch = async () => Promise.reject(new Error(`bad header ${TOKEN}`))
    for (const f of [await failureOf(askDashboard('GetPlanInfo', TOKEN, leaky)), await failureOf(askDashboard('GetPlanInfo', TOKEN, answering(403, TOKEN)))]) {
      expect(`${f.message} ${f.detail}`).not.toContain('secret')
    }
  })
})
