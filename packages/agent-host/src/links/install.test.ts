import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeRegistry, sha256, tarGz, type FakePackage, type FakeRegistry } from './fake-registry.test-helpers.js'
import { installCommand, installRemote, installScript, nodeCommand, preflight, preflightCommand, remoteRuntime, type PreflightFacts, type RemoteRuntime } from './install.js'
import { connectionCommand, SshTunnel, type RemoteSpec } from './tunnel.js'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { findHostEntry } from '../../../../packaging/npm/centralu/bin/platform.mjs'

/**
 * The installer of plan §10.2 (#82, phase 3 step 3). The scripts run for real: a fake `ssh` hands
 * the remote command to this machine's `sh`, under a fake HOME, with `uname` and `getconf` saying
 * "Linux x86_64, glibc 2.39"; Node archives and npm packages come from a fake registry on loopback
 * (fake-registry.test-helpers.ts). The "pinned Node" in the archive is a script that runs this Node.
 */

const SERVE_MJS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packaging/npm/centralu/bin/serve.mjs')
const NODE_V = '24.21.0'
const NODE_FILE = `node-v${NODE_V}-linux-x64.tar.gz`

const linux: PreflightFacts = { os: 'Linux', arch: 'x86_64', glibc: '2.39', musl: false, freeKb: 50_000_000, tar: true, gzip: true, fetch: 'curl', sha: 'sha256sum' }
const windows: PreflightFacts = { os: 'Windows', arch: 'AMD64', glibc: null, musl: false, freeKb: 50_000_000, tar: true, gzip: true, fetch: 'curl', sha: 'Get-FileHash' }

describe('preflight (plan S7)', () => {
  const runtime = remoteRuntime()
  const refuse = (f: Partial<PreflightFacts>, base = linux) => {
    const r = preflight({ ...base, ...f }, runtime)
    return r.ok ? null : r.reason
  }

  it('names the published platform for a machine it can install on', () => {
    expect(preflight(linux, runtime)).toEqual({ ok: true, platform: 'linux-x64' })
    expect(preflight({ ...linux, arch: 'aarch64', glibc: '2.34' }, runtime)).toEqual({ ok: true, platform: 'linux-arm64' })
    expect(preflight(windows, runtime)).toEqual({ ok: true, platform: 'win32-x64' })
  })

  it('refuses, in one sentence each, what the published host cannot run on or the install cannot do', () => {
    expect(refuse({ glibc: '2.31' })).toMatch(/needs glibc 2\.34 or later .* this machine has glibc 2\.31/)
    expect(refuse({ glibc: '1.99' })).toMatch(/needs glibc 2\.34/)
    expect(refuse({ glibc: null })).toMatch(/needs glibc 2\.34 .* none that it reports/)
    expect(refuse({ musl: true, glibc: null })).toMatch(/musl/)
    expect(refuse({ arch: 'riscv64' })).toMatch(/no build for Linux on riscv64/)
    expect(refuse({ arch: 'ARM64' }, windows)).toMatch(/no build for Windows on ARM64/)
    expect(refuse({ os: 'Darwin', arch: 'arm64' })).toMatch(/for Linux and Windows; on Darwin/)
    expect(refuse({ tar: false })).toMatch(/tar is missing/)
    expect(refuse({ tar: false }, windows)).toMatch(/tar\.exe is missing/)
    expect(refuse({ gzip: false })).toMatch(/gzip is missing/)
    expect(refuse({ fetch: null })).toMatch(/Neither curl nor wget/)
    expect(refuse({ sha: null })).toMatch(/SHA-256 tool/)
    expect(refuse({ freeKb: 100 * 1024 })).toMatch(/about 600 MB free there; 100 MB is/)
    expect(refuse({ freeKb: 100 * 1024 }, windows)).toMatch(/about 300 MB free/)
  })
})

