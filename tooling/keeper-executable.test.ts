/**
 * The keeper ships as its own executable, `centralu-keeper`, next to the window's (#440).
 *
 * Nothing at run time notices when this falls apart: with no keeper beside it, the window's
 * executable runs the keeper itself (`keeper/src/keeper/exe.rs`), so the app keeps working and only
 * the separation is gone. The pieces that put it in the bundle are spread over three files, and
 * each can be undone by an edit that looks unrelated:
 *
 * - Tauri bundles every binary of the package whose required features are among the build's
 *   `build.features`; drop `keeper-exe` from tauri.conf.json and the bundle silently loses it.
 * - Windows and Linux have no keeper (Linux since #1895 step 4 PR 7); tauri.windows.conf.json and
 *   tauri.linux.conf.json clear the features so the installer and the AppImage do not ship one.
 * - The keeper links `centralu-keeper-core` and nothing of the window's. One `use centralu_lib` in
 *   the keeper's main, or a GUI crate added to the core crate, and it carries the webview again.
 *
 * `pnpm release:npm` checks the built bundle itself (`checkMacKeeperExe` in scripts/release-npm.mts);
 * this catches the same mistakes on every pull request, without a release build.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const TAURI = 'apps/desktop/src-tauri'
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const json = (p: string) => JSON.parse(read(p)) as { build?: { features?: string[] } }
/** TOML with the comments gone, so a commented-out line never counts */
const toml = (p: string) =>
  read(p)
    .split('\n')
    .map((l) => l.replace(/#.*$/, ''))
    .join('\n')

/** One `[[bin]]` table's lines, by name */
function binTable(manifest: string, name: string): string {
  const tables = manifest.split(/^\[\[bin\]\]\s*$/m).slice(1)
  const table = tables.map((t) => t.split(/^\[/m)[0] ?? '').find((t) => t.includes(`name = "${name}"`))
  expect(table, `no [[bin]] named ${name} in ${TAURI}/Cargo.toml`).toBeDefined()
  return table as string
}

describe('the keeper executable', () => {
  const manifest = toml(`${TAURI}/Cargo.toml`)

  it('is a binary of the app package, gated by the keeper-exe feature that is on by default', () => {
    const bin = binTable(manifest, 'centralu-keeper')
    expect(bin).toContain('path = "src/bin/centralu-keeper.rs"')
    expect(bin).toMatch(/required-features = \["keeper-exe"\]/)
    expect(manifest).toMatch(/^default = \[[^\]]*"keeper-exe"[^\]]*\]/m)
    expect(manifest).toMatch(/^default-run = "centralu"/m)
  })

  it('is bundled on macOS, and not on Windows or Linux', () => {
    expect(json(`${TAURI}/tauri.conf.json`).build?.features).toContain('keeper-exe')
    for (const os of ['windows', 'linux']) {
      const features = json(`${TAURI}/tauri.${os}.conf.json`).build?.features
      expect(features, `tauri.${os}.conf.json must replace build.features, or it inherits keeper-exe`).toBeDefined()
      expect(features).not.toContain('keeper-exe')
    }
  })

  it('links the keeper crate and nothing of the window', () => {
    const main = read(`${TAURI}/src/bin/centralu-keeper.rs`)
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(main).toContain('centralu_keeper_core::keeper::server::run')
    expect(main).not.toMatch(/centralu_lib|tauri/)
  })

  it('has a core crate with no GUI dependency', () => {
    const core = toml(`${TAURI}/keeper/Cargo.toml`)
    const deps = [...core.matchAll(/^([a-z0-9_-]+)\s*=/gm)].map((m) => m[1])
    for (const gui of ['tauri', 'wry', 'tao', 'objc2', 'objc2-app-kit', 'objc2-foundation', 'gtk', 'webkit2gtk', 'trash']) {
      expect(deps, `keeper/Cargo.toml must not depend on ${gui}`).not.toContain(gui)
    }
  })

  /**
   * The keeper verifies content with the built-in keys only (the window's account of why the shell refused its content),
   * packaging/shell/keys.json and nothing else, as the shell does. Its test key went with the handoff to verified
   * content (#1895 step 4, PR 4): no feature of the keeper crate may bring one back.
   */
  it('trusts packaging/shell/keys.json and no test key', () => {
    const keys = read(`${TAURI}/keeper/src/keeper/keys.rs`)
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
    expect(keys).toContain('embedded_keys()')
    expect(keys).not.toMatch(/test-key|CENTRALU_KEEPER_TEST_KEY|cfg\(feature/)
    expect(toml(`${TAURI}/keeper/Cargo.toml`)).not.toMatch(/^test-key\s*=/m)
  })

  it("keeps the core crate's tests in `cargo test --lib` on the app manifest", () => {
    expect(manifest).toMatch(/^default-members = \[[^\]]*"keeper"[^\]]*\]/m)
  })
})
