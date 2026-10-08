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
 * - Windows has no keeper; tauri.windows.conf.json clears the features so the installer does not
 *   ship a stub.
 * - The keeper links `centralu-keeper-core` and nothing of the window's. One `use centralu_lib` in
 *   the keeper's main, or a GUI crate added to the core crate, and it carries the webview again.
 *
 * `pnpm release:npm` checks the built bundle itself (scripts/release-npm.mts, `checkKeeperExe`);
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

  it('is bundled on macOS and Linux, and not on Windows', () => {
    expect(json(`${TAURI}/tauri.conf.json`).build?.features).toContain('keeper-exe')
    expect(json(`${TAURI}/tauri.linux.conf.json`).build?.features ?? ['keeper-exe']).toContain('keeper-exe')
    const windows = json(`${TAURI}/tauri.windows.conf.json`).build?.features
    expect(windows, 'tauri.windows.conf.json must replace build.features, or it inherits keeper-exe').toBeDefined()
    expect(windows).not.toContain('keeper-exe')
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
   * A keeper from verified content verifies the next build's content with built-in keys
   * (docs/plans/thin-shell.md §10 step 5). The keeper people run trusts packaging/shell/keys.json
   * and nothing else, as the shell does; the integration test's throwaway key sits behind the
   * keeper crate's `test-key` feature, which a release build refuses to compile.
   */
  it('trusts a test key only behind the test-key feature, which a release build refuses and nothing turns on', () => {
    const keys = read(`${TAURI}/keeper/src/keeper/keys.rs`)
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
    expect(keys).toMatch(/#\[cfg\(all\(feature = "test-key", not\(debug_assertions\)\)\)\]\s*compile_error!/)
    expect(keys).toContain('embedded_keys()')
    const fnStart = keys.indexOf('fn test_key()')
    expect(keys.slice(0, fnStart).trimEnd().endsWith('#[cfg(feature = "test-key")]')).toBe(true)
    const fnEnd = keys.indexOf('\n}\n', fnStart)
    expect(keys.slice(fnStart, fnEnd)).toContain('env!("CENTRALU_KEEPER_TEST_KEY")')
    expect(keys.slice(0, fnStart) + keys.slice(fnEnd)).not.toContain('CENTRALU_KEEPER_TEST_KEY')
    expect(keys).toMatch(/#\[cfg\(feature = "test-key"\)\]\s*keys\.push\(test_key\(\)\?\);/)

    const core = toml(`${TAURI}/keeper/Cargo.toml`)
    expect(core).toMatch(/^test-key = \[\]$/m)
    expect(core).not.toMatch(/^default\s*=/m)
    // Nothing that depends on the keeper crate turns the feature on, and the release profile keeps
    // `debug_assertions` off, which is what the guard keys on.
    for (const p of [`${TAURI}/Cargo.toml`, `${TAURI}/shell/Cargo.toml`]) expect(toml(p), p).not.toContain('test-key"')
    expect(manifest).not.toMatch(/debug-assertions/)
    for (const conf of ['tauri.conf.json', 'tauri.linux.conf.json', 'tauri.windows.conf.json']) {
      expect(json(`${TAURI}/${conf}`).build?.features ?? [], conf).not.toContain('centralu-keeper-core/test-key')
    }
    for (const wf of ['release.yml', 'shell-release.yml']) {
      expect(read(`.github/workflows/${wf}`), wf).not.toMatch(/test-key|CENTRALU_KEEPER_TEST_KEY/)
    }
  })

  it("keeps the core crate's tests in `cargo test --lib` on the app manifest", () => {
    expect(manifest).toMatch(/^default-members = \[[^\]]*"keeper"[^\]]*\]/m)
  })
})