describe('the install scripts per shell (plan §10.2)', () => {
  const decode = (cmd: string) => Buffer.from(cmd.split('-EncodedCommand ')[1]!, 'base64').toString('utf16le')
  const params = { version: '0.1.0-beta.14', node: NODE_V, platform: 'win32-x64' as const, hub: 'h', packages: [{ name: 'centralu', tarball: 'https://registry.npmjs.org/centralu/-/centralu-0.1.0-beta.14.tgz', integrity: `sha512-${'A'.repeat(86)}==` }] }

  it('fits one Windows command line in every shell, the installer itself included', () => {
    // CreateProcess takes 32,767 characters; sshd and PowerShell add their own words around it
    for (const spec of [{ shell: 'powershell' }, { shell: 'wsl', wslDistro: 'Ubuntu-24.04' }, { shell: 'posix' }] as RemoteSpec[]) {
      for (const cmd of [preflightCommand(spec), nodeCommand(spec, { version: NODE_V, url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip', sha256: 'a'.repeat(64) }), installCommand(spec, installScript(), params)]) {
        expect(cmd.length).toBeLessThan(30_000)
        if (spec.shell !== 'posix') expect(cmd).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/)
      }
    }
  })

  it('a Windows remote checks the Node zip with Get-FileHash and unpacks it with System32 tar.exe', () => {
    const ps = decode(nodeCommand({ shell: 'powershell' }, { version: NODE_V, url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip', sha256: 'a'.repeat(64) }))
    expect(ps).toContain("if ($h -ne '" + 'a'.repeat(64) + "') { throw \"node_hash $h\" }")
    expect(ps).toContain("& (Join-Path $env:SystemRoot 'System32\\tar.exe') -xf $a")
    expect(ps.indexOf('node_hash')).toBeLessThan(ps.indexOf('tar.exe') + 100)
  })

  it('refuses to put anything but plain words and a plain URL into a script', () => {
    expect(() => nodeCommand({ shell: 'posix' }, { version: NODE_V, url: 'https://x/"; rm -rf ~', sha256: 'a'.repeat(64) })).toThrow(/Not a Node archive/)
    expect(() => installCommand({ shell: 'posix' }, '', { ...params, version: '1.0.0; rm -rf ~' })).toThrow(/Not a version/)
  })
})

/** The installer's own module, as the remote runs it */
type Layout = { root: string; current: string; previous: string; versions: string; node: string; bin: string; lock: string }
type InstallModule = {
  remoteLayout(dataDir: string): Layout
  writeAtomic(file: string, text: string): void
  switchTo(l: unknown, next: { version: string; node: string }): unknown
  lock(l: Layout): () => void
  placeVersion(l: Layout, partial: string, dir: string): void
  setPointers(p: unknown, o: { dataDir: string; platform: string }): Promise<unknown>
}

describe('remote-install.mjs: the pointer files (plan §10.1, S11)', () => {
  let dir: string
  let mod: InstallModule
  beforeAll(async () => {
    mod = (await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'remote-install.mjs')).href)) as InstallModule
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('replaces current by a rename, never by writing into the file the launcher reads', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-ptr-'))
    const file = join(dir, 'current')
    writeFileSync(file, '1.0.0 24.21.0\n')
    const before = statSync(file).ino
    mod.writeAtomic(file, '1.0.1 24.21.0\n')
    // A new inode: the reader had the old file whole, or has the new one whole
    expect(statSync(file).ino).not.toBe(before)
    expect(readFileSync(file, 'utf8')).toBe('1.0.1 24.21.0\n')
    expect(readdirSync(dir)).toEqual(['current'])
  })

  it('moves the old current to previous before current changes', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-ptr-'))
    const l = mod.remoteLayout(dir)
    mkdirSync(dirname(l.current), { recursive: true })
    mod.switchTo(l, { version: '1.0.0', node: NODE_V })
    expect(existsSync(l.previous)).toBe(false)
    mod.switchTo(l, { version: '1.0.1', node: NODE_V })
    expect(readFileSync(l.current, 'utf8')).toBe(`1.0.1 ${NODE_V}\n`)
    expect(readFileSync(l.previous, 'utf8')).toBe(`1.0.0 ${NODE_V}\n`)
    // The same version again moves nothing: previous stays the rollback target
    mod.switchTo(l, { version: '1.0.1', node: NODE_V })
    expect(readFileSync(l.previous, 'utf8')).toBe(`1.0.0 ${NODE_V}\n`)
  })
})

describe('remote-install.mjs: one installer at a time (install.lock)', () => {
  let dir: string
  let mod: InstallModule
  let l: Layout
  beforeAll(async () => {
    mod = (await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'remote-install.mjs')).href)) as InstallModule
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const fresh = () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-lock-'))
    l = mod.remoteLayout(dir)
    mkdirSync(l.root, { recursive: true })
  }
  const busy = (fn: () => unknown) => {
    try {
      fn()
    } catch (e) {
      return (e as { code?: string }).code
    }
    return 'taken'
  }

  it('treats a lock folder with no pid in it yet as held, not as stale', () => {
    // Another installer between making the folder and writing its pid (how an older hub's installer
    // takes it): taking it over here would put two installers in one data folder
    fresh()
    mkdirSync(l.lock)
    expect(busy(() => mod.lock(l))).toBe('busy')
    expect(existsSync(l.lock)).toBe(true)
    // …until it is old enough that its installer died between the two
    const old = new Date(Date.now() - 120_000)
    utimesSync(l.lock, old, old)
    mod.lock(l)()
    expect(existsSync(l.lock)).toBe(false)
  })

  it('holds its pid, and refuses a second installer while held', () => {
    fresh()
    const unlock = mod.lock(l)
    expect(readFileSync(join(l.lock, 'pid'), 'utf8')).toBe(String(process.pid))
    expect(busy(() => mod.lock(l))).toBe('busy')
    unlock()
    expect(existsSync(l.lock)).toBe(false)
    expect(readdirSync(l.root)).toEqual([])
  })

  it('takes over a lock whose process is gone', () => {
    fresh()
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
    mkdirSync(l.lock)
    writeFileSync(join(l.lock, 'pid'), gone)
    const unlock = mod.lock(l)
    expect(readFileSync(join(l.lock, 'pid'), 'utf8')).toBe(String(process.pid))
    unlock()
    expect(readdirSync(l.root)).toEqual([])
  })

  it('unlocks only a lock that is still its own', () => {
    fresh()
    const unlock = mod.lock(l)
    // Taken over meanwhile (this run judged stale by another): the other installer's lock stays
    writeFileSync(join(l.lock, 'token'), 'someone else')
    unlock()
    expect(existsSync(l.lock)).toBe(true)
  })
})

