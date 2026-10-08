/**
 * The shell and the signed content in the window's bundle (docs/plans/thin-shell.md §10.2,
 * scripts/bundle-stage.mts).
 *
 * The window looks for them at fixed places (`apps/desktop/src-tauri/src/shell`), and the release
 * has to put them exactly there, signed, and nothing else in between. So:
 *
 * - the paths the staging writes are the paths the window reads, and the release and `pnpm app`
 *   both stage;
 * - the hash of the shell's files is the same in TypeScript and in Rust (the same fixed tree as the
 *   Rust test `the_tree_hash_is_the_one_the_release_staging_writes`);
 * - on macOS, staging a made-up bundle puts the shell and the content there, keeps the window's
 *   signature valid, and `checkStaged` refuses a bundle whose content or shell changed afterwards.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  checkStaged,
  CONTENT_IN_BUNDLE,
  HOST_IN_BUNDLE,
  KEEPER_IN_BUNDLE,
  SHELL_DESCRIPTOR,
  SHELL_IN_BUNDLE,
  stageBundle,
  stageContent,
  treeHash,
  type ShellDescriptor,
} from '../scripts/bundle-stage.mjs'
import { throwawayKey } from '../scripts/content-manifest.mjs'
import { APP_DIR_NAME, assembleBundle } from '../scripts/shell-bundle.mjs'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const rust = (p: string) =>
  read(p)
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')

describe('where the bundle carries the shell and the content', () => {
  it('is where the window looks for them', () => {
    expect(SHELL_IN_BUNDLE).toBe('Contents/Resources/shell')
    expect(CONTENT_IN_BUNDLE).toBe('Contents/Resources/content')
    expect(APP_DIR_NAME).toBe('Centralu.app')
    // The window's `Contents/Resources` is Tauri's resource_dir; it reads `shell/` and `content/` there.
    const install = rust('apps/desktop/src-tauri/src/shell/install.rs')
    expect(install).toContain('pub const SHELL_APP: &str = "Centralu.app";')
    expect(install).toContain(`pub const DESCRIPTOR: &str = "${SHELL_DESCRIPTOR}";`)
    expect(install).toContain('resources.join("shell")')
    expect(rust('apps/desktop/src-tauri/src/shell/mod.rs')).toContain('content: resources.join("content")')
    expect(rust('apps/desktop/src-tauri/src/sidecar.rs')).toContain('app.path().resource_dir()')
  })

  it('the content is made from the keeper and the host the bundle carries', () => {
    expect(KEEPER_IN_BUNDLE).toBe('Contents/MacOS/centralu-keeper')
    // tauri.conf.json bundles resources/host under Contents/Resources/resources/host
    expect(JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json')).bundle.resources).toContain('resources/host/**/*')
    expect(HOST_IN_BUNDLE).toBe('Contents/Resources/resources/host')
  })

  it('the macOS release stages both before it packs, and checks what the bundle then carries', () => {
    const release = read('scripts/release-npm.mts')
    const darwin = release.slice(release.indexOf("'darwin-arm64': {"), release.indexOf("'linux-x64': {"))
    expect(darwin).toContain('stagesShell: true')
    for (const id of ['linux-x64', 'linux-arm64', 'win32-x64']) {
      const block = release.slice(release.indexOf(`'${id}': {`))
      expect(block.slice(0, block.indexOf('\n  },\n')), id).not.toContain('stagesShell')
    }
    const fn = release.slice(release.indexOf('async function stageShellAndContent('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    // In this order: sign the content, choose the shell, stage both, check the bundle.
    const at = (s: string) => body.indexOf(s)
    expect(at('stageContent(')).toBeGreaterThan(-1)
    expect(at('shellToCarry({ usePinned: publish')).toBeGreaterThan(at('stageContent('))
    expect(at('stageBundle(bundle')).toBeGreaterThan(at('shellToCarry('))
    expect(at('checkStaged(bundle')).toBeGreaterThan(at('stageBundle(bundle'))
    // Staging happens before anything is packed or published.
    expect(release.indexOf('await stageShellAndContent(')).toBeLessThan(release.indexOf("sh('npm', ['publish'"))
  })

  it('`pnpm app` stages its build too, before opening it', () => {
    const app = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts.app ?? ''
    const order = ['tauri build', 'scripts/bundle-stage.mts', 'open ']
    const idx = order.map((s) => app.indexOf(s))
    expect(idx.every((i) => i > -1)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })
})

describe('the hash of the shell bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-tree-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const exe = join(dir, 'Contents/MacOS/centralu-shell')
  /** The fixed tree, written here rather than checked out, so no line-ending conversion can touch it */
  const tree = () => {
    mkdirSync(join(dir, 'Contents/MacOS'), { recursive: true })
    mkdirSync(join(dir, 'Contents/Empty'), { recursive: true })
    writeFileSync(join(dir, 'Contents/Info.plist'), 'plist\n')
    writeFileSync(exe, 'exe\n')
  }
  /** Both files without an execute bit */
  const PLAIN = 'e020dc9eec8f3e19451a575081eef289f4f1a1095fe6b0ba66d2aeab343970e9'
  /** The same tree with centralu-shell executable */
  const WITH_EXEC = '5c1c77146a6637356af8fb36a975dd7d4efac09faee11d08e1b4998b8b03a899'

  it('is the one the window computes, for files, paths and their order (the Rust test hashes the same trees)', () => {
    tree()
    chmodSync(exe, 0o644)
    expect(treeHash(dir)).toBe(PLAIN)
  })

  /*
   * Windows has no execute bit: Node reports a file's mode from its read-only attribute alone, and
   * `chmod 0o755` cannot set one, so there the executable reads as plain (the failure this guards
   * against was exactly that: PLAIN where WITH_EXEC was expected). The hash only ever runs on macOS,
   * in the window and in the release staging, where the bit is real and part of what is pinned.
   */
  it.skipIf(process.platform === 'win32')('counts the execute bit, where the file system has one', () => {
    tree()
    chmodSync(exe, 0o755)
    expect(treeHash(dir)).toBe(WITH_EXEC)
    chmodSync(exe, 0o644)
    expect(treeHash(dir)).toBe(PLAIN)
  })
})

