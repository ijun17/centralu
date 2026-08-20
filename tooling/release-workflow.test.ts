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
import { APP_SLUG } from '../packages/protocol/src/brand.js'

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
    expect(matrix.map((t) => `${APP_SLUG}-${t}`).sort()).toEqual(shimPins.sort())
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
