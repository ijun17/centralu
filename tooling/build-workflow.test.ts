import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Like release-workflow.test.ts, inspect the workflow without adding a YAML dependency.
const workflow = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8')
  .split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
const bundle = workflow.split('  bundle:\n')[1]?.split(/^ {2}\S/m)[0] ?? ''
const steps = bundle.split(/^ {6}- /m).slice(1)

describe('CI proves the macOS app bundles without making an unused disk image', () => {
  it('builds only the app on macOS and keeps the default bundles on other platforms', () => {
    const builds = steps.filter((step) => /run:.*tauri build/.test(step))
    const mac = builds.find((step) => step.includes("if: runner.os == 'macOS'"))
    expect(mac, 'macOS must override the default app,dmg bundles').toBeDefined()
    expect(mac).toContain('run: pnpm --filter @cc/desktop exec tauri build --bundles app\n')
    const others = builds.find((step) => step.includes("if: runner.os != 'macOS'"))
    expect(others).toContain('run: pnpm --filter @cc/desktop exec tauri build\n')
    expect(others).toContain('APPIMAGE_EXTRACT_AND_RUN: 1')
    expect(builds).toHaveLength(2)
  })

  it('uploads the executable-preserving app archive without expecting a DMG', () => {
    const mac = bundle.split('- target: darwin-arm64\n')[1]?.split('- target:')[0] ?? ''
    expect(mac).toContain('apps/desktop/src-tauri/target/release/bundle/macos/Centralu-app.tar.gz')
    expect(mac).not.toContain('.dmg')
    const tar = steps.find((step) => step.startsWith('name: Tar the .app\n'))
    expect(tar).toContain("if: runner.os == 'macOS'")
    expect(tar).toContain('run: tar czf Centralu-app.tar.gz ./*.app')
    const upload = steps.find((step) => step.includes('name: centralu-${{ matrix.target }}\n'))
    expect(upload).toContain('path: ${{ matrix.artifacts }}')
    expect(upload).toContain('if-no-files-found: error')
  })
})
