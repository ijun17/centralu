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
    expect(build).toContain("MACOSX_DEPLOYMENT_TARGET: '11.0'")
    expect(build).toContain('[ "$minos" = "11.0" ]')
    expect(release).toContain("MACOSX_DEPLOYMENT_TARGET: ${{ matrix.target == 'darwin-arm64' && '11.0' || '' }}")
  })
})
