import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { installLocalBundle, requestSignature, stampLocalVersion } from '../scripts/local-update.mjs'
import { buildManifest, MANIFEST_NAME, SIGNATURE_NAME, verifyManifest } from '../scripts/content-manifest.mjs'
import { APP_VERSION } from '../packages/protocol/src/brand.js'
// @ts-expect-error — plain JavaScript policy runs in Actions without installing dependencies
import { assertLocalVersion, chooseLocalVersion, MAX_LOCAL_MANIFEST_BYTES, nextReleaseVersion, readAppVersion, validateLocalManifest } from '../scripts/local-manifest.mjs'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'cc-local-update-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const base = '0.2.0-beta.20'
const allowedBase = base
function fixture() {
  const paths = ['centralu-keeper', 'host/main.mjs', 'host/bundle-info.json', 'host/schema.sql', 'host/node_modules/better-sqlite3/package.json', 'host/node_modules/node-pty/package.json']
  return {
    format: 1, appVersion: `${APP_VERSION}.local.1`, platform: 'darwin-arm64', minShellVersion: 1,
    files: paths.sort().map((path) => ({ path, size: 1, sha256: 'a'.repeat(64), executable: path === 'centralu-keeper' })),
    local: { baseVersion: APP_VERSION, installedVersion: APP_VERSION, nextRelease: nextReleaseVersion(APP_VERSION), commit: 'a'.repeat(40), dirty: true, requestId: 'b'.repeat(32) },
  }
}
const bytes = (m: unknown) => Buffer.from(`${JSON.stringify(m, null, 2)}\n`)
const validate = (input: Buffer) => validateLocalManifest(input, APP_VERSION)

describe('local update version bounds', () => {
  it('increments local counters only when the installed and next-release bounds permit it', () => {
    expect(chooseLocalVersion(base, base)).toBe(`${base}.local.1`)
    for (let n = 2; n <= 128; n++) {
      const installed = `${base}.local.${n - 1}`
      expect(chooseLocalVersion(base, installed)).toBe(`${base}.local.${n}`)
      expect(() => assertLocalVersion(installed, base, installed)).toThrow(/above installed/)
    }
  })
  it('places the approved suffix between the current beta and next release and refuses other spellings', () => {
    expect(nextReleaseVersion(base)).toBe('0.2.0-beta.21')
    expect(assertLocalVersion(`${base}.local.1`, base, base)).toBe('0.2.0-beta.21')
    expect(() => assertLocalVersion(`${base}-local.1`, base, base)).toThrow(/must be <base>\.local/)
    for (const installed of [`${base}.local.1`, `${base}.local.2`, '0.2.0-beta.21', '0.2.0']) {
      expect(() => assertLocalVersion(`${base}.local.1`, base, installed), installed).toThrow(/above installed and below next/)
    }
    expect(chooseLocalVersion(base, '0.2.0-beta.19.local.128')).toBe(`${base}.local.1`)
  })
  it('refuses malformed bases, installed versions, counters and build metadata', () => {
    for (const value of ['', 'v1.2.3', '01.2.3', '1.2.3+build', '1.2.3-beta.01', '1.2.3-local.1', `${base}.local.1`, '1.2.3-beta']) expect(() => nextReleaseVersion(value), value).toThrow()
    for (const n of ['', '0', '-1', '01', '1.1', '9007199254740992']) expect(() => assertLocalVersion(`${base}.local.${n}`, base, base), n).toThrow()
    expect(() => chooseLocalVersion('1.2.3', '1.2.3')).toThrow(/invalid version/)
    expect(() => chooseLocalVersion(allowedBase, 'invalid')).toThrow()
  })
})