describe('remote-install.mjs: replacing a version folder and naming pointers', () => {
  let dir: string
  let mod: InstallModule
  let l: Layout
  beforeAll(async () => {
    mod = (await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'remote-install.mjs')).href)) as InstallModule
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const fresh = () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-place-'))
    l = mod.remoteLayout(dir)
    mkdirSync(join(l.versions, '1.0.0'), { recursive: true })
    writeFileSync(join(l.versions, '1.0.0', 'install.json'), '{"old":true}')
  }

  it('keeps the version current runs when the new folder cannot be put in its place', () => {
    fresh()
    expect(() => mod.placeVersion(l, join(l.root, '.partial-missing'), join(l.versions, '1.0.0'))).toThrow()
    expect(readFileSync(join(l.versions, '1.0.0', 'install.json'), 'utf8')).toBe('{"old":true}')
    expect(readdirSync(l.root).sort()).toEqual(['versions'])
  })

  it('replaces it whole when it can, and leaves nothing aside', () => {
    fresh()
    const partial = join(l.root, '.partial-1.0.0-1')
    mkdirSync(partial)
    writeFileSync(join(partial, 'install.json'), '{"new":true}')
    mod.placeVersion(l, partial, join(l.versions, '1.0.0'))
    expect(readFileSync(join(l.versions, '1.0.0', 'install.json'), 'utf8')).toBe('{"new":true}')
    expect(readdirSync(l.root).sort()).toEqual(['versions'])
  })

  it('refuses a previous that names a version that is not there, and writes neither pointer', async () => {
    fresh()
    mkdirSync(join(l.node, `v${NODE_V}`), { recursive: true })
    mkdirSync(l.bin, { recursive: true })
    writeFileSync(join(l.bin, 'centralu'), '#!/bin/sh\n')
    writeFileSync(l.current, `0.9.0 ${NODE_V}\n`)
    const p = { action: 'pointers', version: '1.0.0', node: NODE_V, current: { version: '1.0.0', node: NODE_V }, previous: { version: '0.5.0', node: NODE_V } }
    await expect(mod.setPointers(p, { dataDir: dir, platform: 'linux' })).rejects.toMatchObject({ code: 'missing', detail: `0.5.0 ${NODE_V}` })
    expect(readFileSync(l.current, 'utf8')).toBe(`0.9.0 ${NODE_V}\n`)
    expect(existsSync(l.previous)).toBe(false)
    // With a previous that is there, both are written
    await mod.setPointers({ ...p, previous: null }, { dataDir: dir, platform: 'linux' })
    expect(readFileSync(l.current, 'utf8')).toBe(`1.0.0 ${NODE_V}\n`)
  })
})

