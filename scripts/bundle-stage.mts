/**
 * Puts the macOS shell and the signed content into the window's bundle (docs/plans/thin-shell.md
 * §10 step 4, §10.2):
 *
 *   Centralu.app/Contents/Resources/shell/Centralu.app   the shell, copied out to <data>/shell/ by the window
 *   Centralu.app/Contents/Resources/shell/shell.json     { format 1, version, tree, pinned }
 *   Centralu.app/Contents/Resources/content/             centralu-keeper, host/, content-manifest.json(.sig)
 *
 * The window installs the shell from there and opens it with `--content` naming that folder
 * (`apps/desktop/src-tauri/src/shell`). **What is signed is exactly what ships**: the content is signed
 * in a folder of its own (`target/release/content/`, which the release workflow keeps as an
 * artifact), copied into the bundle, and the copy inside the bundle is verified again after the
 * window's bundle has been re-signed. The keeper in the content is the one the bundle carries in
 * `Contents/MacOS` (the bundler signed it, which changed its bytes), and the host is the bundle's own
 * `Contents/Resources/resources/host`.
 *
 * **Which shell.** A publish takes the asset `packaging/shell/shell.lock` pins for the shell version
 * in the source: downloaded, its zip's sha256 and the bundle's cdhash checked against the lock, and
 * marked `pinned`. Without a lock entry, in a rehearsal and in a local `pnpm app`, the shell is built
 * here and marked unpinned; the window neither installs nor opens an unpinned shell (it starts the
 * keeper directly and says so in keeper.log only), because its bytes are not the ones people's
 * permissions should attach to. `tree` is the hash of the shell's files the window checks its copy
 * against (`treeHash`; the same as `tree_hash` in src/shell/install.rs).
 *
 * **The window's signature.** Adding files to a signed bundle breaks its seal, so the bundle is signed
 * again ad hoc, keeping what the bundler set (identifier, entitlements, requirements, flags, hardened
 * runtime), without `--deep`: nothing inside is re-signed, so the shell and the keeper keep their bytes.
 *
 *   pnpm exec tsx scripts/bundle-stage.mts <Centralu.app> [--target-dir <dir>]   # local: unpinned, throwaway key
 *
 * `pnpm app` runs that after `tauri build`; `scripts/release-npm.mts` calls `stageBundle` itself.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { APP_VERSION } from '../packages/protocol/src/brand.js'
import { MANIFEST_NAME, throwawayKey, verifyContent, writeContentManifest, type SigningKey, type TrustedKey } from './content-manifest.mjs'
import {
  APP_DIR_NAME,
  build as buildShell,
  cdhashOf,
  fetchPinned,
  lockEntryFor,
  plistShellVersion,
  readLock,
  shellPlatform,
  shellVersionInSource,
  TAURI_DIR,
  type LockEntry,
} from './shell-bundle.mjs'

export const SHELL_IN_BUNDLE = 'Contents/Resources/shell'
export const SHELL_DESCRIPTOR = 'shell.json'
export const CONTENT_IN_BUNDLE = 'Contents/Resources/content'
export const KEEPER_EXE = 'centralu-keeper'
/** The keeper and the host as the bundle carries them, which the content is made from */
export const KEEPER_IN_BUNDLE = `Contents/MacOS/${KEEPER_EXE}`
export const HOST_IN_BUNDLE = 'Contents/Resources/resources/host'

export interface ShellDescriptor {
  format: 1
  version: number
  tree: string
  pinned: boolean
}

