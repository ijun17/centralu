/**
 * Version comparison for the launcher's update check.
 *
 * Lives in its own file so it can be tested (tooling/launcher-semver.test.ts):
 * the launcher itself runs commands at import time and cannot be imported by a
 * test. package.json "files" lists the whole bin/ directory, so this ships
 * automatically — but note npm silently drops anything "files" does not cover,
 * and an unshipped import only crashes on users' machines.
 *
 * Why not `.split('.').map(Number)`: that turns `0.1.0-beta.2` into
 * [0, 1, NaN, 2], and `NaN !== NaN` ends the comparison at the third slot with
 * `NaN > NaN` = false — so no beta ever saw the next beta. That is exactly how
 * `centralu update` on 0.1.0-beta.1 answered "이미 최신입니다" while beta.2 sat
 * on the registry (found the day beta.2 shipped).
 */
export function isNewer(a, b) {
  const [coreA, preA] = split(String(a))
  const [coreB, preB] = split(String(b))
  for (let i = 0; i < 3; i++) {
    const x = coreA[i] ?? 0
    const y = coreB[i] ?? 0
    if (x !== y) return x > y
  }
  // Same core: a release outranks any prerelease of it (1.0.0 > 1.0.0-beta.9).
  if (preA === null && preB === null) return false
  if (preA === null) return true
  if (preB === null) return false
  // Both prereleases: compare dot-separated identifiers, numeric ones as
  // numbers (semver: numeric identifiers always rank below alphanumeric).
  const ia = preA.split('.')
  const ib = preB.split('.')
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i]
    const y = ib[i]
    if (x === undefined) return false // shorter prerelease ranks lower
    if (y === undefined) return true
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx > ny
    } else if (nx !== null) {
      return false // numeric < alphanumeric
    } else if (ny !== null) {
      return true
    } else if (x !== y) {
      return x > y
    }
  }
  return false
}

/**
 * Whether the copy in /Applications is a different app than the one this package carries.
 *
 * `npm i -g centralu` replaces the package and nothing else. That is deliberate — this
 * project does not write into someone's /Applications unless asked (`centralu install`) —
 * but the cost is that the two drift apart in silence, and the copy is the one people
 * actually click. So the launcher says so. It still does not act.
 *
 * Not `isNewer`. Drift in either direction is worth a line: a copy *newer* than the package
 * means an update went backwards, which is more surprising, not less.
 *
 * Lives beside `isNewer` because it ships and is tested for the same reason — a launcher
 * already on someone's machine cannot be corrected later. 0.1.0-beta.1 is still out there
 * answering "이미 최신입니다" and always will be.
 */
export function copyDiffers(pkgVersion, copyVersion) {
  return typeof copyVersion === 'string' && copyVersion !== '' && copyVersion !== pkgVersion
}

function split(v) {
  const dash = v.indexOf('-')
  const core = (dash === -1 ? v : v.slice(0, dash)).split('.').map(Number)
  const pre = dash === -1 ? null : v.slice(dash + 1)
  return [core, pre]
}
