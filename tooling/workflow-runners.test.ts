import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const directory = new URL('../.github/workflows/', import.meta.url)
const workflows = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name)).sort()

describe('workflow runner images change only when explicitly upgraded', () => {
  it('discovers the repository workflows', () => {
    expect(workflows.length).toBeGreaterThan(0)
  })

  it.each(workflows)('%s has no floating hosted runner labels', (name) => {
    // Scan every live line, not only runs-on: labels can come from a matrix axis,
    // include entry, YAML alias or expression. Comments may explain the old labels.
    const floating = readFileSync(new URL(name, directory), 'utf8').split('\n')
      .flatMap((line, index) => {
        const config = line.replace(/(^|\s)#.*$/, '')
        return /\b(?:ubuntu|macos|windows)-latest\b/.test(config)
          ? [`${name}:${index + 1}: ${config.trim()}`]
          : []
      })
    expect(floating, 'Pin runner images, including matrix values, to explicit OS versions').toEqual([])
  })
})

describe('macOS runners and the oldest macOS the app runs on', () => {
  it('no workflow uses a macOS image GitHub has retired', () => {
    // macos-14 and earlier (and their -large and -xlarge twins) stop running on 2026-11-02 (actions/runner-images#13518),
    // and fail every job during the brownouts before it. Comments may name them. One test over every workflow, not one
    // per file: a per-file test for a workflow that never named macOS would pass without the change.
    const retired = workflows.flatMap((name) => readFileSync(new URL(name, directory), 'utf8').split('\n')
      .flatMap((line, index) => {
        const config = line.replace(/(^|\s)#.*$/, '')
        return /\bmacos-(?:\d|1[0-4])\b/.test(config) ? [`${name}:${index + 1}: ${config.trim()}`] : []
      }))
    expect(retired, 'Move the job to macos-15 or later, and its check name in tooling/project-board-ci.test.ts').toEqual([])
  })

  it('states the oldest macOS in every build of the app, so a newer runner SDK cannot raise it', () => {
    const build = readFileSync(new URL('build.yml', directory), 'utf8')
    const release = readFileSync(new URL('release.yml', directory), 'utf8')
    const tauri = JSON.parse(readFileSync(new URL('../../apps/desktop/src-tauri/tauri.conf.json', directory), 'utf8')) as { bundle: { macOS: { minimumSystemVersion?: string } } }
    // The knob the Tauri CLI reads for MACOSX_DEPLOYMENT_TARGET, and that writes LSMinimumSystemVersion into Info.plist
    expect(tauri.bundle.macOS.minimumSystemVersion).toBe('11.0')
    expect(build).toContain("MACOSX_DEPLOYMENT_TARGET: '11.0'")
    expect(release).toContain("MACOSX_DEPLOYMENT_TARGET: ${{ matrix.target == 'darwin-arm64' && '11.0' || '' }}")
  })

  it('checks every Mach-O file of the bundle and the linker log, and of the package that ships', () => {
    const build = readFileSync(new URL('build.yml', directory), 'utf8')
    const releaseScript = readFileSync(new URL('../../scripts/release-npm.mts', directory), 'utf8')
    expect(build).toContain('node scripts/macos-minos.mjs apps/desktop/src-tauri/target/release/bundle/macos/Centralu.app')
    expect(build).toContain('tee "$RUNNER_TEMP/tauri-build.log"')
    expect(build).toContain('grep -n "was built for newer" "$RUNNER_TEMP/tauri-build.log"')
    expect(releaseScript).toMatch(/await stageShellAndContent\(target\.id, dest\)\n\s+\/\/[^\n]*\n[^\n]*\n\s+step\('Checking the oldest macOS the package runs on'\)\n\s+const problems = \(minosProblems/)
  })

  it('keeps the runner image in every cache key of a macOS build, so a runner move rebuilds from scratch', () => {
    const build = readFileSync(new URL('build.yml', directory), 'utf8')
    const release = readFileSync(new URL('release.yml', directory), 'utf8')
    expect(build).toContain('key: ${{ matrix.target }}-${{ matrix.runner }}')
    expect(release).toContain('key: ${{ matrix.target }}-${{ matrix.runner }}')
    // The keeper job has no matrix: its key repeats its runner
    const keeper = build.slice(build.indexOf('  keeper:\n'))
    expect(keeper.match(/runs-on: (macos-\d+)/)?.[1]).toBeDefined()
    expect(keeper).toContain(`key: keeper-darwin-arm64-${keeper.match(/runs-on: (macos-\d+)/)?.[1]}`)
  })
})
