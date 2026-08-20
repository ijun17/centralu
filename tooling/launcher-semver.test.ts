import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { isNewer } from '../packaging/npm/centralu/bin/semver.mjs'

/**
 * Regression: `centralu update` on 0.1.0-beta.1 said "이미 최신입니다" while
 * 0.1.0-beta.2 sat on the registry. The old compare did `.split('.').map(Number)`,
 * so `0-beta` became NaN and the comparison died at the third slot. Every beta
 * was "already latest" to every other beta — found the day beta.2 shipped.
 */
describe('launcher version compare', () => {
  it('sees the next prerelease (the exact failure that shipped)', () => {
    expect(isNewer('0.1.0-beta.2', '0.1.0-beta.1')).toBe(true)
    expect(isNewer('0.1.0-beta.1', '0.1.0-beta.2')).toBe(false)
  })
  it('release outranks its own prereleases', () => {
    expect(isNewer('0.1.0', '0.1.0-beta.9')).toBe(true)
    expect(isNewer('0.1.0-beta.9', '0.1.0')).toBe(false)
  })
  it('numeric compare, not string compare (the case the old comment guarded)', () => {
    expect(isNewer('1.2.10', '1.2.9')).toBe(true)
    expect(isNewer('0.1.0-beta.10', '0.1.0-beta.9')).toBe(true)
  })
  it('equal is not newer', () => {
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.1.0-beta.2', '0.1.0-beta.2')).toBe(false)
  })
})
