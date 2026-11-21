/**
 * Version comparison for the update check, a copy of packaging/npm/centralu/bin/semver.mjs (a published package's plain
 * .mjs, which the app bundle does not import) pinned by tooling/launcher-semver.test.ts. In protocol so the host and the
 * mock platform answer alike; the host checks because installed launchers keep their copy, which compared prereleases
 * as NaN (#42, docs/runtime-lessons/quit-relaunch-update.md UP10).
 */
export function isNewerVersion(a: string, b: string): boolean {
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
  // SemVer: numeric identifiers compare as numbers and rank below alphanumeric ones
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

// Build metadata (`+sha`, ignored by semver for precedence) and a tag's leading `v` are dropped first: either left in
// makes a NaN slot, which ends the comparison as "not newer" (#42); the `-` in `+build-5` would read as a prerelease.
function split(raw: string): [number[], string | null] {
  let v = raw.trim().replace(/^v/i, '')
  const plus = v.indexOf('+')
  if (plus !== -1) v = v.slice(0, plus)
  const dash = v.indexOf('-')
  const core = (dash === -1 ? v : v.slice(0, dash)).split('.').map(Number)
  const pre = dash === -1 ? null : v.slice(dash + 1)
  return [core, pre]
}

const LOCAL_BUILD =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*\.local\.[1-9]\d*$/

/** The oldest peer this build works with (docs/protocol.md §4) */
export const MIN_SUPPORTED_VERSION = '0.1.0-beta.45'

/**
 * A local build counts as the release it was cut from. A build from source (`0.0.0-dev`) or a version that is no
 * release is not judged: it is the current code.
 */
export function isSupportedVersion(v: string): boolean {
  if (!/^\d+\.\d+\.\d+/.test(v) || v.startsWith('0.0.0')) return true
  return !isNewerVersion(MIN_SUPPORTED_VERSION, releaseOf(v))
}

/** A maintainer's local build: `<base>.local.N`, strict SemVer, with a prerelease base and a positive N (`scripts/local-manifest.mjs`). */
export function isLocalBuildVersion(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.length <= 64 && LOCAL_BUILD.test(v)
}

/** `0.3.0-beta.7.local.2` is `0.3.0-beta.7`; any other version is itself */
export function releaseOf(v: string): string {
  return isLocalBuildVersion(v) ? v.slice(0, v.lastIndexOf('.local.')) : v
}

/**
 * Whether `centralu install`'s copy is kept over `target` (#645): only a local build newer than it, waiting for
 * "Apply now". Any release, even a higher one, is replaced (npm decides, so a dist-tag rollback lands), and so is a
 * malformed version, so a corrupt version file never blocks updates. Mirrored in the launcher like `isNewerVersion`.
 */
export function keepsInstalledCopy(target: string, copyVersion: string | null | undefined): boolean {
  return (
    typeof copyVersion === 'string' && isLocalBuildVersion(copyVersion) && isNewerVersion(copyVersion, target)
  )
}
