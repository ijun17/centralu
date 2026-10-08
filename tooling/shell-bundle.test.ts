/**
 * The shell that holds macOS permissions (docs/plans/thin-shell.md §3, §6.1), checked without
 * building it.
 *
 * The shell is built once per shell version and its bytes are pinned: every mistake that reaches
 * that one build ships to every person, and fixing it costs each of them a trip to System Settings.
 * So what decides those bytes is checked on every pull request:
 *
 * - **The keys.** A shell people install trusts `packaging/shell/keys.json` and nothing else. The
 *   only other key is the integration test's throwaway key, behind the `test-key` feature, which a
 *   release build refuses to compile and which nothing on the way to a release turns on.
 * - **The identity.** The bundle id, the name people see in the permission prompt, `LSUIElement`,
 *   and one shell version in the source, the Info.plist and the lock.
 * - **The lock.** `packaging/shell/shell.lock` parses, and a download that is not the pinned bytes
 *   is refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assetUrl,
  BUNDLE_ID,
  buildShellExe,
  EXE_NAME,
  fetchPinned,
  parseCdhash,
  plistShellVersion,
  readLock,
  shellVersionInSource,
  type LockEntry,
} from '../scripts/shell-bundle.mjs'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
/** With line comments gone (`//` for Rust, `#` for TOML), so a word inside a comment never counts */
const stripped = (p: string, comment: RegExp) =>
  read(p)
    .split('\n')
    .map((l) => l.replace(comment, ''))
    .join('\n')
