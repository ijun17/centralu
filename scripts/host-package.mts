/**
 * The host-only packages (`@centralu/host-<platform>`, docs/releasing.md "Host-only packages"): the
 * bundled host and nothing else, for the machines a hub installs on (docs/plans/remote-hub.md §10.2,
 * owner decision 2 of §10.9). The platform packages carry the same host inside the window's package,
 * which on Linux means an 81 MB AppImage a remote downloads only to delete it.
 *
 * `release-npm.mts` stages and checks one in every platform job whose platform a hub installs on: the
 * platforms `packaging/remote-runtime.json` pins a Node for. Kept apart from that script, which runs a
 * release when it is imported, so `tooling/host-package.test.ts` can stage and check one.
 */
import { chmodSync, copyFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, ELF_MACHINES, ET_DYN, ET_EXEC, readElf } from './elf.mjs'
import { MIN_GLIBC } from '../packages/agent-host/src/links/install.js'
// @ts-expect-error — plain .mjs, so bundle.mjs reads the same list under plain node
import { CONPTY_FILES as CONPTY_FILES_JS } from './conpty-files.mjs'
const CONPTY_FILES = CONPTY_FILES_JS as readonly string[]

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The pinned Node for remotes: one archive per platform a hub installs on */
export const PIN_FILE = join(ROOT, 'packaging/remote-runtime.json')
/** The npm package's manifest, whose `engines.node` is the Node floor; the bundle carries a copy for the hub (#699) */
export const LAUNCHER_PACKAGE_FILE = join(ROOT, 'packaging/npm/centralu/package.json')

/** The platforms a hub installs on, which are the ones with a host-only package */
export function remotePlatforms(pinFile = PIN_FILE): string[] {
  return Object.keys((JSON.parse(readFileSync(pinFile, 'utf8')) as { node: { archives: Record<string, unknown> } }).node.archives).sort()
}

/**
 * The keeper's file in a host-only package, beside `host/` (docs/plans/remote-keeper.md §7, step 1), or null where the
 * package carries none yet: Windows has no keeper until the plan's steps 6 and 7. Nothing on a remote starts it before
 * the plan's step 3; the file is there so that every later step finds it where it will run from.
 */
export function hostPackageKeeper(platform: string): string | null {
  return platform in ELF_MACHINES ? 'centralu-keeper' : null
}

/** What the package's `files` must be: `host/`, and the keeper where it carries one */
export function hostPackageFiles(platform: string): string[] {
  const keeper = hostPackageKeeper(platform)
  return keeper ? ['host', keeper] : ['host']
}

/** `packaging/npm/host-<platform>`, the package's folder */
export function hostPackageDir(platform: string, root = ROOT): string {
  return join(root, 'packaging/npm', `host-${platform}`)
}

/**
 * Copies the bundled host into the package as `host/`. `dereference`: npm drops symlinks from a
 * tarball without a word, so anything linked would arrive as a hole in the host's node_modules.
 */
export function stageHostPackage(hostSrc: string, pkgDir: string, keeper?: { src: string; name: string }): void {
  const dest = join(pkgDir, 'host')
  rmSync(dest, { recursive: true, force: true })
  cpSync(hostSrc, dest, { recursive: true, dereference: true })
  if (keeper) {
    // The exec bit is set here rather than trusted: a GitHub Actions artifact is a zip and drops it (release-npm.mts)
    copyFileSync(keeper.src, join(pkgDir, keeper.name))
    chmodSync(join(pkgDir, keeper.name), 0o755)
  }
}

/**
 * What the keeper may link by name: the C runtime (glibc's libraries, the dynamic loader, gcc's unwinder), which every
 * machine a hub installs on has, and which links nothing else in turn. An allow-list rather than a list of window
 * libraries, so a window library that would come in through another one (a tray library linking GTK) is refused too,
 * with no `ldd` to follow it: the keeper must run where no desktop is installed (#440)
 */
const C_RUNTIME = /^(?:libc|libm|libdl|libpthread|librt|libutil|libgcc_s)\.so\.\d+$|^ld-linux-(?:x86-64|aarch64)\.so\.\d+$/

/**
 * What is wrong with a Linux keeper, one sentence each: the one check of it, for the copy the AppImage carries
 * (`release-npm.mts`) and the copy beside `host/` in the host-only package (`hostPackageProblems`). Read from the file's
 * own bytes (`scripts/elf.mts`), so this runs on any machine, a test on Windows included: an ELF executable for the
 * platform's machine, with its exec bit (where the file system keeps one), linking nothing beyond the C runtime, and
 * asking for no glibc newer than the one a remote is checked for before an install (`MIN_GLIBC`, links/install.ts).
 */
