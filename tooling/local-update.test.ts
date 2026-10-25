import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { installLocalBundle, requestSignature, stampLocalVersion } from '../scripts/local-update.mjs'
import { buildManifest, MANIFEST_NAME, SIGNATURE_NAME, verifyManifest } from '../scripts/content-manifest.mjs'
import { fakeGh } from './fake-gh.test-helpers.js'
// @ts-expect-error — plain JavaScript policy runs in Actions without installing dependencies
import { assertLocalVersion, chooseLocalVersion, MAX_LOCAL_MANIFEST_BYTES, nextReleaseVersion, readReleaseBase, validateLocalManifest } from '../scripts/local-manifest.mjs'
// @ts-expect-error — plain JavaScript, shared with release-npm and bundle.mjs
import { stampedFiles } from '../scripts/stamp-version.mjs'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'cc-local-update-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const base = '0.2.0-beta.20'
const allowedBase = base
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
/**
 * A checkout holding `paths` of this repository, committed, with `tag` on it (none when null): since #1501 the base a
 * local build is cut from is the newest release tag reachable from the checkout's HEAD, not a file
 */
function taggedCheckout(paths: string[], tag: string | null = `v${base}`): string {
  const root = temp()
  for (const path of paths) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    cpSync(resolve(path), join(root, path))
  }
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'release')
  if (tag) git(root, 'tag', '-a', tag, '-m', tag)
  return root
}
const SIGNER = ['scripts/content-manifest.mts', 'scripts/local-manifest.mjs', 'scripts/app-version.mjs', 'packaging/npm/centralu/bin/semver.mjs', 'packaging/shell/keys.json']
function fixture() {
  const paths = ['centralu-keeper', 'host/main.mjs', 'host/bundle-info.json', 'host/schema.sql', 'host/node_modules/better-sqlite3/package.json', 'host/node_modules/node-pty/package.json']
  return {
    format: 1, appVersion: `${base}.local.1`, platform: 'darwin-arm64', minShellVersion: 1,
    files: paths.sort().map((path) => ({ path, size: 1, sha256: 'a'.repeat(64), executable: path === 'centralu-keeper' })),
    local: { baseVersion: base, installedVersion: base, nextRelease: nextReleaseVersion(base), commit: 'a'.repeat(40), dirty: true, requestId: 'b'.repeat(32) },
  }
}
const bytes = (m: unknown) => Buffer.from(`${JSON.stringify(m, null, 2)}\n`)
const validate = (input: Buffer) => validateLocalManifest(input, base)

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
  it('stamps the version the UI and host compile in and the window reads, which it passes to the keeper (#1501)', () => {
    const root = temp()
    for (const path of [...(stampedFiles() as string[]), 'apps/desktop/src-tauri/Cargo.toml']) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      cpSync(resolve(path), join(root, path))
    }
    const version = `${base}.local.2`
    stampLocalVersion(root, version)
    expect(readFileSync(join(root, 'packages/protocol/src/version.generated.ts'), 'utf8')).toContain(`export const APP_VERSION: string = '${version}'`)
    // The bundle's version (Info.plist) and what the window reads at run time, then gives the keeper as --app-version
    expect(JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')).version).toBe(version)
    expect(JSON.parse(readFileSync(join(root, 'packaging/npm/centralu/package.json'), 'utf8')).version).toBe(version)
    // Nothing compiled into Rust any more: Cargo.toml keeps the placeholder
    expect(readFileSync(join(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8')).toBe(readFileSync(resolve('apps/desktop/src-tauri/Cargo.toml'), 'utf8'))
  })
})

// ditto and the launcher swap are macOS's: the app bundle is installed by a local update on darwin-arm64 only
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
  expect(workflow).toContain('validateLocalManifest(bytes, readReleaseBase())')
  // Both jobs read the base from the release tags, which a shallow checkout lacks (#1501)
  expect(workflow.match(/ {10}fetch-depth: 0\n {10}filter: blob:none\n/g)).toHaveLength(2)
  expect(workflow.match(/ref: \$\{\{ github.sha \}\}/g)).toHaveLength(2)
  expect(readFileSync(resolve('scripts/content-manifest.mts'), 'utf8')).toContain('validateLocalManifest(manifest, readReleaseBase())')
  expect(workflow).toContain('sign-local manifest-data/content-manifest.json')
  expect(workflow).not.toMatch(/pnpm install|npm install|eval\(/)
})


