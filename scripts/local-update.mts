/** Local release build; only its manifest goes to the environment-gated signer. */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error — plain .mjs, as the other scripts import theirs
import { isMain } from './is-main.mjs'
import { checkStaged, CONTENT_IN_BUNDLE, shellToCarry, stageBundle, stageContent } from './bundle-stage.mjs'
import { MANIFEST_NAME, SIGNATURE_NAME, throwawayKey, trustedKeys, verifyContent } from './content-manifest.mjs'
import { lockEntryFor, readLock, shellVersionInSource } from './shell-bundle.mjs'
// @ts-expect-error — dependency-free JavaScript shared with the workflow
import { assertLocalVersion, chooseLocalVersion, nextReleaseVersion, readReleaseBase, validateLocalManifest } from './local-manifest.mjs'
// @ts-expect-error — dependency-free JavaScript, shared with release-npm and bundle.mjs
import { stampVersion } from './stamp-version.mjs'
// @ts-expect-error — reuse the npm launcher's atomic install, which has no declaration file
import { swapInto } from '../packaging/npm/centralu/bin/swap.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = 'local-content-sign.yml'
const run = (cmd: string, args: string[], cwd = ROOT, env = process.env) =>
  execFileSync(cmd, args, { cwd, env, stdio: 'inherit' })
