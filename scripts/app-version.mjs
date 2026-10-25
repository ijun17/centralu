/**
 * The one answer to "which version is this build" (#1501). Git holds no release version: the
 * carriers (`version.generated.ts`, `tauri.conf.json`, the npm manifests) are committed as the
 * placeholder `0.0.0-dev`, and a packaging build stamps what this resolves into them
 * (`stamp-version.mjs`).
 *
 * In order:
 *   1. `CENTRALU_VERSION` from the environment: the release workflow sets it from the tag,
 *      `local-update` to `<base>.local.N`.
 *   2. The newest release tag reachable from HEAD (`git describe --tags --abbrev=0 --match 'v[0-9]*'`),
 *      without the `v`: what a local build of main was cut from, as `brand.ts` said before.
 *   3. Nothing: a packaging build refuses (a shallow checkout, a fork, a tarball). Only a
 *      development entry point asks for `fallback`, and gets the placeholder.
 *
 * Dependency-free JavaScript: the release scripts, `bundle.mjs`, the dev build of a linked machine
 * and the local signing workflow all read it.
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** What every committed carrier holds; never a release (`tooling/brand.test.ts`) */
export const PLACEHOLDER = '0.0.0-dev'

/** SemVer 2.0 without build metadata: Rust's content check rejects `+meta` (content-verify `version.rs`) */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

/** `version` when it can be an app version, else throws naming `what` */
export function checkAppVersion(version, what = 'the version') {
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(`${what} is not a version (SemVer, no build metadata): ${JSON.stringify(version)}`)
  }
  if (version.split(/[.-]/).some((p) => /^\d+$/.test(p) && !Number.isSafeInteger(Number(p)))) throw new Error(`${what} has a number too large: ${version}`)
  return version
}

/** The newest release tag reachable from HEAD in `cwd`, without its `v`; null when there is none (or no git) */
export function releaseTag(cwd = ROOT) {
  let tag
  try {
    tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
  return checkAppVersion(tag.slice(1), `the release tag ${tag}`)
}

/**
 * The version a build in `cwd` carries (the order above). Throws when there is neither
 * `CENTRALU_VERSION` nor a release tag, unless `fallback` (development only) asks for the
 * placeholder instead.
 */
export function resolveAppVersion({ env = process.env, cwd = ROOT, fallback = false } = {}) {
  const set = env.CENTRALU_VERSION
  if (set) return checkAppVersion(set, 'CENTRALU_VERSION')
  const tag = releaseTag(cwd)
  if (tag) return tag
  if (fallback) return PLACEHOLDER
  throw new Error(
    'no version to build: CENTRALU_VERSION is not set and no release tag (v*) is reachable from HEAD. ' +
      'Fetch the tags (git fetch --tags; a shallow checkout has none), or set CENTRALU_VERSION.',
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(resolveAppVersion({ fallback: process.argv.includes('--fallback') }))
  } catch (e) {
    console.error(`app-version: ${e.message}`)
    process.exitCode = 1
  }
}
