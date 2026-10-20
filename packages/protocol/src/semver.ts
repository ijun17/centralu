/**
 * Version comparison for the in-app update check (issue #43).
 *
 * **This is a mirror, not a third implementation.** The launcher ships the same
 * comparison in `packaging/npm/centralu/bin/semver.mjs`, and the two are pinned to
 * each other by `tooling/launcher-semver.test.ts` — if one is edited without the
 * other, that test fails. Copying was the least bad option: the launcher's copy is
 * a plain `.mjs` inside a published npm package, and importing across that boundary
 * would drag the shim into the app bundle and past three build steps that have no
 * reason to know it exists.
 *
 * **Why it lives in `protocol`:** the host does the checking and the mock platform
 * has to answer the same way for the same inputs, and `protocol` is the only package
 * both are allowed to import (`eslint.config.js` boundaries). Putting it in the host
 * would have forced the mock to invent its own rule, which is precisely how the two
 * would drift — and drift here is invisible: every answer still looks plausible.
 *
 * Why not `.split('.').map(Number)`: that turns `0.1.0-beta.2` into [0, 1, NaN, 2],
 * and `NaN !== NaN` ends the comparison at the third slot with `NaN > NaN` = false —
 * so no beta ever saw the next beta. That is exactly how `centralu update` on
 * 0.1.0-beta.1 answered "already latest" while beta.2 sat on the registry (#42).
 *
 * That bug is also the reason this check exists in the *host* at all: the broken
 * compare shipped inside launchers that are now on people's machines, and no fix
 * can reach them retroactively. A check that runs here bypasses them entirely.
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
  // Both prereleases: compare dot-separated identifiers, numeric ones as numbers
  // (semver: numeric identifiers always rank below alphanumeric).
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

/*
 * Build metadata (`+sha`) is dropped first: semver ignores it for precedence, and left in, it turned `3+build5`
 * into NaN (and the `-` in `+build-5` into a prerelease). A leading `v` (`v1.2.3`, as a tag is written) is dropped
 * too, or the first slot is NaN. Either NaN ends the comparison as "not newer", the #42 failure again.
 */
function split(raw: string): [number[], string | null] {
  let v = raw.trim().replace(/^v/i, '')
  const plus = v.indexOf('+')
  if (plus !== -1) v = v.slice(0, plus)
  const dash = v.indexOf('-')
  const core = (dash === -1 ? v : v.slice(0, dash)).split('.').map(Number)
  const pre = dash === -1 ? null : v.slice(dash + 1)
  return [core, pre]
}

const LOCAL_BUILD = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*\.local\.[1-9]\d*$/

/** A maintainer's local build: `<base>.local.N`, strict SemVer, with a prerelease base and a positive N (`scripts/local-manifest.mjs`). */
export function isLocalBuildVersion(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.length <= 64 && LOCAL_BUILD.test(v)
}

/** The release a local build was cut from: `0.3.0-beta.7.local.2` is `0.3.0-beta.7`; any other version is itself (#689) */
export function releaseOf(v: string): string {
  return isLocalBuildVersion(v) ? v.slice(0, v.lastIndexOf('.local.')) : v
}

/**
 * Whether the copy `centralu install` made is kept rather than replaced by `target` (#645).
 *
 * npm is the source of truth for releases: any released version in the copy, even a higher one, is
 * replaced by the target, so a release pulled from `latest` (a dist-tag rollback) does not survive in
 * /Applications. The one exception is a maintainer's local build (`<base>.local.N`, `pnpm
 * local-update`, #610/#613) newer than the target: it waits there for "Apply now", and putting the
 * release it was cut from over it would undo it. The copy's version must be well-formed SemVer in
 * that exact shape; anything unreadable or malformed (`garbage`, `$(VERSION)`, an empty file) is
 * replaced, so a corrupt plist or version file can never block every later update.
 *
 * Mirrored in the launcher (`keepsInstalledCopy` in `packaging/npm/centralu/bin/semver.mjs`), where
 * `centralu install` applies the same rule by itself, and pinned to it by `tooling/launcher-semver.test.ts`.
 */
export function keepsInstalledCopy(target: string, copyVersion: string | null | undefined): boolean {
  return typeof copyVersion === 'string' && isLocalBuildVersion(copyVersion) && isNewerVersion(copyVersion, target)
}