const rust = (p: string) => stripped(p, /\/\/.*$/)
const toml = (p: string) => stripped(p, /#.*$/)
const SHELL = 'apps/desktop/src-tauri/shell'
const plist = read(`${SHELL}/Info.plist`)
const plistValue = (key: string) => new RegExp(`<key>${key}</key>\\s*<(\\w+)>([^<]*)</\\1>|<key>${key}</key>\\s*<(true|false)/>`).exec(plist)

describe('the keys a shell trusts', () => {
  it('are compiled in from packaging/shell/keys.json, both of them, and read from nowhere at run time', () => {
    const keys = rust('apps/desktop/content-verify/src/keys.rs')
    expect(keys).toContain('include_str!("../../../../packaging/shell/keys.json")')
    expect(keys).toMatch(/\["current", "next"\]/)
    expect(keys).not.toMatch(/std::env|env!|option_env!|fs::read/)
    const json = JSON.parse(read('packaging/shell/keys.json')) as Record<string, string>
    for (const name of ['current', 'next']) expect(Buffer.from(json[name] ?? '', 'base64')).toHaveLength(32)
  })

  it('a test key exists only behind the test-key feature, which a release build refuses to compile', () => {
    const keys = rust(`${SHELL}/src/keys.rs`)
    expect(keys).toMatch(/#\[cfg\(all\(feature = "test-key", not\(debug_assertions\)\)\)\]\s*compile_error!/)
    // Every mention of the test key's variable is inside code compiled only with the feature.
    const fnStart = keys.indexOf('fn test_key()')
    expect(keys.slice(0, fnStart).trimEnd().endsWith('#[cfg(feature = "test-key")]')).toBe(true)
    const fnEnd = keys.indexOf('\n}\n', fnStart)
    const outside = keys.slice(0, fnStart) + keys.slice(fnEnd)
    expect(keys.slice(fnStart, fnEnd)).toContain('env!("CENTRALU_SHELL_TEST_KEY")')
    expect(outside).not.toContain('CENTRALU_SHELL_TEST_KEY')
    expect(keys).toMatch(/#\[cfg\(feature = "test-key"\)\]\s*keys\.push\(test_key\(\)\?\);/)
  })

  it('the feature is off unless asked for, and nothing on the way to a release asks for it', () => {
    const manifest = toml(`${SHELL}/Cargo.toml`)
    expect(manifest).toMatch(/^test-key = \[\]$/m)
    expect(manifest).not.toMatch(/^default\s*=/m)
    // No crate depends on the shell, so no dependency can turn a feature of it on.
    for (const p of ['apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/src-tauri/keeper/Cargo.toml', 'apps/desktop/content-verify/Cargo.toml']) {
      expect(toml(p), p).not.toMatch(/centralu-shell\s*=|path = "\.\.?\/?shell"/)
    }
    // The guard keys on `debug_assertions`: a release profile that turned them on would let a
    // release build carry the test key.
    expect(toml('apps/desktop/src-tauri/Cargo.toml')).not.toMatch(/debug-assertions/)
    // The bundle the release workflow builds goes through `build`, which never passes a test key
    // (tooling/shell-release-workflow.test.ts checks that the workflow passes no feature either).
    const script = read('scripts/shell-bundle.mts')
    const build = script.slice(script.indexOf('export function build('))
    expect(build.slice(0, build.indexOf('\n}\n'))).toMatch(/buildShellExe\(\{ targetDir: opts\.targetDir, release: opts\.release \}\)/)
  })

  it('buildShellExe refuses a test key in a release build before running cargo', () => {
    expect(() => buildShellExe({ targetDir: '/nonexistent', release: true, testKey: 'AAAA' })).toThrow(/only into a debug build/)
  })
})

describe("the shell's identity", () => {
  it('one shell version in src/lib.rs, Info.plist and its bundle version', () => {
    const v = shellVersionInSource()
    expect(v).toBeGreaterThanOrEqual(1)
    expect(plistShellVersion()).toBe(v)
    expect(plistValue('CFBundleVersion')?.[2]).toBe(String(v))
    expect(plistValue('CFBundleShortVersionString')?.[2]).toBe(String(v))
  })

  it('is app.centralu.agent, shown as "Centralu", with no Dock icon (§9 decision 1)', () => {
    expect(BUNDLE_ID).toBe('app.centralu.agent')
    expect(plistValue('CFBundleIdentifier')?.[2]).toBe(BUNDLE_ID)
    expect(read(`${SHELL}/src/lib.rs`)).toContain(`pub const BUNDLE_ID: &str = "${BUNDLE_ID}";`)
    expect(plistValue('CFBundleDisplayName')?.[2]).toBe('Centralu')
    expect(plistValue('CFBundleName')?.[2]).toBe('Centralu')
    expect(plistValue('LSUIElement')?.[3]).toBe('true')
    expect(plistValue('CFBundleExecutable')?.[2]).toBe(EXE_NAME)
    expect(toml(`${SHELL}/Cargo.toml`)).toContain(`name = "${EXE_NAME}"`)
  })

  it('declares a usage description for every privacy class that would otherwise end the asking process', () => {
    for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSContactsUsageDescription', 'NSCalendarsUsageDescription', 'NSCalendarsFullAccessUsageDescription', 'NSRemindersUsageDescription', 'NSRemindersFullAccessUsageDescription', 'NSPhotoLibraryUsageDescription', 'NSSpeechRecognitionUsageDescription', 'NSAppleEventsUsageDescription']) {
      expect(plistValue(key)?.[2], key).toMatch(/Centralu/)
    }
  })

  it('links only the verifier, the keeper start and what they already use', () => {
    const deps = toml(`${SHELL}/Cargo.toml`).split(/^\[/m)
    const names = (table: string) =>
      (deps.find((t) => t.startsWith(table)) ?? '')
        .split('\n')
        .slice(1)
        .map((l) => /^([\w-]+)\s*=/.exec(l)?.[1])
        .filter(Boolean)
    expect(names('dependencies]')).toEqual(['content-verify', 'centralu-keeper-core', 'serde_json'])
    expect(names("target.'cfg(unix)'.dependencies]")).toEqual(['libc'])
  })

  it('is not built with every app build: not a default member of the workspace', () => {
    const ws = toml('apps/desktop/src-tauri/Cargo.toml')
    expect(ws).toMatch(/^members = \[.*"shell".*\]$/m)
    expect(/^default-members = \[(.*)\]$/m.exec(ws)?.[1]).not.toContain('shell')
  })
})

describe('packaging/shell/shell.lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-shell-lock-'))
  const write = (body: unknown) => {
    const f = join(dir, `lock-${Math.random().toString(16).slice(2)}.json`)
    writeFileSync(f, JSON.stringify(body))
    return f
  }
  const entry: LockEntry = {
    version: 1,
    platform: 'darwin-arm64',
    sha256: 'a'.repeat(64),
    cdhash: 'b'.repeat(40),
    url: assetUrl(1, 'darwin-arm64'),
  }
  afterEach(() => vi.unstubAllGlobals())

  it('the checked-in lock parses', () => {
    expect(Array.isArray(readLock())).toBe(true)
  })

  it('an entry names its release asset, and a malformed or repeated one is an error', () => {
    expect(entry.url).toBe('https://github.com/ijun17/centralu/releases/download/shell-v1/Centralu-shell-v1-darwin-arm64.zip')
    expect(readLock(write({ format: 1, shells: [entry] }))).toEqual([entry])
    expect(() => readLock(write({ format: 2, shells: [] }))).toThrow(/format/)
    expect(() => readLock(write({ format: 1, shells: [{ ...entry, sha256: 'A'.repeat(64) }] }))).toThrow(/sha256/)
    expect(() => readLock(write({ format: 1, shells: [{ ...entry, cdhash: 'b'.repeat(39) }] }))).toThrow(/cdhash/)
    expect(() => readLock(write({ format: 1, shells: [{ ...entry, url: 'https://example.com/x.zip' }] }))).toThrow(/url/)
    expect(() => readLock(write({ format: 1, shells: [{ ...entry, version: 0 }] }))).toThrow(/version/)
    expect(() => readLock(write({ format: 1, shells: [entry, entry] }))).toThrow(/twice/)
  })

  it('a download whose sha256 is not the pinned one is refused and not written', async () => {
    const bytes = Buffer.from('not the pinned zip')
    vi.stubGlobal('fetch', async () => new Response(bytes))
    const dest = join(dir, 'shell.zip')
    await expect(fetchPinned(entry, dest)).rejects.toThrow(/shell\.lock pins/)
    expect(() => readFileSync(dest)).toThrow()
    const good = { ...entry, sha256: createHash('sha256').update(bytes).digest('hex') }
    await expect(fetchPinned(good, dest)).resolves.toBe(dest)
    expect(readFileSync(dest)).toEqual(bytes)
    rmSync(dest)
  })

  it("reads codesign's CDHash line", () => {
    expect(parseCdhash(`Identifier=app.centralu.agent\nCDHash=${'c'.repeat(40)}\nSignature=adhoc`)).toBe('c'.repeat(40))
    expect(parseCdhash('CDHash=xyz')).toBeUndefined()
  })
})
