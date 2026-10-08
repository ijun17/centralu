/**
 * `.github/workflows/shell-release.yml` builds one shell version, once (docs/plans/thin-shell.md §3,
 * §6.1). It is run by hand, rarely, and its output is pinned for every release after it, so a
 * property lost in an edit shows up only on the day a shell version is published, when it is too
 * late: the bytes are out and a second build would be a second identity for macOS.
 *
 * Pinned here:
 * - it runs only when someone asks (`workflow_dispatch`), never on a push, tag or schedule;
 * - it builds on an Apple silicon runner, with no cache, no feature and no secret;
 * - it ad-hoc signs, checks the signature, the identity and what the binary links, and zips
 *   reproducibly (the zip is made twice and compared);
 * - it prints the zip's sha256, the cdhash and the `shell.lock` entry;
 * - it publishes a prerelease `shell-v<N>` that is never marked latest, from a job that builds
 *   nothing, and the only job that can write;
 * - the version comes in through the environment, never pasted into a script.
 *
 * Not a YAML parser, for the reason tooling/release-workflow.test.ts gives.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const WORKFLOW = '.github/workflows/shell-release.yml'
const text = readFileSync(new URL(`../${WORKFLOW}`, import.meta.url), 'utf8')
const lines = text.split('\n').filter((l) => !l.trim().startsWith('#'))

/** The lines of one top-level key (`on`, `permissions`, `jobs`) */
function topLevel(name: string): string[] {
  const start = lines.indexOf(`${name}:`)
  expect(start, `${WORKFLOW} has no top-level "${name}"`).toBeGreaterThan(-1)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^\S/.test(l))
  return end === -1 ? rest : rest.slice(0, end)
}

/** The lines of one job */
function job(name: string): string[] {
  const jobs = topLevel('jobs')
  const start = jobs.indexOf(`  ${name}:`)
  expect(start, `${WORKFLOW} has no job "${name}"`).toBeGreaterThan(-1)
  const rest = jobs.slice(start + 1)
  const end = rest.findIndex((l) => /^ {2}\S/.test(l))
  return end === -1 ? rest : rest.slice(0, end)
}
const jobNames = () =>
  topLevel('jobs')
    .map((l) => /^ {2}([\w-]+):$/.exec(l)?.[1])
    .filter(Boolean)

describe('the shell release workflow', () => {
  it('runs only by hand', () => {
    const on = topLevel('on').filter((l) => /^ {2}\S/.test(l))
    expect(on).toEqual(['  workflow_dispatch:'])
  })

  it('reads the repository by default, and only the job that publishes can write', () => {
    expect(topLevel('permissions').map((l) => l.trim()).filter(Boolean)).toEqual(['contents: read'])
    const writers = jobNames().filter((j) => job(j as string).some((l) => /:\s*write\b/.test(l)))
    expect(writers).toEqual(['publish'])
    expect(job('publish').join('\n')).not.toMatch(/cargo|shell-bundle\.mts build|codesign/)
  })

  it('builds on an Apple silicon runner, from a fresh target folder with no cache', () => {
    const build = job('build').join('\n')
    // macos-14 and later are arm64; macos-13 and the -large images are Intel.
    expect(build).toMatch(/runs-on: macos-1[4-9]$/m)
    expect(build).not.toMatch(/rust-cache|actions\/cache/)
    expect(build).toMatch(/shell-bundle\.mts build --out "\$RUNNER_TEMP\/shell" --target-dir "\$RUNNER_TEMP\/shell-target"/)
    expect(build).toContain("MACOSX_DEPLOYMENT_TARGET: '11.0'")
  })

  it('never builds a shell that trusts a key beyond keys.json, and touches no secret', () => {
    expect(text).not.toMatch(/test-key|CENTRALU_SHELL_TEST_KEY|--features|--debug/)
    expect(text).not.toMatch(/secrets\./)
    expect(text).not.toMatch(/environment:/)
  })

  it('signs ad hoc, checks the signature, the identity, the architecture and the linkage', () => {
    const build = job('build').join('\n')
    expect(build).toContain('/usr/bin/codesign --verify --strict --deep "$app"')
    expect(build).toContain("grep -q '^Identifier=app.centralu.agent$'")
    expect(build).toMatch(/lipo -archs .* = "arm64"/)
    expect(build).toMatch(/otool -L .*libSystem\.B\.dylib.*libiconv\.2\.dylib/)
    // Runs the binary itself, never through LaunchServices.
    expect(text).not.toMatch(/\bopen -/)
    expect(build).toMatch(/s\.testBuild !== false/)
  })

  it('zips reproducibly: the same bundle zipped twice must give the same sha256', () => {
    const build = job('build').join('\n')
    expect(build).toMatch(/shell-bundle\.mts zip "\$app" "\$RUNNER_TEMP\/again\.zip"/)
    expect(build).toMatch(/zipping the same bundle twice gave different bytes/)
  })

  it('prints the sha256, the cdhash and the shell.lock entry', () => {
    const build = job('build').join('\n')
    expect(build).toMatch(/sha256: \$\{e\.sha256\}/)
    expect(build).toMatch(/cdhash: \$\{e\.cdhash\}/)
    expect(build).toMatch(/shell\.lock entry/)
    expect(job('publish').join('\n')).toMatch(/packaging\/shell\/shell\.lock/)
  })

  it('publishes a prerelease shell-v<N> that is never the latest release', () => {
    const publish = job('publish').join('\n')
    expect(publish).toMatch(/gh release create "shell-v\$VERSION"/)
    expect(publish).toContain('--prerelease')
    expect(publish).toContain('--latest=false')
    expect(publish).toMatch(/the zip changed between the build and here/)
  })

  it('refuses a version that is already built, and takes the version through the environment', () => {
    const guard = job('guard').join('\n')
    expect(guard).toContain('INPUT_VERSION: ${{ inputs.version }}')
    expect(guard).toMatch(/already pins shell/)
    expect(guard).toMatch(/gh release view "shell-v\$INPUT_VERSION"/)
    // `${{ inputs.* }}` only in `env:` values and names, never inside a script.
    for (const l of lines.filter((x) => x.includes('${{ inputs.'))) expect(l, l).toMatch(/^\s+[A-Z_]+: \$\{\{ inputs\.version \}\}$/)
  })
})
