/**
 * The release workflow's job graph is a contract with the npm registry, and nothing else
 * checks it.
 *
 * `.github/workflows/release.yml` publishes one job per platform package and then the
 * `centralu` shim, which pins each platform package at an **exact** version. Those two lists
 * — the workflow's matrix and the shim's `optionalDependencies` — have to be the same list,
 * and each way of drifting apart fails at the worst possible moment:
 *
 * - A platform pinned by the shim with no job to build it: the platform jobs succeed, both
 *   packages are irreversibly on the registry, and *then* the shim job stops on
 *   `assertPinnedPlatformsPublished` (`scripts/release-npm.mts`). Half a release, published.
 * - A job for a platform the shim does not pin: everything goes green and users on that
 *   platform install a shim that never mentions their bundle. npm treats an
 *   optionalDependency that is simply absent as a non-event, so the symptom they get is
 *   "your install is broken", not "your platform isn't out yet".
 *
 * The first one is why `docs/releasing.md` keeps linux-arm64 parked, and it is the reason
 * the matrix entry for it is commented rather than deleted — enabling it is meant to be two
 * `#` and the rest of that checklist, with this test failing in between.
 *
 * The other half of this file guards the *gate*: the publish path sits behind the
 * `npm-publish` environment, and the rehearsal deliberately does not (three human approvals
 * were spent on failing rehearsals during the first release before `c7e3864` split them).
 * Both halves of that are easy to undo by hand and invisible until a release day.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const WORKFLOW = '.github/workflows/release.yml'
const lines = readFileSync(new URL(`../${WORKFLOW}`, import.meta.url), 'utf8').split('\n')

/**
 * The lines belonging to one top-level job, comments dropped.
 *
 * Not a YAML parser: the repo has none as a dependency, and pulling one in to read three
 * shapes out of a hand-formatted file buys less than it costs. A line scan is honest about
 * what it understands — a job header is a two-space-indented key, and anything deeper
 * belongs to it — and it names the job in the failure when the shape changes.
 */
function job(name: string): string[] {
  const start = lines.indexOf(`  ${name}:`)
  expect(start, `${WORKFLOW} has no job named "${name}"`).toBeGreaterThan(-1)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^ {2}\S/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).filter((l) => !l.trim().startsWith('#'))
}

const shimPins = Object.keys(
  (
    JSON.parse(readFileSync(new URL('../packaging/npm/centralu/package.json', import.meta.url), 'utf8')) as {
      optionalDependencies?: Record<string, string>
    }
  ).optionalDependencies ?? {},
)