export function keeperProblems(path: string, platform: string): string[] {
  const name = basename(path)
  const elf = readElf(readFileSync(path))
  if (typeof elf === 'string') return [`${name} cannot run on a remote: ${elf}`]
  const problems: string[] = []
  if (elf.type !== ET_EXEC && elf.type !== ET_DYN) problems.push(`${name} is not an executable (ELF type ${elf.type})`)
  // A shared library has no program interpreter: its type alone would let it pass for the keeper
  else if (elf.type === ET_DYN && !elf.interp) problems.push(`${name} is a shared library, not an executable: it names no program interpreter, so a remote could not run it`)
  const want = ELF_MACHINES[platform]
  if (elf.machine !== want) problems.push(`${name} is built for ELF machine 0x${elf.machine.toString(16)}, not ${platform} (0x${want?.toString(16)})`)
  // Windows keeps no exec bit to read; the release that stages a Linux package runs on Linux
  if (process.platform !== 'win32' && (statSync(path).mode & 0o111) === 0) problems.push(`${name} has no exec bit: a remote could not start it`)
  const beyond = elf.needed.filter((l) => !C_RUNTIME.test(l))
  if (beyond.length) {
    problems.push(`${name} links more than the C runtime (${beyond.join(', ')}): a machine with no desktop may lack it, and a window library comes in this way`)
  }
  // The build machine's glibc sets this: a runner moved to a newer distribution raises it with no other sign
  if (elf.glibc && compareVersions(elf.glibc, MIN_GLIBC) > 0) {
    problems.push(`${name} needs glibc ${elf.glibc.join('.')}, newer than the ${MIN_GLIBC.join('.')} a remote is checked for: it would not start on every machine a hub installs on`)
  }
  return problems
}

/**
 * Why the host's copy of the launcher manifest (`centralu-package.json`) differs from the launcher's, or null when it
 * does not. Since #1501 the manifest carries the stamped version, so a host bundled before the stamp differs by its
 * version fields alone: say so, rather than blame the Node floor.
 */
export function floorDiffers(bundled: string, launcher: string): string | null {
  if (bundled === launcher) return null
  const versionless = (text: string): string | null => {
    try {
      const m = JSON.parse(text) as { version?: unknown; optionalDependencies?: Record<string, unknown> }
      return JSON.stringify({ ...m, version: null, optionalDependencies: Object.keys(m.optionalDependencies ?? {}) })
    } catch {
      return null
    }
  }
  const a = versionless(bundled)
  return a !== null && a === versionless(launcher)
    ? 'the host was bundled before the version was stamped (bundle it from the stamped tree, as release-npm does)'
    : 'the host was bundled before the Node floor moved'
}

/**
 * What would make the staged package fail on a remote, one sentence each; empty when none. The files
 * `centralu serve` cannot start without, a host bundled for this platform, the pinned Node beside it
 * (a hub on this version reads it from its own host, and a remote's host must carry the same one), the
 * copy of the npm package's manifest that holds the Node floor, the
 * manifest that ships exactly `host/` (and the keeper beside it on Linux, `keeperProblems`), and nothing of the window.
 */
export function hostPackageProblems(pkgDir: string, platform: string, pinFile = PIN_FILE, launcherFile = LAUNCHER_PACKAGE_FILE): string[] {
  const problems: string[] = []
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name?: string; files?: string[] }
  if (manifest.name !== `@centralu/host-${platform}`) problems.push(`package.json names ${manifest.name}, not @centralu/host-${platform}`)
  const files = hostPackageFiles(platform)
  if (JSON.stringify(manifest.files) !== JSON.stringify(files)) problems.push(`package.json "files" is ${JSON.stringify(manifest.files)}, not ${JSON.stringify(files)}`)
  const host = join(pkgDir, 'host')
  const needed = ['main.mjs', 'bundle-info.json', 'node_modules/better-sqlite3/package.json', 'node_modules/node-pty/package.json']
  // The ConPTY a terminal runs on (#849)
  if (platform.startsWith('win32-')) for (const f of CONPTY_FILES) needed.push(`node_modules/node-pty/prebuilds/${platform}/${f}`)
  for (const rel of needed) {
    if (!existsSync(join(host, rel))) problems.push(`host/${rel} is missing: centralu serve would not start`)
  }
  if (existsSync(join(host, 'bundle-info.json'))) {
    const info = JSON.parse(readFileSync(join(host, 'bundle-info.json'), 'utf8')) as { platform?: string; arch?: string }
    if (`${info.platform}-${info.arch}` !== platform) problems.push(`the host was bundled for ${info.platform}-${info.arch}, not ${platform}`)
  }
  const runtime = join(host, 'remote-runtime.json')
  if (!existsSync(runtime)) problems.push('host/remote-runtime.json is missing: a hub on this version could not install it anywhere')
  else if (readFileSync(runtime, 'utf8') !== readFileSync(pinFile, 'utf8')) problems.push('host/remote-runtime.json differs from packaging/remote-runtime.json: the host was bundled before the Node pin moved')
  const floor = join(host, 'centralu-package.json')
  if (!existsSync(floor)) problems.push('host/centralu-package.json is missing: a hub on this version could not tell which Node a machine needs')
  else {
    const why = floorDiffers(readFileSync(floor, 'utf8'), readFileSync(launcherFile, 'utf8'))
    if (why) problems.push(`host/centralu-package.json differs from packaging/npm/centralu/package.json: ${why}`)
  }
  const keeper = hostPackageKeeper(platform)
  if (keeper) {
    if (!existsSync(join(pkgDir, keeper))) problems.push(`${keeper} is missing beside host/: the keeper a remote runs (docs/plans/remote-keeper.md)`)
    else problems.push(...keeperProblems(join(pkgDir, keeper), platform))
  }
  const extra = readdirSync(pkgDir).filter((n) => ![...files, 'package.json', 'README.md'].includes(n))
  if (extra.length) problems.push(`the package folder holds more than the host: ${extra.join(', ')}`)
  return problems
}
