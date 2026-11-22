import { describe, expect, it } from 'vitest'
import { cursorSignInStore } from '../../os.js'
import { DASHBOARD_URL } from './dashboard.js'
import { CURSOR_USAGE_CONTRACT, missingFromBundle } from './usage-contract.js'

const ALL = Object.values(CURSOR_USAGE_CONTRACT).flat()

describe("the drift contract of Cursor's usage read (#2459)", () => {
  it('finds every name when they are split across the files of a version', () => {
    const half = Math.ceil(ALL.length / 2)
    expect(missingFromBundle([`a ${ALL.slice(0, half).join(' ')}`, `b ${ALL.slice(half).join(' ')}`])).toEqual([])
  })

  it('names what no file carries', () => {
    const [dropped, ...rest] = ALL
    expect(missingFromBundle([rest.join(' ')])).toEqual([dropped])
    expect(missingFromBundle([])).toEqual(ALL)
  })

  it('names the methods the request makes, at the one address the token goes to', () => {
    expect(CURSOR_USAGE_CONTRACT.methods).toEqual(['aiserver.v1.DashboardService/GetCurrentPeriodUsage', 'aiserver.v1.DashboardService/GetPlanInfo'])
    expect(DASHBOARD_URL).toBe('https://api2.cursor.sh/aiserver.v1.DashboardService/')
  })

  it("names the Keychain item and the folder the sign-in store derives from the CLI's domain", () => {
    const mac = cursorSignInStore('cursor', {}, '/Users/p', 'darwin')
    expect(CURSOR_USAGE_CONTRACT.signIn).toContain('domain:"cursor"')
    expect(mac.keychain?.service.endsWith(CURSOR_USAGE_CONTRACT.signIn[1].slice(0, -1))).toBe(true)
    expect(mac.keychain?.account.endsWith(CURSOR_USAGE_CONTRACT.signIn[2].slice(0, -1))).toBe(true)
  })
})
