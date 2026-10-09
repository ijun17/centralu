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
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The pinned Node for remotes: one archive per platform a hub installs on */
export const PIN_FILE = join(ROOT, 'packaging/remote-runtime.json')

/** The platforms a hub installs on, which are the ones with a host-only package */
export function remotePlatforms(pinFile = PIN_FILE): string[] {
  return Object.keys((JSON.parse(readFileSync(pinFile, 'utf8')) as { node: { archives: Record<string, unknown> } }).node.archives).sort()
}

/** `packaging/npm/host-<platform>`, the package's folder */
export function hostPackageDir(platform: string, root = ROOT): string {
  return join(root, 'packaging/npm', `host-${platform}`)
}

/**
 * Copies the bundled host into the package as `host/`. `dereference`: npm drops symlinks from a
 * tarball without a word, so anything linked would arrive as a hole in the host's node_modules.
 */
export function stageHostPackage(hostSrc: string, pkgDir: string): void {
  const dest = join(pkgDir, 'host')
  rmSync(dest, { recursive: true, force: true })
  cpSync(hostSrc, dest, { recursive: true, dereference: true })
}

/**
 * What would make the staged package fail on a remote, one sentence each; empty when none. The files
 * `centralu serve` cannot start without, a host bundled for this platform, the pinned Node beside it
 * (a hub on this version reads it from its own host, and a remote's host must carry the same one), the
 * manifest that ships exactly `host/`, and nothing of the window.
 */
export function hostPackageProblems(pkgDir: string, platform: string, pinFile = PIN_FILE): string[] {
  const problems: string[] = []
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name?: string; files?: string[] }
  if (manifest.name !== `@centralu/host-${platform}`) problems.push(`package.json names ${manifest.name}, not @centralu/host-${platform}`)
  if (JSON.stringify(manifest.files) !== JSON.stringify(['host'])) problems.push(`package.json "files" is ${JSON.stringify(manifest.files)}, not ["host"]`)
  const host = join(pkgDir, 'host')
  const needed = ['main.mjs', 'bundle-info.json', 'node_modules/better-sqlite3/package.json', 'node_modules/node-pty/package.json']
  if (platform.startsWith('win32-')) needed.push(`node_modules/node-pty/prebuilds/${platform}/conpty.node`)
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
  const extra = readdirSync(pkgDir).filter((n) => !['host', 'package.json', 'README.md'].includes(n))
  if (extra.length) problems.push(`the package folder holds more than the host: ${extra.join(', ')}`)
  return problems
}
