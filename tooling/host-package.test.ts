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
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_VERSION } from '../packages/protocol/src/brand.js'
import { hostOnlyPackage, type RemotePlatform } from '../packages/agent-host/src/links/install.js'
import { floorDiffers, hostPackageDir, hostPackageFiles, hostPackageKeeper, hostPackageProblems, LAUNCHER_PACKAGE_FILE, PIN_FILE, remotePlatforms, stageHostPackage } from '../scripts/host-package.mjs'
import { ELF_MACHINES } from '../scripts/elf.mjs'
import { fakeElf } from './elf.test-helpers.js'
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
    it(`@centralu/host-${p} ships host/ (and on Linux the keeper beside it), at this version, for the machines its platform package installs on`, () => {
      const pkg = json(join(hostPackageDir(p), 'package.json'))
      expect(pkg.name).toBe(`@centralu/host-${p}`)
      // The placeholder: a release verifies before it stamps (#1501, scripts/release-verify.mjs, brand.test.ts)
      expect(pkg.version).toBe(APP_VERSION)
      expect(pkg.version).toBe('0.0.0-dev')
      expect(pkg.files).toEqual(hostPackageFiles(p))
      const app = json(root(`packaging/npm/${p}/package.json`))
      expect(pkg.os).toEqual(app.os)
      expect(pkg.cpu).toEqual(app.cpu)
      expect(pkg.license).toBe(app.license)
      expect(existsSync(join(hostPackageDir(p), 'README.md'))).toBe(true)
    })
  }

  // docs/plans/remote-keeper.md §7, step 1: the keeper a remote will run, a plain file beside host/. Windows has none yet
  it('carries the keeper beside host/ on Linux, and nothing more on Windows', () => {
    expect(platforms.map((p) => [p, hostPackageFiles(p)])).toEqual([
      ['linux-arm64', ['host', 'centralu-keeper']],
      ['linux-x64', ['host', 'centralu-keeper']],
      ['win32-x64', ['host']],
    ])
  })

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
    file(`node_modules/node-pty/prebuilds/${platform}/conpty/conpty.dll`, 'MZ')
    file(`node_modules/node-pty/prebuilds/${platform}/conpty/OpenConsole.exe`, 'MZ')
    copyFileSync(PIN_FILE, join(at, 'remote-runtime.json'))
    copyFileSync(LAUNCHER_PACKAGE_FILE, join(at, 'centralu-package.json'))
  }
  /** A keeper for `platform` as the AppImage carries it: an ELF for its machine, linking only the C library */
  const fakeKeeper = (platform: string, o: { machine?: number; type?: number; needed?: string[] } = {}) => {
    const at = join(dir, `keeper-${platform}-${Math.random().toString(36).slice(2)}`)
    writeFileSync(at, fakeElf({ machine: o.machine ?? ELF_MACHINES[platform]!, type: o.type, needed: o.needed ?? ['libgcc_s.so.1', 'libc.so.6'] }))
    return { src: at, name: hostPackageKeeper(platform) ?? 'centralu-keeper' }
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
    stageHostPackage(src, pkg, fakeKeeper('linux-x64'))
    expect(hostPackageProblems(pkg, 'linux-x64')).toEqual([])
    expect(readFileSync(join(pkg, 'host', 'schema.sql'), 'utf8')).toBe('create table x (y);\n')
    // Staged again over an older copy: nothing of the old one stays
    writeFileSync(join(pkg, 'host', 'stale.mjs'), '')
    stageHostPackage(src, pkg, fakeKeeper('linux-x64'))
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
    writeFileSync(join(src, 'centralu-package.json'), '{}\n')
    stageHostPackage(src, pkg)
    // The window must not ride along: that is the whole point of the package
    writeFileSync(join(pkg, 'centralu.exe'), 'MZ')
    expect(hostPackageProblems(pkg, 'win32-x64')).toEqual([
      'host/node_modules/better-sqlite3/package.json is missing: centralu serve would not start',
      'host/node_modules/node-pty/prebuilds/win32-x64/conpty.node is missing: centralu serve would not start',
      'host/node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll is missing: centralu serve would not start',
      'host/node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe is missing: centralu serve would not start',
      'the host was bundled for linux-x64, not win32-x64',
      'host/remote-runtime.json differs from packaging/remote-runtime.json: the host was bundled before the Node pin moved',
      'host/centralu-package.json differs from packaging/npm/centralu/package.json: the host was bundled before the Node floor moved',
      'the package folder holds more than the host: centralu.exe',
    ])
    // #1501 review: the manifest carries the stamped version; a host bundled before the stamp differs by it alone
    const launcher = readFileSync(LAUNCHER_PACKAGE_FILE, 'utf8')
    writeFileSync(join(pkg, 'host', 'centralu-package.json'), launcher.split('"0.0.0-dev"').join('"0.2.0-beta.4"'))
    expect(hostPackageProblems(pkg, 'win32-x64')).toContain(
      'host/centralu-package.json differs from packaging/npm/centralu/package.json: the host was bundled before the version was stamped (bundle it from the stamped tree, as release-npm does)',
    )
    expect(floorDiffers(launcher, launcher)).toBeNull()
    rmSync(join(pkg, 'host', 'centralu-package.json'))
    expect(hostPackageProblems(pkg, 'win32-x64')).toContain('host/centralu-package.json is missing: a hub on this version could not tell which Node a machine needs')
  })

  /*
   * #849: a terminal on Windows runs on the ConPTY node-pty ships; without it every tab and command falls back to Windows'
   * own, whose console host is never closed
   */
  it('a Windows host needs the ConPTY its terminals run on', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-host-pkg-'))
    const src = join(dir, 'src')
    fakeHost(src, 'win32-x64')
    const pkg = pkgCopy('win32-x64')
    stageHostPackage(src, pkg)
    expect(hostPackageProblems(pkg, 'win32-x64')).toEqual([])
    rmSync(join(pkg, 'host', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty'), { recursive: true })
    expect(hostPackageProblems(pkg, 'win32-x64')).toEqual([
      'host/node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll is missing: centralu serve would not start',
      'host/node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe is missing: centralu serve would not start',
    ])
  })

  it('refuses a manifest that would ship more or less than host/, or under another name', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-host-pkg-'))
    const src = join(dir, 'src')
    fakeHost(src, 'linux-arm64')
    const pkg = pkgCopy('linux-arm64')
    stageHostPackage(src, pkg, fakeKeeper('linux-arm64'))
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@centralu/linux-arm64', files: ['host', 'Centralu.AppImage'] }))
    expect(hostPackageProblems(pkg, 'linux-arm64')).toEqual([
      'package.json names @centralu/linux-arm64, not @centralu/host-linux-arm64',
      'package.json "files" is ["host","Centralu.AppImage"], not ["host","centralu-keeper"]',
    ])
    // A Linux package whose tarball would leave the keeper out, as before docs/plans/remote-keeper.md step 1
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@centralu/host-linux-arm64', files: ['host'] }))
    expect(hostPackageProblems(pkg, 'linux-arm64')).toEqual(['package.json "files" is ["host"], not ["host","centralu-keeper"]'])
  })

  /*
   * docs/plans/remote-keeper.md §7, step 1. The keeper a remote runs is checked from its own bytes, so the check runs on
   * any machine: the release's `checkKeeperExe` needs `file` and `ldd`, and checks the platform package's copy only
   */
  describe('the keeper beside host/ on Linux', () => {
    /** A Linux host staged into its package, with `keeper` beside it (none when absent) */
    const staged = (platform: string, keeper?: (p: string) => { src: string; name: string }) => {
      dir = mkdtempSync(join(tmpdir(), 'cc-host-pkg-'))
      const src = join(dir, 'src')
      fakeHost(src, platform)
      const pkg = pkgCopy(platform)
      stageHostPackage(src, pkg, keeper?.(platform))
      return { src, pkg }
    }

    it('is required', () => {
      const { pkg } = staged('linux-x64')
      expect(hostPackageProblems(pkg, 'linux-x64')).toEqual(['centralu-keeper is missing beside host/: the keeper a remote runs (docs/plans/remote-keeper.md)'])
    })

    it("must be built for the package's machine", () => {
      const { pkg } = staged('linux-x64', () => fakeKeeper('linux-arm64'))
      expect(hostPackageProblems(pkg, 'linux-x64')).toEqual(['centralu-keeper is built for ELF machine 0xb7, not linux-x64 (0x3e)'])
    })

    it('must be an executable ELF, not something else under its name', () => {
      const { src, pkg } = staged('linux-x64', () => {
        const notElf = join(dir, 'not-elf')
        writeFileSync(notElf, '#!/bin/sh\nexit 0\n')
        return { src: notElf, name: 'centralu-keeper' }
      })
      expect(hostPackageProblems(pkg, 'linux-x64')).toEqual(['centralu-keeper is not an ELF file: a remote could not run it'])
      // A relocatable object (ELF type 1) is not something a remote can start
      stageHostPackage(src, pkg, fakeKeeper('linux-x64', { type: 1 }))
      expect(hostPackageProblems(pkg, 'linux-x64')).toEqual(['centralu-keeper is not an executable (ELF type 1)'])
    })

    it('must link no window library: a remote has no desktop', () => {
      const { pkg } = staged('linux-x64', () => fakeKeeper('linux-x64', { needed: ['libwebkit2gtk-4.1.so.0', 'libgtk-3.so.0', 'libc.so.6'] }))
      expect(hostPackageProblems(pkg, 'linux-x64')).toEqual([
        'centralu-keeper links a window library (libwebkit2gtk-4.1.so.0, libgtk-3.so.0): it would not start on a machine with no desktop',
      ])
    })

    // Windows keeps no exec bit to read; the release that stages a Linux package runs on Linux
    it.skipIf(process.platform === 'win32')('keeps its exec bit, which a zipped artifact loses', () => {
      const { src, pkg } = staged('linux-x64', () => fakeKeeper('linux-x64'))
      chmodSync(join(pkg, 'centralu-keeper'), 0o644)
      expect(hostPackageProblems(pkg, 'linux-x64')).toEqual(['centralu-keeper has no exec bit: a remote could not start it'])
      // Staged from a source without one, it gets one
      const keeper = fakeKeeper('linux-x64')
      chmodSync(keeper.src, 0o644)
      stageHostPackage(src, pkg, keeper)
      expect(hostPackageProblems(pkg, 'linux-x64')).toEqual([])
    })

    it('is not in the Windows package: a package folder holding one is refused', () => {
      const { pkg } = staged('win32-x64', () => fakeKeeper('linux-x64'))
      expect(hostPackageProblems(pkg, 'win32-x64')).toEqual(['the package folder holds more than the host: centralu-keeper'])
    })
  })
})
