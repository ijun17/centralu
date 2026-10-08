/**
 * The shell's bundle (docs/plans/thin-shell.md §3, §6.1): build `centralu-shell`, put it in
 * `Centralu.app` with its Info.plist and icon, sign it ad hoc, zip it reproducibly, and describe the
 * result as a `packaging/shell/shell.lock` entry. And the lock itself: reading it, and fetching and
 * checking a pinned asset.
 *
 * Who calls this:
 *   - `.github/workflows/shell-release.yml`, once per shell version, to make the bytes every
 *     release then ships (`build`);
 *   - `scripts/shell-integration.mts`, for debug builds, one of them trusting a test key;
 *   - later, the app's release (thin-shell plan §10, step 4), to put the pinned asset into the
 *     window's bundle: `fetchPinned` downloads it and refuses it unless its sha256 is the lock's.
 *
 * **Why pinned, and why a zip.** macOS identifies an ad-hoc signed app by its cdhash, so a rebuilt
 * shell is a new app and every grant is gone; a rebuild of the same source is not promised to give
 * the same bytes. So the shell is built once and its zip is what is pinned: the zip's sha256 covers
 * every file, mode and the signature in one number, and the cdhash says which identity macOS will
 * see. The zip is made reproducibly from a given bundle (fixed times, no extended attributes,
 * quarantine, ACLs or resource forks: `ditto -c -k --keepParent --norsrc --noextattr --noqtn
 * --noacl`), so zipping the same bundle twice gives the same hash; the workflow checks that.
 *
 *   tsx scripts/shell-bundle.mts build --out <dir> [--debug] [--target-dir <dir>] [--json <file>]
 *
 * Never with a test key here: `--test-key` exists only on `buildShellExe` for the integration test,
 * and a release build with the `test-key` feature does not compile (shell/src/keys.rs).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const TAURI_DIR = join(ROOT, 'apps/desktop/src-tauri')
export const SHELL_DIR = join(TAURI_DIR, 'shell')
export const LOCK_FILE = join(ROOT, 'packaging/shell/shell.lock')
export const APP_DIR_NAME = 'Centralu.app'
export const EXE_NAME = 'centralu-shell'
export const BUNDLE_ID = 'app.centralu.agent'
export const REPO = 'ijun17/centralu'
export const LOCK_FORMAT = 1
/** Every file and folder in the zip gets this time, so the zip depends only on the bundle's bytes */
const FIXED_TIME = new Date('2001-01-01T00:00:00Z')

export interface LockEntry {
  version: number
  platform: string
  sha256: string
  cdhash: string
  url: string
}

/** `SHELL_VERSION` as the source declares it (shell/src/lib.rs) */
export function shellVersionInSource(): number {
  const m = readFileSync(join(SHELL_DIR, 'src/lib.rs'), 'utf8').match(/^pub const SHELL_VERSION: u64 = (\d+);$/m)
  if (!m) throw new Error('SHELL_VERSION not found in shell/src/lib.rs')
  return Number(m[1])
}

/** `CentraluShellVersion` in the shell's Info.plist */
export function plistShellVersion(plist = readFileSync(join(SHELL_DIR, 'Info.plist'), 'utf8')): number | undefined {
  const m = plist.match(/<key>CentraluShellVersion<\/key>\s*<integer>(\d+)<\/integer>/)
  return m ? Number(m[1]) : undefined
}

export const releaseTag = (version: number) => `shell-v${version}`
export const assetName = (version: number, platform: string) => `Centralu-shell-v${version}-${platform}.zip`
export const assetUrl = (version: number, platform: string) =>
  `https://github.com/${REPO}/releases/download/${releaseTag(version)}/${assetName(version, platform)}`
export const shellPlatform = () => `${process.platform}-${process.arch}`