describe('the release workflow publishes exactly what the shim pins', () => {
  it('the platform matrix and the shim optionalDependencies name the same platforms', () => {
    const matrix = job('platform')
      .map((l) => /^\s*- target: (\S+)$/.exec(l)?.[1])
      .filter((t): t is string => t !== undefined)

    expect(matrix.length, 'no live matrix entries found — did the matrix change shape?').toBeGreaterThan(0)
    // Each target publishes `packaging/npm/<target>/`, under the name that package.json gives.
    // Not `centralu-<target>`: Windows is scoped (`@centralu/win32-x64`, docs/releasing.md).
    const published = matrix.map(
      (t) =>
        (
          JSON.parse(readFileSync(new URL(`../packaging/npm/${t}/package.json`, import.meta.url), 'utf8')) as {
            name: string
          }
        ).name,
    )
    expect(published.sort()).toEqual(shimPins.sort())
  })

  it('builds every host-only package in a platform job, which the shim waits for', () => {
    // The host-only packages (docs/releasing.md) are published by the job of their platform, from
    // the same build. A platform a hub installs on with no job would never get one, and every
    // install there would fall back to the platform package without a word
    const matrix = job('platform')
      .map((l) => /^\s*- target: (\S+)$/.exec(l)?.[1])
      .filter((t): t is string => t !== undefined)
    const pin = JSON.parse(readFileSync(new URL('../packaging/remote-runtime.json', import.meta.url), 'utf8')) as { node: { archives: Record<string, unknown> } }
    for (const platform of Object.keys(pin.node.archives)) expect(matrix, platform).toContain(platform)
  })

  it('release-npm.mts publishes a host-only package first and asks the registry before every publish', () => {
    // The script runs a release when imported, so its wiring is read, not run; what it calls is
    // tested in host-package.test.ts and release-registry.test.ts
    const script = readFileSync(new URL('../scripts/release-npm.mts', import.meta.url), 'utf8')
    expect(script).toMatch(/for \(const pkgDir of \[\.\.\.\(HOST_PKG \? \[HOST_PKG\] : \[\]\), \.\.\.\(ARCH_PKG \? \[ARCH_PKG\] : \[\]\), \.\.\.\(platformOnly \? \[\] : \[MAIN_PKG\]\)\]\)/)
    const loop = script.slice(script.indexOf('for (const pkgDir of [...(HOST_PKG'))
    expect(loop.indexOf('publishStep(')).toBeGreaterThan(-1)
    expect(loop.indexOf('publishStep(')).toBeLessThan(loop.indexOf("'publish', '--access'"))
    expect(script).toContain('hostPackageProblems(HOST_PKG, target.id)')
    expect(script).toContain('await stillMissing(')
  })

  it('the shim job waits for every platform job', () => {
    // `needs` on a matrix job means *every* entry succeeded. That is what makes the
    // ordering hold for a platform added later without anyone editing this line.
    const needs = job('shim').find((l) => l.trim().startsWith('needs:'))
    expect(needs, 'the shim job must declare needs').toBeDefined()
    expect(needs).toContain('platform')
    expect(needs).toContain('guard')
  })

  it('the version guard runs before anything is built', () => {
    // The guard is cheap and the two builds are not; more to the point, a tag that does not
    // match the repo has to be caught while nothing has been published yet.
    expect(job('platform').find((l) => l.trim().startsWith('needs:'))).toContain('guard')
  })
})

describe('the environment gate stays conditional', () => {
  for (const name of ['platform', 'shim']) {
    it(`${name} publishes behind npm-publish, and rehearses without it`, () => {
      const environment = job(name).find((l) => l.trim().startsWith('environment:'))
      expect(environment, `the ${name} job must be gated`).toBeDefined()
      // The gate itself: NPM_TOKEN lives in this environment, and a required reviewer on it
      // is what caught an EOTP failure on the first release before anything shipped.
      expect(environment).toContain('npm-publish')
      // …and the condition. A bare `environment: npm-publish` would still gate the publish,
      // but it would also charge a human approval for every `npm pack` rehearsal.
      expect(environment, 'the gate must depend on dry_run, not apply unconditionally').toContain('dry_run')
    })
  }
})

/**
 * The content signing key (docs/plans/thin-shell.md §4). It signs what a shell will run with the
 * person's permissions, so where it can appear is as much a part of the gate as NPM_TOKEN.
 */
describe('the content signing key stays behind the gate', () => {
  const platform = job('platform')
  const keyLines = lines.filter((l) => !l.trim().startsWith('#') && l.includes('CONTENT_SIGNING_KEY'))

  it('appears once, in the platform job, only for the target that writes a manifest', () => {
    expect(keyLines).toHaveLength(1)
    expect(platform).toContain(keyLines[0])
    // An environment secret: present only when the job runs in npm-publish, which the
    // environment line above makes conditional on a real release.
    expect(keyLines[0]).toContain('secrets.CONTENT_SIGNING_KEY')
    expect(keyLines[0], 'only the darwin job should hold the key').toContain("matrix.target == 'darwin-arm64'")
    // Never the next key: rotation swaps the secrets, the release only ever signs with one.
    expect(lines.join('\n')).not.toContain('CONTENT_SIGNING_KEY_NEXT')
  })

  it('a publish requires a real key and a rehearsal does not', () => {
    const require = platform.find((l) => l.includes('--require-content-key'))
    expect(require, 'the publish path must ask for --require-content-key').toBeDefined()
    expect(require).toContain('"$DRY_RUN" = "false"')
    expect(require).toContain('darwin-arm64')
  })

  it('the manifest upload cannot fail a job that has already published', () => {
    const at = platform.findIndex((l) => l.includes('name: Keep the content manifest'))
    expect(at).toBeGreaterThan(-1)
    expect(platform.slice(at, at + 4).some((l) => l.trim() === 'continue-on-error: true')).toBe(true)
  })
})