describe.runIf(process.platform === 'darwin' && existsSync('/usr/bin/codesign'))('staging a bundle (macOS)', () => {
  const work = mkdtempSync(join(tmpdir(), 'cc-stage-'))
  afterAll(() => rmSync(work, { recursive: true, force: true }))
  const platform = `${process.platform}-${process.arch}`

  const resign = (app: string) =>
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=identifier,entitlements,requirements,flags,runtime', app], { stdio: 'ignore' })

  /** A window bundle as Tauri leaves it: signed, a keeper beside the main executable, a host */
  function windowBundle(): string {
    const app = join(work, `w-${Math.random().toString(16).slice(2)}`, 'Centralu.app')
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
    mkdirSync(join(app, HOST_IN_BUNDLE), { recursive: true })
    writeFileSync(
      join(app, 'Contents/Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>centralu</string><key>CFBundleIdentifier</key><string>app.centralu.test</string></dict></plist>\n',
    )
    copyFileSync('/usr/bin/true', join(app, 'Contents/MacOS/centralu'))
    copyFileSync('/usr/bin/true', join(app, KEEPER_IN_BUNDLE))
    writeFileSync(join(app, HOST_IN_BUNDLE, 'main.mjs'), 'export {}\n')
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', join(app, KEEPER_IN_BUNDLE)], { stdio: 'ignore' })
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', app], { stdio: 'ignore' })
    return app
  }

  function staged() {
    const app = windowBundle()
    const key = throwawayKey()
    const keys = [{ name: 'throwaway', keyId: key.keyId, publicKey: key.publicKey }]
    const contentDir = join(app, '..', 'content')
    const manifest = stageContent(contentDir, { bundle: app, key, platform, appVersion: '0.1.0-test.1' })
    const shellApp = assembleBundle('/usr/bin/true', join(app, '..', 'shell-out'))
    stageBundle(app, { shell: { app: shellApp, version: 1, pinned: false }, contentDir })
    return { app, keys, manifest }
  }

  it('puts the shell and the signed content where the window reads them, and the bundle stays signed', () => {
    const { app, keys, manifest } = staged()
    const descriptor = checkStaged(app, { keys, platform, manifest })
    expect(descriptor).toEqual({ format: 1, version: 1, tree: treeHash(join(app, SHELL_IN_BUNDLE, APP_DIR_NAME)), pinned: false } satisfies ShellDescriptor)
    for (const f of ['centralu-keeper', 'host/main.mjs', 'content-manifest.json', 'content-manifest.json.sig']) {
      expect(existsSync(join(app, CONTENT_IN_BUNDLE, f)), f).toBe(true)
    }
    expect(existsSync(join(app, SHELL_IN_BUNDLE, APP_DIR_NAME, 'Contents/MacOS/centralu-shell'))).toBe(true)
    // The hardened runtime flag the bundler set survives the second signature.
    // `codesign -d` describes on stderr
    const details = spawnSync('/usr/bin/codesign', ['-d', '-vvv', app], { encoding: 'utf8' }).stderr
    expect(details).toMatch(/flags=0x\w+\(adhoc,runtime\)/)
  })

  it('refuses a bundle whose content changed after it was signed', () => {
    const { app, keys, manifest } = staged()
    appendFileSync(join(app, CONTENT_IN_BUNDLE, 'host/main.mjs'), '// changed\n')
    // Signed again, so the window's signature is valid and only the content's own check can tell.
    resign(app)
    expect(() => checkStaged(app, { keys, platform, manifest })).toThrow(/host\/main\.mjs is \d+ bytes/)
  })

  it('refuses a bundle whose shell is not the one described', () => {
    const { app, keys, manifest } = staged()
    const d = join(app, SHELL_IN_BUNDLE, SHELL_DESCRIPTOR)
    const desc = JSON.parse(readFileSync(d, 'utf8')) as ShellDescriptor
    writeFileSync(d, JSON.stringify({ ...desc, tree: 'f'.repeat(64) }))
    resign(app)
    expect(() => checkStaged(app, { keys, platform, manifest })).toThrow(/hashes to/)
  })

  it('refuses a pinned shell without its lock entry to check the cdhash against', () => {
    const { app, keys, manifest } = staged()
    const d = join(app, SHELL_IN_BUNDLE, SHELL_DESCRIPTOR)
    writeFileSync(d, JSON.stringify({ ...(JSON.parse(readFileSync(d, 'utf8')) as ShellDescriptor), pinned: true }))
    resign(app)
    expect(() => checkStaged(app, { keys, platform, manifest })).toThrow(/lock entry/)
  })
})