describe('the data-only manifest boundary', () => {
  it('derives the signing bounds from checkout data rather than an uploaded future release', () => {
    // The newest release tag reachable from the checkout's HEAD; another tag is not a release
    expect(readReleaseBase(taggedCheckout(['scripts/local-manifest.mjs']))).toBe(base)
    const untagged = taggedCheckout(['scripts/local-manifest.mjs'], 'nightly')
    expect(() => readReleaseBase(untagged)).toThrow(/no release tag \(v\*\) is reachable/)
    expect(() => validateLocalManifest(bytes(fixture()))).toThrow(/invalid version/)

    const future = `${base.split('-')[0]}-beta.999`
    const crafted = {
      ...fixture(), appVersion: `${future}.local.1`,
      local: { ...fixture().local, baseVersion: future, installedVersion: future, nextRelease: nextReleaseVersion(future) },
    }
    expect(() => validate(bytes(crafted))).toThrow(/baseVersion must match the release tag of the checkout/)
    expect(() => validate(bytes({ ...crafted, local: { ...crafted.local, baseVersion: base } }))).toThrow(/must be <base>\.local/)
    expect(() => validate(bytes({ ...fixture(), local: { ...fixture().local, nextRelease: crafted.local.nextRelease } }))).toThrow(/incorrect next release/)
  })

  it('accepts provenance and refuses changes across the manifest shape', () => {
    expect(validate(bytes(fixture())).local.dirty).toBe(true)
    const bad = [
      { platform: 'linux-x64' }, { platform: 'darwin-x64' }, { format: 2 }, { minShellVersion: 2 },
      { appVersion: base }, { appVersion: `${base}-local.1` }, { files: [] }, { local: {} }, { code: 'process.exit()' },
      { local: { ...fixture().local, dirty: 'true' } }, { local: { ...fixture().local, commit: 'bad' } },
      { local: { ...fixture().local, nextRelease: '9.0.0' } },
      { local: { ...fixture().local, installedVersion: `${base}.local.1` } },
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
    // The signer in a checkout released as the fixture's base, as the workflow's is
    const checkout = taggedCheckout(SIGNER)
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
    const stdout = execFileSync(process.execPath, ['--experimental-strip-types', join(checkout, 'scripts/content-manifest.mts'), 'sign-local', manifestPath, '--dry-run'], { encoding: 'utf8', env: { ...process.env, CONTENT_SIGNING_KEY: 'invalid-secret-must-never-be-printed' } })
    expect(stdout).toContain('throwaway')
    expect(stdout).not.toContain('invalid-secret')
    expect(readFileSync(manifestPath).equals(original)).toBe(true)
    const signature = readFileSync(join(content, SIGNATURE_NAME))
    expect(JSON.parse(signature.toString()).comment).toContain('throwaway')
    expect(() => verifyManifest(original, signature, { keys: [] })).toThrow(/unknown key/)
    expect(() => execFileSync(process.execPath, ['--experimental-strip-types', join(checkout, 'scripts/content-manifest.mts'), 'sign-local', manifestPath], { stdio: 'pipe', env: { ...process.env, CONTENT_SIGNING_KEY: '' } })).toThrow()
  })

  // The workflow's run blocks are bash for GitHub's Linux runner (they are what this runs), and a local update is
  // darwin-arm64 only (`pnpm local-update` refuses anywhere else), so there is no Windows run of either to check
  it.skipIf(process.platform === 'win32')('rehearses both workflow run blocks locally without environment secrets', () => {
    const root = taggedCheckout(SIGNER)
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

    const future = `${base.split('-')[0]}-beta.999`
    const crafted = bytes({
      ...fixture(), appVersion: `${future}.local.1`,
      local: { ...fixture().local, baseVersion: future, installedVersion: future, nextRelease: nextReleaseVersion(future) },
    })
    rmSync(join(root, 'manifest-data'), { recursive: true, force: true })
    expect(() => execFileSync('/bin/bash', ['-e', '-u', '-o', 'pipefail', '-c', blocks[0]!], {
      cwd: root, env: { ...env, INPUT_MANIFEST: crafted.toString('utf8') }, stdio: 'pipe',
    })).toThrow(/baseVersion must match the release tag of the checkout/)
    expect(existsSync(join(root, 'manifest-data', MANIFEST_NAME))).toBe(false)

    // The signer must independently refuse the same data if it reaches the artifact boundary.
    mkdirSync(join(root, 'manifest-data'))
    writeFileSync(join(root, 'manifest-data', MANIFEST_NAME), crafted)
    expect(() => execFileSync('/bin/bash', ['-e', '-u', '-o', 'pipefail', '-c', blocks[1]!], {
      cwd: root, env, stdio: 'pipe',
    })).toThrow(/baseVersion must match the release tag of the checkout/)
    expect(existsSync(join(root, 'manifest-data', SIGNATURE_NAME))).toBe(false)
  })

  // requestSignature is only reached after `pnpm local-update` has checked for darwin-arm64, so Windows never runs it
  it.skipIf(process.platform === 'win32')('dispatches only manifest data, watches the matching run and downloads only its signature using fake gh', async () => {
    const root = temp()
    // `gh workflow run --json` reads the inputs on stdin, without `--input`
    const gh = fakeGh(root, String.raw`
if (args[0] === 'workflow') { st.input = fs.readFileSync(0, 'utf8'); save() }
if (args[1] === 'list') { const j = JSON.parse(JSON.parse(st.input).manifest); console.log(JSON.stringify([{ databaseId: 610, displayTitle: 'local-sign ' + j.appVersion + ' ' + j.local.requestId, url: 'https://example.test/run/610' }])) }
if (args[1] === 'download') { const dest = args[args.indexOf('--dir') + 1]; fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(dest + '/content-manifest.json.sig', 'signature-data') }
`)
    // requestSignature runs gh with this process's environment: the fake goes first on its PATH
    const env = gh.env()
    vi.stubEnv('PATH', [gh.bin, process.env.PATH].join(delimiter))
    vi.stubEnv('FAKE_GH_STATE', env.FAKE_GH_STATE)
    vi.stubEnv('FAKE_GH_LOG', env.FAKE_GH_LOG)
    const original = bytes(fixture())
    const signature = await requestSignature(original, root, base)
    expect(readFileSync(signature, 'utf8')).toBe('signature-data')
    expect(JSON.parse(gh.state().input)).toEqual({ manifest: original.toString('utf8'), dry_run: 'false' })
    const calls = JSON.stringify(gh.calls().map((c) => c.args))
    expect(calls).toContain('"--ref","main"')
    expect(calls).toContain('"watch","610","--exit-status"')
    expect(calls).toContain('local-content-signature')
    expect(calls).not.toContain('api')
  })
})