export interface CarriedShell {
  app: string
  version: number
  pinned: boolean
  /** The lock entry it was checked against, when pinned */
  lock?: LockEntry
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/**
 * The hash of a bundle's files (src/shell/install.rs `tree_hash`): SHA-256 over one line per regular
 * file, sorted by the UTF-8 bytes of its `/`-separated path, `<x|-> <sha256> <path>\n`, `x` when any
 * execute bit is set. A symlink, any other kind of file or a control character in a name is an error.
 */
export function treeHash(dir: string): string {
  const files: { rel: string; abs: string; exec: boolean }[] = []
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d)) {
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error(`${JSON.stringify(name)} in ${d} has a control character`)
      const abs = join(d, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const st = lstatSync(abs)
      if (st.isDirectory()) walk(abs, rel)
      else if (st.isFile()) files.push({ rel, abs, exec: (st.mode & 0o111) !== 0 })
      else throw new Error(`${rel} is not a regular file or a folder`)
    }
  }
  walk(dir, '')
  files.sort((a, b) => Buffer.compare(Buffer.from(a.rel, 'utf8'), Buffer.from(b.rel, 'utf8')))
  return sha256(files.map((f) => `${f.exec ? 'x' : '-'} ${sha256(readFileSync(f.abs))} ${f.rel}\n`).join(''))
}

/**
 * The shell to carry: the pinned asset when `usePinned` and the lock has an entry for this shell
 * version and platform, else one built here (unpinned).
 */
export async function shellToCarry(opts: { usePinned: boolean; out: string; targetDir: string; lock?: LockEntry[] }): Promise<CarriedShell> {
  const version = shellVersionInSource()
  const entry = opts.usePinned ? lockEntryFor(version, shellPlatform(), opts.lock ?? readLock()) : undefined
  rmSync(opts.out, { recursive: true, force: true })
  mkdirSync(opts.out, { recursive: true })
  if (!entry) {
    const built = buildShell({ out: opts.out, release: true, targetDir: opts.targetDir })
    return { app: built.app, version: built.version, pinned: false }
  }
  const zip = await fetchPinned(entry, join(opts.out, 'pinned.zip'))
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, opts.out])
  const app = join(opts.out, APP_DIR_NAME)
  const cdhash = cdhashOf(app)
  if (cdhash !== entry.cdhash) throw new Error(`the pinned shell's cdhash is ${cdhash}; shell.lock pins ${entry.cdhash}`)
  const inPlist = plistShellVersion(readFileSync(join(app, 'Contents/Info.plist'), 'utf8'))
  if (inPlist !== entry.version) throw new Error(`the pinned shell says version ${inPlist}; shell.lock says ${entry.version}`)
  return { app, version: entry.version, pinned: true, lock: entry }
}

/**
 * Writes the content into `dir` from the bundle's keeper and host, and signs it. Returns the
 * manifest's bytes, which the copy in the bundle must still have.
 */
export function stageContent(dir: string, opts: { bundle: string; key: SigningKey; platform: string; appVersion?: string }): Buffer {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // `dereference`: a symlink in the host would be refused by the manifest and dropped by npm.
  cpSync(join(opts.bundle, HOST_IN_BUNDLE), join(dir, 'host'), { recursive: true, dereference: true })
  cpSync(join(opts.bundle, KEEPER_IN_BUNDLE), join(dir, KEEPER_EXE))
  chmodSync(join(dir, KEEPER_EXE), 0o755)
  return writeContentManifest(dir, { appVersion: opts.appVersion ?? APP_VERSION, platform: opts.platform }, opts.key).manifest
}

const DITTO_CLEAN = ['--norsrc', '--noextattr', '--noqtn', '--noacl']

