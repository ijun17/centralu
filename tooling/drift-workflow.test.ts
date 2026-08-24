/**
 * The drift workflow fires four times a month with nobody watching it start, and its
 * whole value is red-when-the-vendor-moves. Nothing else checks the ways it can keep
 * running while meaning nothing — each test here pins one of them:
 *
 * - It runs pnpm scripts by name; a rename in package.json (or a deleted script file)
 *   turns the schedule into a weekly red run about our own typo, which trains everyone
 *   to ignore the only signal the job produces.
 * - It exists to check the LATEST published vendor surfaces (#46's decision) — the
 *   pinned versions are `pnpm verify`'s job. Someone "fixing" a red drift run by
 *   pinning a version would make every future run green and meaningless, silently.
 * - The Claude check is only about the package the adapter actually imports; if
 *   agent-host ever migrates SDK packages, the check must fail loudly instead of
 *   faithfully watching the abandoned one.
 * - It is detect-and-report only. A `push:` or `pull_request:` trigger would let a
 *   vendor's release day block unrelated PRs — drift is information, not a gate.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

const WORKFLOW = '.github/workflows/drift.yml'
const at = (p: string) => new URL(`../${p}`, import.meta.url)
const text = readFileSync(at(WORKFLOW), 'utf8')
// Comments dropped — same honest line scan as release-workflow.test.ts, and for the
// same reason: the repo has no YAML parser and three greps do not justify one.
const live = text
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n')

const scripts = (
  JSON.parse(readFileSync(at('package.json'), 'utf8')) as { scripts: Record<string, string> }
).scripts

const invoked = [...live.matchAll(/\bpnpm ([a-z][a-z0-9:._-]*)/g)]
  .map((m) => m[1])
  .filter((n): n is string => n !== undefined)

describe('the drift workflow runs checks that exist', () => {
  it('invokes at least one pnpm script per vendor job', () => {
    expect(invoked.length).toBeGreaterThanOrEqual(2)
  })

  it('every pnpm script it invokes is defined in package.json', () => {
    for (const name of invoked) {
      expect(scripts, `${WORKFLOW} runs "pnpm ${name}" but package.json has no such script`).toHaveProperty(name)
    }
  })

  it('the script files those entries point at exist', () => {
    for (const name of invoked) {
      const file = /(\S+\.m?[jt]s)\b/.exec(scripts[name] ?? '')?.[1]
      expect(file, `script "${name}" names no file — did its shape change?`).toBeDefined()
      expect(existsSync(at(file!)), `script "${name}" points at ${file}, which does not exist`).toBe(true)
    }
  })
})

describe('the checks target the latest published surfaces, not the pins', () => {
  const drift = readFileSync(at('scripts/claude-sdk-drift.mjs'), 'utf8')

  it('the workflow installs the Codex CLI at @latest', () => {
    expect(live).toContain('@openai/codex@latest')
  })

  it('the claude check installs at @latest', () => {
    expect(drift).toContain('@latest')
  })

  it('the claude check watches the package agent-host actually depends on', () => {
    const pkg = /const PKG = '([^']+)'/.exec(drift)?.[1]
    expect(pkg, 'claude-sdk-drift.mjs no longer declares PKG — update this test with its new shape').toBeDefined()
    const deps = (
      JSON.parse(readFileSync(at('packages/agent-host/package.json'), 'utf8')) as {
        dependencies: Record<string, string>
      }
    ).dependencies
    expect(deps, `the drift check watches ${pkg}, which agent-host does not depend on`).toHaveProperty(pkg!)
  })
})

describe('drift is information, not a gate', () => {
  it('triggers on schedule and workflow_dispatch, and on nothing else', () => {
    const on = /^on:\n((?:[ \t]+\S.*\n|\n)*?)(?=^\S)/m.exec(live)?.[1]
    expect(on, `${WORKFLOW} has no on: block`).toBeDefined()
    expect(on).toContain('schedule:')
    expect(on).toContain('workflow_dispatch:')
    const triggers = [...on!.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1])
    expect(triggers.sort()).toEqual(['schedule', 'workflow_dispatch'])
  })
})