describe('version stamping', () => {
  it('embeds the same version in the UI, host, window, keeper and Info.plist configuration', () => {
    const root = temp()
    for (const path of ['packages/protocol/src/brand.ts', 'apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json']) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      cpSync(resolve(path), join(root, path))
    }
    stampLocalVersion(root, APP_VERSION, `${APP_VERSION}.local.2`)
    expect(readFileSync(join(root, 'packages/protocol/src/brand.ts'), 'utf8')).toContain(`${APP_VERSION}.local.2`)
    expect(readFileSync(join(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8')).toContain(`version = "${APP_VERSION}.local.2"`)
    for (const path of ['apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json']) expect(JSON.parse(readFileSync(join(root, path), 'utf8')).version).toBe(`${APP_VERSION}.local.2`)
  })
})

it.runIf(process.platform === 'darwin')('installs through ditto and the launcher swap against a temporary target', () => {
  const root = temp()
  const source = join(root, 'staged/Centralu.app')
  const target = join(root, 'Applications/Centralu.app')
  mkdirSync(join(source, 'Contents/Resources/content'), { recursive: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'old'), 'old')
  writeFileSync(join(source, 'Contents/Resources/content/centralu-keeper'), 'new')
  chmodSync(join(source, 'Contents/Resources/content/centralu-keeper'), 0o755)
  expect(installLocalBundle(source, target)).toEqual({ replaced: true, leftAt: null })
  expect(readFileSync(join(target, 'Contents/Resources/content/centralu-keeper'), 'utf8')).toBe('new')
  expect(existsSync(join(target, 'old'))).toBe(false)
  expect(existsSync(`${target}.new`)).toBe(false)
})

it('keeps real signing behind approval, and runs no dependency installs or supplied scripts', () => {
  const workflow = readFileSync(resolve('.github/workflows/local-content-sign.yml'), 'utf8')
  expect(workflow).toContain("inputs.dry_run == false && 'npm-publish' || ''")
  expect(workflow).toContain("GITHUB_REF !== 'refs/heads/main'")
  expect(workflow).toContain('validateLocalManifest(bytes, readAppVersion())')
  expect(workflow.match(/ref: \$\{\{ github.sha \}\}/g)).toHaveLength(2)
  expect(readFileSync(resolve('scripts/content-manifest.mts'), 'utf8')).toContain('validateLocalManifest(manifest, readAppVersion())')
  expect(workflow).toContain('sign-local manifest-data/content-manifest.json')
  expect(workflow).not.toMatch(/pnpm install|npm install|eval\(/)
})


describe('the data-only manifest boundary', () => {
  it('derives the signing bounds from checkout data rather than an uploaded future release', () => {
    expect(readAppVersion()).toBe(APP_VERSION)
    const file = join(temp(), 'brand.ts')
    writeFileSync(file, `export const APP_VERSION = '${base}'\nthrow new Error('brand.ts must never execute')\n`)
    expect(readAppVersion(file)).toBe(base)
    writeFileSync(file, 'export const APP_VERSION = uploaded.version\n')
    expect(() => readAppVersion(file)).toThrow(/checked-out APP_VERSION is missing/)
    expect(() => validateLocalManifest(bytes(fixture()))).toThrow(/invalid version/)

    const future = `${APP_VERSION.split('-')[0]}-beta.999`
    const crafted = {
      ...fixture(), appVersion: `${future}.local.1`,
      local: { ...fixture().local, baseVersion: future, installedVersion: future, nextRelease: nextReleaseVersion(future) },
    }
    expect(() => validate(bytes(crafted))).toThrow(/baseVersion must match checked-out APP_VERSION/)
    expect(() => validate(bytes({ ...crafted, local: { ...crafted.local, baseVersion: APP_VERSION } }))).toThrow(/must be <base>\.local/)
    expect(() => validate(bytes({ ...fixture(), local: { ...fixture().local, nextRelease: crafted.local.nextRelease } }))).toThrow(/incorrect next release/)
  })

  it('accepts provenance and refuses changes across the manifest shape', () => {
    expect(validate(bytes(fixture())).local.dirty).toBe(true)
    const bad = [
      { platform: 'linux-x64' }, { platform: 'darwin-x64' }, { format: 2 }, { minShellVersion: 2 },
      { appVersion: base }, { appVersion: `${base}-local.1` }, { files: [] }, { local: {} }, { code: 'process.exit()' },
      { local: { ...fixture().local, dirty: 'true' } }, { local: { ...fixture().local, commit: 'bad' } },
      { local: { ...fixture().local, nextRelease: '9.0.0' } },
      { local: { ...fixture().local, installedVersion: `${APP_VERSION}.local.1` } },
    ]
    for (const mutation of bad) expect(() => validate(bytes({ ...fixture(), ...mutation })), JSON.stringify(mutation)).toThrow()
    for (const path of ['/host/a', 'host/../a', 'host/./a', 'host//a', 'host/a\\b', 'host/a\n', 'evil.mjs', 'host', 'content-manifest.json']) {
      const m = fixture(); m.files.push({ path, size: 1, sha256: 'a'.repeat(64), executable: false }); m.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
      expect(() => validate(bytes(m)), path).toThrow()
    }
    for (const mutation of [{ size: -1 }, { size: 1.5 }, { size: Number.MAX_SAFE_INTEGER + 1 }, { sha256: 'A'.repeat(64) }, { executable: 'true' }, { unknown: true }]) {
      const m = fixture(); Object.assign(m.files[0]!, mutation)
      expect(() => validate(bytes(m)), JSON.stringify(mutation)).toThrow()
    }
    const duplicate = fixture(); duplicate.files.push({ ...duplicate.files[0]!, path: 'Centralu-keeper' })
    expect(() => validate(bytes(duplicate))).toThrow()
    const prefix = fixture(); prefix.files.push({ path: 'host/node_modules', size: 0, sha256: 'a'.repeat(64), executable: false }); prefix.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    expect(() => validate(bytes(prefix))).toThrow(/also a directory/)
    const missing = fixture(); missing.files = missing.files.filter((f) => f.path !== 'host/main.mjs')
    expect(() => validate(bytes(missing))).toThrow(/required file/)
    const noExec = fixture(); noExec.files[0]!.executable = false
    expect(() => validate(bytes(noExec))).toThrow(/executable/)
  })

  it('sweeps the input byte limit and rejects malformed JSON and UTF-8', () => {
    const original = bytes(fixture())
    for (let length = MAX_LOCAL_MANIFEST_BYTES - 3; length <= MAX_LOCAL_MANIFEST_BYTES + 3; length++) {
      const input = Buffer.concat([original, Buffer.alloc(length - original.length, 32)])
      if (length <= MAX_LOCAL_MANIFEST_BYTES) expect(() => validate(input)).not.toThrow()
      else expect(() => validate(input)).toThrow(/size limit/)
    }
    for (const input of [Buffer.alloc(0), Buffer.from('{'), Buffer.from([0xff]), bytes(null), bytes([])]) expect(() => validate(input)).toThrow()
  })

  it('rehearses the exact workflow signer with a throwaway key and preserves the original bytes', () => {
    const root = temp()
    const content = join(root, 'content')
    mkdirSync(content)
    const m = fixture()
    // Populate real content so the generated manifest's hashes are real, then preserve odd
    // JSON whitespace: reserializing before signing would make verifyManifest fail below.
    for (const f of m.files) {
      mkdirSync(join(content, f.path, '..'), { recursive: true })
      writeFileSync(join(content, f.path), 'x')
      if (f.executable) chmodSync(join(content, f.path), 0o755)
    }
    const generated = JSON.parse(buildManifest(content, { appVersion: m.appVersion, platform: m.platform }).toString())
    // Windows cannot set Unix execute bits; the manifest is data at the signer boundary.
    generated.files.find((f: { path: string }) => f.path === 'centralu-keeper').executable = true
    const original = Buffer.from('  ' + JSON.stringify({ ...generated, local: m.local }, null, 4) + '\n\n')
    const manifestPath = join(content, MANIFEST_NAME)
    writeFileSync(manifestPath, original)
    const stdout = execFileSync(process.execPath, ['--experimental-strip-types', resolve('scripts/content-manifest.mts'), 'sign-local', manifestPath, '--dry-run'], { encoding: 'utf8', env: { ...process.env, CONTENT_SIGNING_KEY: 'invalid-secret-must-never-be-printed' } })
    expect(stdout).toContain('throwaway')
    expect(stdout).not.toContain('invalid-secret')
    expect(readFileSync(manifestPath).equals(original)).toBe(true)
    const signature = readFileSync(join(content, SIGNATURE_NAME))
    expect(JSON.parse(signature.toString()).comment).toContain('throwaway')
    expect(() => verifyManifest(original, signature, { keys: [] })).toThrow(/unknown key/)
    expect(() => execFileSync(process.execPath, ['--experimental-strip-types', resolve('scripts/content-manifest.mts'), 'sign-local', manifestPath], { stdio: 'pipe', env: { ...process.env, CONTENT_SIGNING_KEY: '' } })).toThrow()
  })

  it.skipIf(process.platform === 'win32')('rehearses both workflow run blocks locally without environment secrets', () => {
    const root = temp()
    for (const path of ['scripts/content-manifest.mts', 'scripts/local-manifest.mjs', 'packaging/npm/centralu/bin/semver.mjs', 'packaging/shell/keys.json', 'packages/protocol/src/brand.ts']) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      cpSync(resolve(path), join(root, path))
    }
    const workflow = readFileSync(resolve('.github/workflows/local-content-sign.yml'), 'utf8')
    const blocks = [...workflow.matchAll(/ {8}run: \|\n((?: {10}.*\n|\n)+)/g)].map((match) => match[1]!.split('\n').map((line) => line.slice(10)).join('\n'))
    expect(blocks).toHaveLength(2)
    const input = bytes(fixture())
    const summary = join(root, 'summary')
    const env = { ...process.env, INPUT_MANIFEST: input.toString('utf8'), DRY_RUN: 'true', GITHUB_REF: 'refs/heads/test', GITHUB_STEP_SUMMARY: summary, CONTENT_SIGNING_KEY: 'must-never-be-used' }
    for (const block of blocks) execFileSync('/bin/bash', ['-e', '-u', '-o', 'pipefail', '-c', block], { cwd: root, env, stdio: 'pipe' })
    expect(readFileSync(join(root, 'manifest-data', MANIFEST_NAME)).equals(input)).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'manifest-data', SIGNATURE_NAME), 'utf8')).comment).toContain('throwaway')
    expect(readFileSync(summary, 'utf8')).toContain('Dirty: true')
    expect(() => execFileSync('/bin/bash', ['-e', '-u', '-o', 'pipefail', '-c', blocks[0]!], { cwd: root, env: { ...env, DRY_RUN: 'false' }, stdio: 'pipe' })).toThrow(/real signing runs only from main/)

    const future = `${APP_VERSION.split('-')[0]}-beta.999`
    const crafted = bytes({
      ...fixture(), appVersion: `${future}.local.1`,
      local: { ...fixture().local, baseVersion: future, installedVersion: future, nextRelease: nextReleaseVersion(future) },
    })
    rmSync(join(root, 'manifest-data'), { recursive: true, force: true })
    expect(() => execFileSync('/bin/bash', ['-e', '-u', '-o', 'pipefail', '-c', blocks[0]!], {
      cwd: root, env: { ...env, INPUT_MANIFEST: crafted.toString('utf8') }, stdio: 'pipe',
    })).toThrow(/baseVersion must match checked-out APP_VERSION/)
    expect(existsSync(join(root, 'manifest-data', MANIFEST_NAME))).toBe(false)

    // The signer must independently refuse the same data if it reaches the artifact boundary.
    mkdirSync(join(root, 'manifest-data'))
    writeFileSync(join(root, 'manifest-data', MANIFEST_NAME), crafted)
    expect(() => execFileSync('/bin/bash', ['-e', '-u', '-o', 'pipefail', '-c', blocks[1]!], {
      cwd: root, env, stdio: 'pipe',
    })).toThrow(/baseVersion must match checked-out APP_VERSION/)
    expect(existsSync(join(root, 'manifest-data', SIGNATURE_NAME))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('dispatches only manifest data, watches the matching run and downloads only its signature using fake gh', async () => {
    const root = temp()
    const bin = join(root, 'bin'); mkdirSync(bin)
    const gh = join(bin, process.platform === 'win32' ? 'gh.cmd' : 'gh')
    const fake = join(bin, 'fake-gh.mjs')
    writeFileSync(fake, `import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
const root = process.env.CC_LOCAL_FAKE_GH;
const args = process.argv.slice(2);
appendFileSync(root + '/calls', JSON.stringify(args) + '\\n');
if (args[0] === 'workflow') writeFileSync(root + '/input', readFileSync(0));
if (args[1] === 'list') { const m = JSON.parse(readFileSync(root + '/input')).manifest; const j = JSON.parse(m); console.log(JSON.stringify([{ databaseId: 610, displayTitle: 'local-sign ' + j.appVersion + ' ' + j.local.requestId, url: 'https://example.test/run/610' }])); }
if (args[1] === 'download') { const dest = args[args.indexOf('--dir') + 1]; mkdirSync(dest, {recursive:true}); writeFileSync(dest + '/content-manifest.json.sig', 'signature-data'); }
`)
    writeFileSync(gh, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n` : `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`)
    chmodSync(gh, 0o755)
    const oldPath = process.env.PATH
    process.env.PATH = bin + (process.platform === 'win32' ? ';' : ':') + oldPath
    process.env.CC_LOCAL_FAKE_GH = root
    try {
      const original = bytes(fixture())
      const signature = await requestSignature(original, root)
      expect(readFileSync(signature, 'utf8')).toBe('signature-data')
      expect(JSON.parse(readFileSync(join(root, 'input'), 'utf8'))).toEqual({ manifest: original.toString('utf8'), dry_run: 'false' })
      const calls = readFileSync(join(root, 'calls'), 'utf8')
      expect(calls).toContain('"--ref","main"')
      expect(calls).toContain('"watch","610","--exit-status"')
      expect(calls).toContain('local-content-signature')
      expect(calls).not.toContain('api')
    } finally { process.env.PATH = oldPath; delete process.env.CC_LOCAL_FAKE_GH }
  })
})