describe.skipIf(process.platform === 'win32')('installRemote over a fake ssh into a real sh (plan §10.2)', () => {
  let root: string
  let home: string
  let reg: FakeRegistry
  let runtime: RemoteRuntime
  let archive: Buffer

  const pkgs = (version: string): FakePackage[] => [
    {
      name: 'centralu',
      version,
      files: {
        'package.json': JSON.stringify({ name: 'centralu', version }),
        'bin/centralu.mjs': `console.log(JSON.stringify({ ran: '${version}', argv: process.argv.slice(2), managed: process.env.CENTRALU_MANAGED ?? null }))\n`,
        'bin/serve.mjs': `export { managedLauncherScript } from ${JSON.stringify(pathToFileURL(SERVE_MJS).href)}\n`,
      },
    },
    {
      name: '@centralu/linux-x64',
      version,
      files: { 'package.json': JSON.stringify({ name: '@centralu/linux-x64', version }), 'host/main.mjs': 'export {}\n', 'Centralu.AppImage': 'the window, which a remote never runs' },
    },
  ]

  const hostOnly = (version: string): FakePackage => ({
    name: '@centralu/host-linux-x64',
    version,
    files: { 'package.json': JSON.stringify({ name: '@centralu/host-linux-x64', version }), 'host/main.mjs': 'export {}\n' },
  })

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-install-'))
    home = join(root, 'home')
    const bin = join(root, 'bin')
    mkdirSync(home, { recursive: true })
    mkdirSync(bin, { recursive: true })
    const tool = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    // This machine plays a Linux remote: what it is comes from uname and getconf (GLIBC in the env)
    tool('uname', 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) /usr/bin/uname "$@" ;; esac')
    tool('getconf', 'echo "glibc ${FAKE_GLIBC:-2.39}"')
    // ssh hands its last argument to the remote's shell, as sshd does
    writeFileSync(
      join(root, 'ssh'),
      `#!${process.execPath}\nconst r = require('node:child_process').spawnSync('/bin/sh', ['-c', process.argv.at(-1)], { stdio: 'inherit' })\nprocess.exit(r.status ?? 1)\n`,
    )
    chmodSync(join(root, 'ssh'), 0o755)
    archive = tarGz(`node-v${NODE_V}-linux-x64`, {
      'bin/node': { text: `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, mode: 0o755 },
      LICENSE: 'MIT',
      'include/node/node.h': '/* 67 MB in the real one */',
      'lib/node_modules/npm/package.json': '{}',
    })
    // 9.9.1 to 9.9.3 as published before the host-only packages; 9.9.4 and 9.9.5 with one, as a
    // release publishes it now: beside the platform package, which npm installs keep using
    reg = await fakeRegistry([...pkgs('9.9.1'), ...pkgs('9.9.2'), ...pkgs('9.9.3'), ...pkgs('9.9.4'), hostOnly('9.9.4'), ...pkgs('9.9.5'), hostOnly('9.9.5')])
    reg.addNodeArchive(NODE_V, NODE_FILE, archive)
    runtime = { node: { version: NODE_V, archives: { 'linux-x64': { file: NODE_FILE, sha256: sha256(archive) } } } }
  })
  afterAll(async () => {
    await reg.close()
    rmSync(root, { recursive: true, force: true })
  })
  afterEach(() => rmSync(join(home, '.centralu'), { recursive: true, force: true }))

  const env = (over: Record<string, string> = {}) => ({ HOME: home, PATH: `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, ...over })
  const install = (version: string, o: { runtime?: RemoteRuntime; env?: Record<string, string> } = {}) => {
    const t = new SshTunnel({ target: 'box', ssh: join(root, 'ssh'), env: env(o.env) })
    return installRemote({ exec: (c) => t.exec(c), spec: { shell: 'posix' }, target: 'box', version, runtime: o.runtime ?? runtime, script: installScript(), registry: { registry: reg.url }, nodeDist: `${reg.url}/dist` })
  }
  const remote = (...p: string[]) => join(home, '.centralu', 'remote', ...p)

  it('installs Node pruned and both packages beside it, writes the launcher and current, and the lookup runs it', async () => {
    const r = await install('9.9.1')
    expect(r).toEqual({ current: { version: '9.9.1', node: NODE_V }, previous: null, removed: [], left: [] })
    // Node: the binary and its licence, nothing of npm or the headers (plan S6)
    expect(readdirSync(remote('node', `v${NODE_V}`)).sort()).toEqual(['LICENSE', 'bin'])
    expect(existsSync(remote('versions', '9.9.1', 'node_modules', '@centralu', 'linux-x64', 'host', 'main.mjs'))).toBe(true)
    expect(existsSync(remote('versions', '9.9.1', 'node_modules', '@centralu', 'linux-x64', 'Centralu.AppImage'))).toBe(false)
    expect(JSON.parse(readFileSync(remote('versions', '9.9.1', 'install.json'), 'utf8'))).toMatchObject({ version: '9.9.1', node: NODE_V, platform: 'linux-x64' })
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
    // Nothing half-done is left behind
    expect(readdirSync(remote()).filter((n) => n.startsWith('.'))).toEqual([])
    // The hub's lookup now finds the managed launcher, which runs current's centralu.mjs on its Node
    const out = execFileSync('/bin/sh', ['-c', connectionCommand({ shell: 'posix' })], { env: env(), encoding: 'utf8' })
    expect(JSON.parse(out)).toEqual({ ran: '9.9.1', argv: ['serve', '--connection'], managed: '1' })
  }, 60_000)

  it('a version published before the host-only packages comes from its platform package, after asking for the host-only one', async () => {
    const hits = reg.hits.length
    await install('9.9.1')
    const asked = reg.hits.slice(hits)
    expect(asked).toContain('/@centralu/host-linux-x64/9.9.1')
    expect(asked).toContain('/@centralu/linux-x64/-/linux-x64-9.9.1.tgz')
    expect(JSON.parse(readFileSync(remote('versions', '9.9.1', 'install.json'), 'utf8')).packages.map((p: { name: string }) => p.name)).toEqual(['centralu', '@centralu/linux-x64'])
  }, 60_000)

  it('a version with a host-only package installs that one and never downloads the platform package (owner decision 2)', async () => {
    const hits = reg.hits.length
    const r = await install('9.9.4')
    expect(r.current).toEqual({ version: '9.9.4', node: NODE_V })
    const asked = reg.hits.slice(hits)
    expect(asked).toContain('/@centralu/host-linux-x64/-/host-linux-x64-9.9.4.tgz')
    expect(asked.filter((h) => h.startsWith('/@centralu/linux-x64/'))).toEqual([])
    const v = (...p: string[]) => remote('versions', '9.9.4', ...p)
    expect(existsSync(v('node_modules', '@centralu', 'host-linux-x64', 'host', 'main.mjs'))).toBe(true)
    expect(existsSync(v('node_modules', '@centralu', 'linux-x64'))).toBe(false)
    expect(JSON.parse(readFileSync(v('install.json'), 'utf8')).packages.map((p: { name: string }) => p.name)).toEqual(['centralu', '@centralu/host-linux-x64'])
    // The shim's own lookup, resolving from where the installed centralu.mjs sits, finds that host
    const req = createRequire(v('node_modules', 'centralu', 'bin', 'centralu.mjs'))
    const found = findHostEntry('linux', 'x64', {
      resolveRoot: (name: string) => {
        try {
          return dirname(req.resolve(`${name}/package.json`))
        } catch {
          return null
        }
      },
      exists: existsSync,
    })
    expect(found).toEqual({ entry: realpathSync(v('node_modules', '@centralu', 'host-linux-x64', 'host', 'main.mjs')) })
  }, 60_000)

  it('falls back only when the host-only package is not published: a bad signature on it refuses', async () => {
    const hits = reg.hits.length
    reg.forgeSignature('@centralu/host-linux-x64@9.9.5')
    await expect(install('9.9.5')).rejects.toThrow(/signature on @centralu\/host-linux-x64@9\.9\.5 does not check out/)
    const asked = reg.hits.slice(hits)
    expect(asked.filter((h) => h.startsWith('/@centralu/linux-x64/'))).toEqual([])
    expect(asked.filter((h) => h.startsWith('/dist/') || h.endsWith('.tgz'))).toEqual([])
    expect(existsSync(remote('current'))).toBe(false)
  }, 60_000)

  it('keeps current and previous only: a third version removes the first', async () => {
    await install('9.9.1')
    const launcher = readFileSync(remote('bin', 'centralu'))
    const second = await install('9.9.2')
    expect(second.previous).toEqual({ version: '9.9.1', node: NODE_V })
    expect(readFileSync(remote('previous'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
    const third = await install('9.9.3')
    expect(third).toMatchObject({ current: { version: '9.9.3' }, previous: { version: '9.9.2' }, removed: ['9.9.1'] })
    expect(readdirSync(remote('versions')).sort()).toEqual(['9.9.2', '9.9.3'])
    // The launcher was written once and never again (S8)
    expect(readFileSync(remote('bin', 'centralu'))).toEqual(launcher)
  }, 90_000)

  it('refuses a Node archive whose SHA-256 is not the pinned one, and leaves nothing', async () => {
    const wrong = { node: { version: NODE_V, archives: { 'linux-x64': { file: NODE_FILE, sha256: 'f'.repeat(64) } } } }
    await expect(install('9.9.1', { runtime: wrong })).rejects.toThrow(/does not match the SHA-256 this Centralu release pinned/)
    expect(existsSync(remote('node'))).toBe(false)
    expect(existsSync(remote('current'))).toBe(false)
    expect(readdirSync(remote()).filter((n) => n.startsWith('.'))).toEqual([])
  }, 60_000)

  it('refuses a package whose bytes are not what the signed metadata names, and keeps what runs', async () => {
    await install('9.9.1')
    reg.swapTarball('@centralu/linux-x64@9.9.2', tarGz('package', { 'host/main.mjs': 'someone else’s host' }))
    try {
      await expect(install('9.9.2')).rejects.toThrow(/@centralu\/linux-x64 downloaded on box does not match the integrity the npm registry signed/)
    } finally {
      reg.swapTarball('@centralu/linux-x64@9.9.2', tarGz('package', pkgs('9.9.2')[1]!.files))
    }
    expect(existsSync(remote('versions', '9.9.2'))).toBe(false)
    expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${NODE_V}\n`)
    expect(existsSync(remote('previous'))).toBe(false)
    expect(readdirSync(remote()).filter((n) => n.startsWith('.'))).toEqual([])
  }, 60_000)

  it('refuses before downloading anything: an old glibc there, or registry metadata whose signature fails', async () => {
    const hits = reg.hits.length
    await expect(install('9.9.1', { env: { FAKE_GLIBC: '2.31' } })).rejects.toThrow(/Cannot install on box: Centralu needs glibc 2\.34 or later/)
    expect(reg.hits.length).toBe(hits)
    reg.forgeSignature('centralu@9.9.3')
    await expect(install('9.9.3')).rejects.toThrow(/signature on centralu@9\.9\.3 does not check out/)
    expect(reg.hits.slice(hits).filter((h) => h.startsWith('/dist/') || h.endsWith('.tgz'))).toEqual([])
    expect(existsSync(remote('node'))).toBe(false)
  }, 60_000)
})