/** Copies the shell and the content into `bundle` (module docs) and signs the bundle again */
export function stageBundle(bundle: string, opts: { shell: CarriedShell; contentDir: string }): void {
  const shellDir = join(bundle, SHELL_IN_BUNDLE)
  const contentDir = join(bundle, CONTENT_IN_BUNDLE)
  rmSync(shellDir, { recursive: true, force: true })
  rmSync(contentDir, { recursive: true, force: true })
  mkdirSync(shellDir, { recursive: true })
  execFileSync('/usr/bin/ditto', [...DITTO_CLEAN, opts.shell.app, join(shellDir, APP_DIR_NAME)])
  const descriptor: ShellDescriptor = { format: 1, version: opts.shell.version, tree: treeHash(opts.shell.app), pinned: opts.shell.pinned }
  writeFileSync(join(shellDir, SHELL_DESCRIPTOR), `${JSON.stringify(descriptor, null, 2)}\n`)
  execFileSync('/usr/bin/ditto', [...DITTO_CLEAN, opts.contentDir, contentDir])
  execFileSync(
    '/usr/bin/codesign',
    ['--force', '--sign', '-', '--preserve-metadata=identifier,entitlements,requirements,flags,runtime', bundle],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
}

/**
 * Proves the bundle carries what was staged: the window's signature holds, the shell inside hashes
 * to its descriptor (and to the lock's cdhash when pinned), and the content inside verifies with
 * `keys` and still has the manifest that was signed. Throws on the first difference.
 */
export function checkStaged(bundle: string, opts: { keys: TrustedKey[]; platform: string; manifest: Buffer; lock?: LockEntry }): ShellDescriptor {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: ['ignore', 'ignore', 'inherit'] })
  const shellApp = join(bundle, SHELL_IN_BUNDLE, APP_DIR_NAME)
  const descriptor = JSON.parse(readFileSync(join(bundle, SHELL_IN_BUNDLE, SHELL_DESCRIPTOR), 'utf8')) as ShellDescriptor
  if (descriptor.format !== 1 || typeof descriptor.pinned !== 'boolean') throw new Error(`${SHELL_DESCRIPTOR} is malformed`)
  const tree = treeHash(shellApp)
  if (tree !== descriptor.tree) throw new Error(`the shell in the bundle hashes to ${tree}, ${SHELL_DESCRIPTOR} says ${descriptor.tree}`)
  const version = plistShellVersion(readFileSync(join(shellApp, 'Contents/Info.plist'), 'utf8'))
  if (version !== descriptor.version) throw new Error(`the shell in the bundle is version ${version}, ${SHELL_DESCRIPTOR} says ${descriptor.version}`)
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', shellApp], { stdio: ['ignore', 'ignore', 'inherit'] })
  if (descriptor.pinned) {
    if (!opts.lock) throw new Error('a pinned shell is checked against its lock entry')
    const cdhash = cdhashOf(shellApp)
    if (cdhash !== opts.lock.cdhash) throw new Error(`the shell in the bundle has cdhash ${cdhash}; shell.lock pins ${opts.lock.cdhash}`)
  }
  const content = join(bundle, CONTENT_IN_BUNDLE)
  verifyContent(content, { keys: opts.keys, platform: opts.platform })
  if (!readFileSync(join(content, MANIFEST_NAME)).equals(opts.manifest)) throw new Error('the manifest in the bundle is not the one that was signed')
  return descriptor
}

/** A local build (`pnpm app`): the shell built here, the content signed with a throwaway key */
async function stageLocal(bundle: string, targetDir: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('the shell is staged into macOS bundles only')
  if (!existsSync(join(bundle, KEEPER_IN_BUNDLE))) throw new Error(`no ${KEEPER_IN_BUNDLE} in ${bundle}`)
  const release = join(TAURI_DIR, 'target/release')
  const shell = await shellToCarry({ usePinned: false, out: join(release, 'carried-shell'), targetDir })
  const key = throwawayKey()
  const platform = `${process.platform}-${process.arch}`
  const contentDir = join(release, 'content')
  const manifest = stageContent(contentDir, { bundle, key, platform })
  stageBundle(bundle, { shell, contentDir })
  checkStaged(bundle, { keys: [{ name: 'throwaway', keyId: key.keyId, publicKey: key.publicKey }], platform, manifest })
  console.log(`staged shell ${shell.version} (unpinned) and content signed with a throwaway key into ${bundle}`)
  console.log('  this build starts its keeper directly; the reason is in keeper.log (docs/plans/thin-shell.md §10.2)')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bundle = process.argv[2]
  const i = process.argv.indexOf('--target-dir')
  const targetDir = i === -1 ? join(TAURI_DIR, 'target') : process.argv[i + 1]
  if (!bundle || !targetDir) {
    console.error('usage: bundle-stage.mts <Centralu.app> [--target-dir <dir>]')
    process.exit(2)
  }
  await stageLocal(bundle, targetDir).catch((e: Error) => {
    console.error(`bundle-stage: ${e.message}`)
    process.exit(1)
  })
}