/** The lock's entries, checked. A malformed lock is an error, never an empty one. */
export function readLock(file = LOCK_FILE): LockEntry[] {
  const json = JSON.parse(readFileSync(file, 'utf8')) as { format?: unknown; shells?: unknown }
  if (json.format !== LOCK_FORMAT) throw new Error(`${file}: format ${String(json.format)} is not ${LOCK_FORMAT}`)
  if (!Array.isArray(json.shells)) throw new Error(`${file}: "shells" is not a list`)
  const seen = new Set<string>()
  return json.shells.map((raw: unknown, i: number) => {
    const e = raw as Partial<LockEntry>
    const where = `${file}: shells[${i}]`
    if (!Number.isInteger(e.version) || (e.version as number) < 1) throw new Error(`${where}: version must be a positive integer`)
    if (typeof e.platform !== 'string' || !/^[a-z0-9]+-[a-z0-9]+$/.test(e.platform)) throw new Error(`${where}: platform`)
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) throw new Error(`${where}: sha256 must be 64 lowercase hex`)
    if (typeof e.cdhash !== 'string' || !/^[0-9a-f]{40}$/.test(e.cdhash)) throw new Error(`${where}: cdhash must be 40 lowercase hex`)
    const version = e.version as number
    if (e.url !== assetUrl(version, e.platform)) throw new Error(`${where}: url must be ${assetUrl(version, e.platform)}`)
    const key = `${version} ${e.platform}`
    if (seen.has(key)) throw new Error(`${where}: shell ${version} for ${e.platform} is listed twice`)
    seen.add(key)
    return { version, platform: e.platform, sha256: e.sha256, cdhash: e.cdhash, url: e.url }
  })
}

export function lockEntryFor(version: number, platform: string, entries = readLock()): LockEntry | undefined {
  return entries.find((e) => e.version === version && e.platform === platform)
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * `cargo build -p centralu-shell`. `testKey` (a base64 raw ed25519 public key) builds the debug test
 * shell for the integration test; it is refused together with `release`, which would not compile
 * anyway.
 */
export function buildShellExe(opts: { targetDir: string; release: boolean; testKey?: string }): string {
  if (opts.testKey && opts.release) throw new Error('a test key goes only into a debug build of the shell')
  const env = { ...process.env }
  delete env.CENTRALU_SHELL_TEST_KEY
  if (opts.testKey) env.CENTRALU_SHELL_TEST_KEY = opts.testKey
  const args = ['build', '--manifest-path', join(TAURI_DIR, 'Cargo.toml'), '-p', 'centralu-shell', '--target-dir', opts.targetDir]
  if (opts.release) args.push('--release')
  if (opts.testKey) args.push('--features', 'test-key')
  execFileSync('cargo', args, { stdio: ['ignore', 'inherit', 'inherit'], env })
  const exe = join(opts.targetDir, opts.release ? 'release' : 'debug', EXE_NAME)
  if (!existsSync(exe)) throw new Error(`cargo did not produce ${exe}`)
  return exe
}

/** `<outDir>/Centralu.app` from `exe`, signed ad hoc as `app.centralu.agent`. Returns its path. */
export function assembleBundle(exe: string, outDir: string): string {
  const app = join(outDir, APP_DIR_NAME)
  rmSync(app, { recursive: true, force: true })
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true })
  copyFileSync(join(SHELL_DIR, 'Info.plist'), join(app, 'Contents/Info.plist'))
  copyFileSync(exe, join(app, 'Contents/MacOS', EXE_NAME))
  chmodSync(join(app, 'Contents/MacOS', EXE_NAME), 0o755)
  copyFileSync(join(TAURI_DIR, 'icons/icon.icns'), join(app, 'Contents/Resources/icon.icns'))
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', BUNDLE_ID, app], { stdio: ['ignore', 'ignore', 'inherit'] })
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', app], { stdio: ['ignore', 'ignore', 'inherit'] })
  return app
}