const output = (cmd: string, args: string[], cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()

export function installedVersion(target: string): string {
  return output('/usr/bin/defaults', ['read', join(target, 'Contents/Info.plist'), 'CFBundleShortVersionString'])
}

/** Identical copy and swap to `centralu install`; called only after content verification. */
export function installLocalBundle(bundle: string, target: string): { replaced: boolean; leftAt: string | null } {
  return swapInto(target, (staging: string) => run('/usr/bin/ditto', [bundle, staging]))
}

/**
 * Stamp only the disposable checkout (#1501, `stamp-version.mjs`): the UI and host read
 * version.generated.ts, the bundle and the window tauri.conf.json, and the window passes its version
 * to the keeper. Nothing is compiled into Rust any more, so Cargo.toml stays at the placeholder.
 */
export function stampLocalVersion(root: string, version: string): void {
  ;(stampVersion as (root: string, version: string) => string[])(root, version)
}

export async function requestSignature(manifest: Buffer, work: string, base: string, ref = 'main'): Promise<string> {
  const m = validateLocalManifest(manifest, base)
  // stdin preserves newlines and avoids both shell interpolation and command-line size limits.
  execFileSync('gh', ['workflow', 'run', WORKFLOW, '--ref', ref, '--json'], {
    cwd: ROOT, input: JSON.stringify({ manifest: manifest.toString('utf8'), dry_run: 'false' }), stdio: ['pipe', 'inherit', 'inherit'],
  })
  const title = `local-sign ${m.appVersion} ${m.local.requestId}`
  let id: number | undefined
  for (let attempt = 0; attempt < 60; attempt++) {
    const runs = JSON.parse(output('gh', ['run', 'list', '--workflow', WORKFLOW, '--event', 'workflow_dispatch', '--limit', '100', '--json', 'databaseId,displayTitle,url'])) as { databaseId: number; displayTitle: string; url: string }[]
    const found = runs.find((r) => r.displayTitle === title)
    if (found) {
      id = found.databaseId
      console.log(`Signing run: ${found.url}`)
      console.log(`Approval: gh api repos/{owner}/{repo}/actions/runs/${id}/pending_deployments`)
      break
    }
    await new Promise((done) => setTimeout(done, 2000))
  }
  if (!id) throw new Error('dispatched run was not found; inspect gh run list before retrying')
  console.log('Waiting for the npm-publish environment approval and completion. This command never approves its own run.')
  run('gh', ['run', 'watch', String(id), '--exit-status', '--interval', '10'])
  const dest = join(work, 'signature')
  rmSync(dest, { recursive: true, force: true })
  run('gh', ['run', 'download', String(id), '--name', 'local-content-signature', '--dir', dest])
  return join(dest, SIGNATURE_NAME)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('pnpm local-update [--target /Applications/Centralu.app] [--version <base>.local.N] [--dry-run | --plan]\n--dry-run builds and signs with a throwaway key locally; never dispatches or installs.\n--plan checks platform/version and prints the plan without building, dispatching or installing.')
    return
  }
  for (let i = 0; i < args.length; i++) {
    if (['--target', '--version'].includes(args[i]!)) {
      if (!args[++i] || args[i]!.startsWith('--')) throw new Error('option requires a value')
    } else if (!['--dry-run', '--plan'].includes(args[i]!)) throw new Error(`unknown option: ${args[i]}`)
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('local updates require native darwin-arm64')
  const flag = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
  const target = resolve(flag('--target') ?? '/Applications/Centralu.app')
  const installed = installedVersion(target)
  // The release this checkout was cut from: its newest reachable release tag, as the signing workflow reads it
  const BASE = readReleaseBase(ROOT) as string
  const version = chooseLocalVersion(BASE, installed, flag('--version')) as string
  console.log(`Local update: ${installed} → ${version} (next release: ${nextReleaseVersion(BASE)}) at ${target}`)
  if (args.includes('--plan')) return
  // Persistent temporary Cargo cache makes subsequent local updates incremental. The lock covers
  // snapshot creation through install; it is separate from the machine-wide Playwright lock.
  const work = join(tmpdir(), 'centralu-local-update')
  mkdirSync(work, { recursive: true })
  const lock = join(work, 'lock')
  mkdirSync(lock)
  console.log(`Build and staged artifacts: ${work}`)
  try {
    const commit = output('git', ['rev-parse', 'HEAD'])
    const dirty = output('git', ['status', '--porcelain']) !== ''
    const source = join(work, 'source')
    rmSync(source, { recursive: true, force: true })
    run('git', ['clone', '--shared', '--no-checkout', ROOT, source])
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    for (const path of new Set(files)) {
      const from = join(ROOT, path)
      if (!existsSync(from)) continue // locally deleted tracked files stay deleted
      const to = join(source, path)
      mkdirSync(dirname(to), { recursive: true })
      cpSync(from, to, { recursive: true, dereference: true })
    }
    stampLocalVersion(source, version)
    const env: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: join(work, 'cargo-target'), CC_DATA_DIR: join(work, 'data') }
    delete env.CONTENT_SIGNING_KEY
    delete env.CONTENT_SIGNING_KEY_NEXT
    run('pnpm', ['install', '--frozen-lockfile'], source, env)
    // The same release build as release-npm.mts: beforeBuildCommand bundles the host and UI,
    // Tauri builds the window and keeper, and only the app bundle (no Finder/DMG automation).
    run('pnpm', ['--filter', '@cc/desktop', 'exec', 'tauri', 'build', '--bundles', 'app'], source, env)
    const bundle = join(work, 'cargo-target/release/bundle/macos/Centralu.app')
    const key = throwawayKey()
    const contentDir = join(work, 'content')
    const original = stageContent(contentDir, { bundle, key, platform: 'darwin-arm64', appVersion: version })
    const manifest = Buffer.from(`${JSON.stringify({
      ...JSON.parse(original.toString('utf8')),
      local: { baseVersion: BASE, installedVersion: installed, nextRelease: nextReleaseVersion(BASE), commit, dirty, requestId: randomBytes(16).toString('hex') },
    }, null, 2)}\n`)
    validateLocalManifest(manifest, BASE)
    writeFileSync(join(contentDir, MANIFEST_NAME), manifest)
    // Fetch the release-pinned shell; never build a new identity for a local update.
    const lockEntries = readLock()
    if (!lockEntryFor(shellVersionInSource(), 'darwin-arm64', lockEntries)) throw new Error('local update requires the release-pinned shell in shell.lock')
    const shell = await shellToCarry({ usePinned: true, out: join(work, 'shell'), targetDir: join(work, 'cargo-target'), lock: lockEntries })
    if (!shell.pinned) throw new Error('local update requires the release-pinned shell in shell.lock')
    const dryRun = args.includes('--dry-run')
    if (dryRun) {
      run(process.execPath, ['--experimental-strip-types', join(ROOT, 'scripts/content-manifest.mts'), 'sign-local', join(contentDir, MANIFEST_NAME), '--dry-run'])
    } else {
      cpSync(await requestSignature(manifest, work, BASE), join(contentDir, SIGNATURE_NAME))
    }
    // The dry-run signer generated its own key and verified internally; it is intentionally
    // untrusted. Real installs must verify against the exact keys already compiled into the shell.
    if (dryRun) {
      console.log(`Dry run complete: ${contentDir}. Throwaway signature is not installable.`)
      return
    }
    const keys = trustedKeys()
    verifyContent(contentDir, { keys, platform: 'darwin-arm64' })
    stageBundle(bundle, { shell, contentDir })
    checkStaged(bundle, { keys, platform: 'darwin-arm64', manifest, lock: shell.lock })
    if (installedVersion(bundle) !== version) throw new Error('bundle version does not match the signed manifest')
    // Approval may take hours. Never replace a newer app installed during that wait.
    assertLocalVersion(version, BASE, installedVersion(target))
    const { leftAt } = installLocalBundle(bundle, target)
    if (leftAt) console.log(`Previous copy left at ${leftAt}; remove it after it is no longer in use.`)
    verifyContent(join(target, CONTENT_IN_BUNDLE), { keys, platform: 'darwin-arm64' })
    console.log(`Installed ${version} at ${target}. The window running from this path can now offer Apply now.`)
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

if (isMain(import.meta.url)) {
  await main().catch((e: Error) => {
    console.error(`local-update: ${e.message}`)
    process.exitCode = 1
  })
}
