import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { isNewer } from '../packaging/npm/centralu/bin/semver.mjs'
import { isNewerVersion } from '../packages/protocol/src/semver.js'

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

/**
 * The app checks for updates itself now (issue #43), and it cannot use the launcher's copy
 * of this function: that one is a `.mjs` inside a published npm package, not a workspace
 * dependency. So `packages/protocol/src/semver.ts` mirrors it — and a mirror nobody checks
 * is just two implementations with a nice name.
 *
 * **This is the check.** Not "both handle prereleases" — that is the same test written
 * twice, and it would pass while the two disagreed about anything neither test names.
 * The pairs below are compared answer to answer, so any divergence fails here rather than
 * showing up as an app that is sure it is up to date while `centralu update` disagrees.
 */
describe('the app-side mirror and the launcher agree', () => {
  const VERSIONS = [
    '0.1.0-beta.1',
    '0.1.0-beta.2',
    '0.1.0-beta.10',
    '0.1.0-beta',
    '0.1.0-rc.1',
    '0.1.0',
    '0.1.1',
    '0.2.0',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0',
    '1.2.9',
    '1.2.10',
    '10.0.0',
  ]

  it('answers identically for every ordered pair', () => {
    const disagreements: string[] = []
    for (const a of VERSIONS) {
      for (const b of VERSIONS) {
        if (isNewerVersion(a, b) !== isNewer(a, b)) disagreements.push(`${a} vs ${b}`)
      }
    }
    expect(disagreements).toEqual([])
  })

  /**
   * The shipped failure, asked of the copy that now decides whether to update (#42).
   * Stated separately from the pairwise sweep because this one is the reason both exist:
   * a sweep that starts agreeing on two identically broken implementations still passes.
   */
  it('the app-side copy sees the next prerelease', () => {
    expect(isNewerVersion('0.1.0-beta.2', '0.1.0-beta.1')).toBe(true)
    expect(isNewerVersion('0.1.0-beta.1', '0.1.0-beta.2')).toBe(false)
  })
})