/** Every path under `dir`, deepest first */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (lstatSync(p).isDirectory()) out.push(...walk(p))
    out.push(p)
  }
  return out
}

/**
 * Zips `app` into `zip` so the same bundle, zipped by the same user, always gives the same bytes.
 * ditto records each entry's owner and group (Info-ZIP's "UX" field) besides its time: a file created
 * under /tmp takes the folder's group (wheel) rather than the user's (staff), and that alone changed
 * the hash when measured, so the group is set to the user's own first.
 */
export function zipBundle(app: string, zip: string): void {
  const uid = process.getuid?.() ?? 0
  const gid = process.getgid?.() ?? 0
  for (const p of [...walk(app), app]) {
    chownSync(p, uid, gid)
    utimesSync(p, FIXED_TIME, FIXED_TIME)
  }
  rmSync(zip, { force: true })
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', '--noqtn', '--noacl', app, zip])
}

/** codesign's `CDHash=` for the bundle: the identity macOS gives this build */
export function cdhashOf(app: string): string {
  // `codesign -d` describes on stderr
  const r = spawnSync('/usr/bin/codesign', ['-d', '-vvv', app], { encoding: 'utf8' })
  const cdhash = parseCdhash(`${r.stdout}\n${r.stderr}`)
  if (r.status !== 0 || !cdhash) throw new Error(`no CDHash in codesign's description of ${app}: ${r.stderr}`)
  return cdhash
}

export function parseCdhash(details: string): string | undefined {
  return details.match(/^CDHash=([0-9a-f]{40})$/m)?.[1]
}

/** Builds, bundles, signs and zips the shell; describes it as a lock entry */
export function build(opts: { out: string; release: boolean; targetDir: string }): LockEntry & { zip: string; app: string } {
  const version = shellVersionInSource()
  if (plistShellVersion() !== version) throw new Error(`Info.plist says shell ${plistShellVersion()}, src/lib.rs says ${version}`)
  mkdirSync(opts.out, { recursive: true })
  const exe = buildShellExe({ targetDir: opts.targetDir, release: opts.release })
  const app = assembleBundle(exe, opts.out)
  const platform = shellPlatform()
  const zip = join(opts.out, assetName(version, platform))
  zipBundle(app, zip)
  return { version, platform, sha256: sha256File(zip), cdhash: cdhashOf(app), url: assetUrl(version, platform), zip, app }
}

/**
 * The pinned shell: downloads its asset to `dest` and checks the zip's sha256 against the lock
 * before anything else reads it. Returns `dest`.
 */
export async function fetchPinned(entry: LockEntry, dest: string): Promise<string> {
  const res = await fetch(entry.url)
  if (!res.ok) throw new Error(`could not download ${entry.url}: HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== entry.sha256) throw new Error(`${entry.url} has sha256 ${got}; shell.lock pins ${entry.sha256}`)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, bytes)
  return dest
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command] = process.argv.slice(2)
  const flag = (name: string) => {
    const i = process.argv.indexOf(name)
    return i === -1 ? undefined : process.argv[i + 1]
  }
  if (command === 'build') {
    const out = flag('--out')
    if (!out) throw new Error('--out is required')
    const entry = build({
      out,
      release: !process.argv.includes('--debug'),
      targetDir: flag('--target-dir') ?? join(TAURI_DIR, 'target'),
    })
    const json = flag('--json')
    if (json) writeFileSync(json, `${JSON.stringify(entry, null, 2)}\n`)
    console.log(JSON.stringify(entry, null, 2))
  } else if (command === 'zip' && process.argv[3] && process.argv[4]) {
    // The workflow's check that the zip depends only on the bundle
    zipBundle(process.argv[3], process.argv[4])
    console.log(sha256File(process.argv[4]))
  } else {
    console.error('usage: shell-bundle.mts build --out <dir> [--debug] [--target-dir <dir>] [--json <file>] | zip <app> <zip>')
    process.exit(2)
  }
}
