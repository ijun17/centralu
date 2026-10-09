/**
 * The host-only packages (`@centralu/host-<platform>`, docs/releasing.md "Host-only packages";
 * docs/plans/remote-hub.md §10.9, owner decision 2). Four places name them and have to agree: the
 * package folders in `packaging/npm/`, the platforms the release pins a Node for (which are the ones a
 * hub installs on), the shim's lookup (`HOST_PACKAGES`, platform.mjs) and the hub's installer
 * (`hostOnlyPackage`, install.ts). A folder the installer does not ask for is published for nobody; a
 * name the installer asks for and no release publishes makes every install fall back to the platform
 * package, silently, which on Linux is the 88 MB download these packages exist to avoid.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_VERSION } from '../packages/protocol/src/brand.js'
import { hostOnlyPackage, type RemotePlatform } from '../packages/agent-host/src/links/install.js'
import { hostPackageDir, hostPackageProblems, PIN_FILE, remotePlatforms, stageHostPackage } from '../scripts/host-package.mjs'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { HOST_PACKAGES } from '../packaging/npm/centralu/bin/platform.mjs'

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
const platforms = remotePlatforms()

describe('one host-only package per platform a hub installs on', () => {
  it('is exactly the platforms the release pins a Node for', () => {
    expect(platforms).toEqual(['linux-arm64', 'linux-x64', 'win32-x64'])
    const folders = readdirSync(root('packaging/npm')).filter((n) => n.startsWith('host-'))
    expect(folders.sort()).toEqual(platforms.map((p) => `host-${p}`))
  })

  for (const p of platforms) {
    it(`@centralu/host-${p} ships host/ only, at this version, for the machines its platform package installs on`, () => {
      const pkg = json(join(hostPackageDir(p), 'package.json'))
      expect(pkg.name).toBe(`@centralu/host-${p}`)
      expect(pkg.version).toBe(APP_VERSION)
      expect(pkg.files).toEqual(['host'])
      const app = json(root(`packaging/npm/${p}/package.json`))
      expect(pkg.os).toEqual(app.os)
      expect(pkg.cpu).toEqual(app.cpu)
      expect(pkg.license).toBe(app.license)
      expect(existsSync(join(hostPackageDir(p), 'README.md'))).toBe(true)
    })
  }

  it('is the name the hub asks the registry for and the shim looks for', () => {
    expect(platforms.map((p) => hostOnlyPackage(p as RemotePlatform))).toEqual(platforms.map((p) => `@centralu/host-${p}`))
    expect(HOST_PACKAGES).toEqual(Object.fromEntries(platforms.map((p) => [p, `@centralu/host-${p}`])))
  })

  it('is never pinned by the shim, so an npm install does not download the host twice', () => {
    const shim = json(root('packaging/npm/centralu/package.json')) as { optionalDependencies: Record<string, string>; dependencies?: unknown }
    expect(Object.keys(shim.optionalDependencies).filter((n) => n.includes('/host-'))).toEqual([])
    expect(shim.dependencies).toBeUndefined()
  })
})

describe('staging and checking one (release-npm.mts)', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** A bundled host as `bundle:host` writes it, for `platform` */
  const fakeHost = (at: string, platform: string) => {
    const [os, arch] = platform.split('-')
    const file = (rel: string, text = '') => {
      mkdirSync(join(at, rel, '..'), { recursive: true })
      writeFileSync(join(at, rel), text)
    }
    file('main.mjs', 'export {}\n')
    file('bundle-info.json', JSON.stringify({ platform: os, arch }))
    file('node_modules/better-sqlite3/package.json', '{}')
    file('node_modules/node-pty/package.json', '{}')
    file(`node_modules/node-pty/prebuilds/${platform}/conpty.node`, 'MZ')
    copyFileSync(PIN_FILE, join(at, 'remote-runtime.json'))
  }
  /** A copy of `packaging/npm/host-<platform>`, to stage into */
  const pkgCopy = (platform: string) => {
    const pkg = join(dir, 'pkg')
    cpSync(hostPackageDir(platform), pkg, { recursive: true, filter: (src) => !src.endsWith('/host') })
    return pkg
  }

  it('copies the host whole, links followed, and finds nothing wrong with it', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-host-pkg-'))
    const src = join(dir, 'src')
    fakeHost(src, 'linux-x64')
    // npm drops a symlink from a tarball without a word: the staged copy must hold the file itself
    writeFileSync(join(dir, 'schema.sql'), 'create table x (y);\n')
    symlinkSync(join(dir, 'schema.sql'), join(src, 'schema.sql'))
    const pkg = pkgCopy('linux-x64')
    stageHostPackage(src, pkg)
    expect(hostPackageProblems(pkg, 'linux-x64')).toEqual([])
    expect(readFileSync(join(pkg, 'host', 'schema.sql'), 'utf8')).toBe('create table x (y);\n')
    // Staged again over an older copy: nothing of the old one stays
    writeFileSync(join(pkg, 'host', 'stale.mjs'), '')
    stageHostPackage(src, pkg)
    expect(existsSync(join(pkg, 'host', 'stale.mjs'))).toBe(false)
  })

  it('names each thing that would keep the host from running on a remote', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-host-pkg-'))
    const src = join(dir, 'src')
    fakeHost(src, 'linux-x64')
    const pkg = pkgCopy('win32-x64')
    rmSync(join(src, 'node_modules', 'node-pty', 'prebuilds'), { recursive: true })
    rmSync(join(src, 'node_modules', 'better-sqlite3'), { recursive: true })
    writeFileSync(join(src, 'remote-runtime.json'), '{}\n')
    stageHostPackage(src, pkg)
    // The window must not ride along: that is the whole point of the package
    writeFileSync(join(pkg, 'centralu.exe'), 'MZ')
    expect(hostPackageProblems(pkg, 'win32-x64')).toEqual([
      'host/node_modules/better-sqlite3/package.json is missing: centralu serve would not start',
      'host/node_modules/node-pty/prebuilds/win32-x64/conpty.node is missing: centralu serve would not start',
      'the host was bundled for linux-x64, not win32-x64',
      'host/remote-runtime.json differs from packaging/remote-runtime.json: the host was bundled before the Node pin moved',
      'the package folder holds more than the host: centralu.exe',
    ])
  })

  it('refuses a manifest that would ship more or less than host/, or under another name', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-host-pkg-'))
    const src = join(dir, 'src')
    fakeHost(src, 'linux-arm64')
    const pkg = pkgCopy('linux-arm64')
    stageHostPackage(src, pkg)
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@centralu/linux-arm64', files: ['host', 'Centralu.AppImage'] }))
    expect(hostPackageProblems(pkg, 'linux-arm64')).toEqual([
      'package.json names @centralu/linux-arm64, not @centralu/host-linux-arm64',
      'package.json "files" is ["host","Centralu.AppImage"], not ["host"]',
    ])
  })
})
