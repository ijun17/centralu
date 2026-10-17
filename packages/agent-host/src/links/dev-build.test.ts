import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Store } from '../dev-services/store.js'
import { rmFakeDir } from '../fake-exe.test-helpers.js'
import { isDevVersion } from './dev-build.js'
import { fakeRegistry, fakeServe, sha256, tarGz, type FakePackage, type FakeRegistry } from './fake-registry.test-helpers.js'
import { installRemote, installScript, type RemoteRuntime } from './install.js'
import { findMachine, remoteDev, resolveCommit } from './remote-dev.js'
import { storeRegistry } from './stored.js'
import { connectionCommand, parseConnectionLine, SshTunnel, type RemoteSpec } from './tunnel.js'
import { rollbackRemote, type HostControl } from './update.js'
import { WIN_NODE_FILE, WIN_NODE_V, windowsNodeZip, windowsPackages, windowsRemoteEnv, windowsRemoteSsh, windowsRuntime } from './windows-remote.test-helpers.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/**
 * A dev build of the host on a linked machine from a git commit (#1036, `pnpm remote-dev`): the checks and the build
 * `remote-install.mjs` runs there, then the whole command against this machine playing the remote, over a fake ssh into
 * a real PowerShell (Windows) or a real sh (elsewhere), with a release installed from a fake registry first. The
 * working copy is a real git repository whose `bundle.mjs` stands in for the real one: it writes a host into
 * `CC_BUNDLE_OUT`, or fails when `FAKE_BUILD_FAILS` is set.
 */

const SERVE_MJS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packaging/npm/centralu/bin/serve.mjs')
const SERVE_SHIM = `export { managedLauncherScript } from ${JSON.stringify(pathToFileURL(SERVE_MJS).href)}\n`
/** The real `installInfo`, so the connection line's `install` (and a dev build's `source` in it) is the launcher's own */
const INSTALL_INFO = pathToFileURL(resolve(dirname(SERVE_MJS), 'serve-install.mjs')).href
const BASE = '9.9.1-beta.1'

const BUNDLER = `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
if (process.env.FAKE_BUILD_FAILS) {
  console.error('✘ [ERROR] Could not resolve "./nowhere.js"')
  process.exit(1)
}
const out = process.env.CC_BUNDLE_OUT
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'main.mjs'), 'export {}\\n')
writeFileSync(join(out, 'bundle-info.json'), JSON.stringify({ protocolVersion: 1 }))
console.log('[bundle] built on Node ' + process.version)
`

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A Centralu working copy at one commit: the launcher package of release `base`, the protocol, and a stand-in bundler */
function fakeRepo(dir: string, o: { base?: string; protocol?: number; floor?: string } = {}): { repo: string; commit: string } {
  const repo = join(dir, 'repo')
  const files: Record<string, string> = {
    '.gitignore': 'node_modules/\n',
    'packages/agent-host/scripts/bundle.mjs': BUNDLER,
    'packages/protocol/src/envelope.ts': `export const PROTOCOL_VERSION = ${o.protocol ?? 1}\n`,
    'packaging/npm/centralu/package.json': JSON.stringify({ name: 'centralu', version: o.base ?? BASE, type: 'module', engines: { node: `>=${o.floor ?? '20.0.0'}` }, optionalDependencies: { '@centralu/linux-x64': o.base ?? BASE } }),
    'packaging/npm/centralu/bin/centralu.mjs': fakeServe('', { fromPackage: true, installInfo: INSTALL_INFO }),
    'packaging/npm/centralu/bin/serve.mjs': SERVE_SHIM,
    // Installed dependencies, which git ignores
    'node_modules/esbuild/package.json': '{}',
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'a host change')
  return { repo, commit: git(repo, 'rev-parse', 'HEAD') }
}

type DevModule = { devBuild(p: Record<string, unknown>, o: { dataDir: string; platform?: string; arch?: string }): Record<string, any> }

describe('remote-install.mjs: a dev build from a commit (#1036)', () => {
  let root: string
  let mod: DevModule
  const NODE = '24.21.0'

  beforeAll(async () => {
    mod = (await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'remote-install.mjs')).href)) as DevModule
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** A machine where the hub installed the release `BASE`, and a working copy at one commit */
  const setup = (repo: Parameters<typeof fakeRepo>[1] = {}) => {
    root = mkdtempSync(join(tmpdir(), 'cc-devbuild-'))
    const data = join(root, 'data')
    const r = (...p: string[]) => join(data, 'remote', ...p)
    mkdirSync(r('versions', BASE), { recursive: true })
    writeFileSync(r('versions', BASE, 'install.json'), JSON.stringify({ version: BASE, node: NODE }))
    mkdirSync(r('node', `v${NODE}`), { recursive: true })
    writeFileSync(r('current'), `${BASE} ${NODE}\n`)
    return { data, r, ...fakeRepo(root, repo) }
  }
  const build = (s: ReturnType<typeof setup>, over: Record<string, unknown> = {}) =>
    mod.devBuild({ action: 'dev', version: BASE, node: NODE, repo: s.repo, commit: s.commit, allowDirty: false, protocol: 1, hub: 'hub (pnpm remote-dev)', ...over }, { dataDir: s.data, platform: 'linux', arch: 'x64' })
  const refusal = (fn: () => unknown) => {
    try {
      fn()
    } catch (err) {
      return `${(err as { code?: string }).code} ${(err as { detail?: string }).detail ?? ''}`.trim()
    }
    throw new Error('not refused')
  }

  it('builds the commit beside the release as <base>.local.1, marked as a dev build, and switches nothing', () => {
    const s = setup()
    const out = build(s)
    const version = `${BASE}.local.1`
    expect(out).toEqual({ installed: { version, node: NODE, source: { kind: 'dev', commit: s.commit, dirty: false } }, current: { version: BASE, node: NODE }, previous: null, removed: [], left: [] })
    // The host where a hub's install puts it, and the launcher package saying the version the host will report
    expect(existsSync(s.r('versions', version, 'node_modules', '@centralu', 'host-linux-x64', 'host', 'main.mjs'))).toBe(true)
    expect(JSON.parse(readFileSync(s.r('versions', version, 'node_modules', '@centralu', 'host-linux-x64', 'package.json'), 'utf8'))).toMatchObject({ name: '@centralu/host-linux-x64', version })
    const shim = JSON.parse(readFileSync(s.r('versions', version, 'node_modules', 'centralu', 'package.json'), 'utf8'))
    expect(shim).toMatchObject({ name: 'centralu', version })
    expect(shim.optionalDependencies).toBeUndefined()
    expect(existsSync(s.r('versions', version, 'node_modules', 'centralu', 'bin', 'centralu.mjs'))).toBe(true)
    expect(JSON.parse(readFileSync(s.r('versions', version, 'install.json'), 'utf8'))).toMatchObject({ version, node: NODE, by: 'hub (pnpm remote-dev)', source: { kind: 'dev', commit: s.commit, dirty: false } })
    // Built on the Node that runs this script (the pinned one there), its output kept
    expect(readFileSync(s.r('dev-build.log'), 'utf8')).toContain(`[bundle] built on Node ${process.version}`)
    expect(readFileSync(s.r('current'), 'utf8')).toBe(`${BASE} ${NODE}\n`)
    expect(readdirSync(s.r()).filter((n) => n.startsWith('.'))).toEqual([])
    // The next one is the next number
    expect(build(s).installed.version).toBe(`${BASE}.local.2`)
  })

  it('refuses before building: another commit checked out, uncommitted changes, another protocol, a Node below the floor', () => {
    const s = setup()
    expect(refusal(() => build(s, { commit: 'f'.repeat(40) }))).toBe(`dev_commit ${s.commit} ${'f'.repeat(40)}`)
    writeFileSync(join(s.repo, 'scratch.txt'), 'not committed')
    expect(refusal(() => build(s))).toBe('dev_dirty 1')
    expect(build(s, { allowDirty: true }).installed.source).toEqual({ kind: 'dev', commit: s.commit, dirty: true })
    rmSync(join(s.repo, 'scratch.txt'))
    expect(refusal(() => build(s, { protocol: 2 }))).toBe('dev_protocol 1 2')
    expect(refusal(() => build(s, { repo: join(s.repo, 'nowhere') }))).toMatch(/^dev_repo /)
    expect(refusal(() => build(s, { repo: 'relative/path' }))).toBe('dev_repo relative/path')
    rmSync(root, { recursive: true, force: true })
    const old = setup({ floor: '999.0.0' })
    expect(refusal(() => build(old))).toBe(`dev_node ${process.versions.node} 999.0.0`)
    expect(existsSync(old.r('dev-build.log'))).toBe(false)
  })

  it('refuses a machine without a release the hub installed, a stable base, and a working copy without dependencies', () => {
    const s = setup()
    rmSync(s.r('current'))
    expect(refusal(() => build(s))).toBe('dev_unmanaged')
    rmSync(root, { recursive: true, force: true })
    expect(refusal(() => build(setup({ base: '1.0.0' })))).toBe('dev_base 1.0.0')
    rmSync(root, { recursive: true, force: true })
    const bare = setup()
    rmSync(join(bare.repo, 'node_modules'), { recursive: true })
    expect(refusal(() => build(bare))).toMatch(/^dev_deps /)
  })

  it('places nothing when the build fails, and says its last line', () => {
    const s = setup()
    process.env.FAKE_BUILD_FAILS = '1'
    try {
      expect(refusal(() => build(s))).toBe('dev_build ✘ [ERROR] Could not resolve "./nowhere.js"')
    } finally {
      delete process.env.FAKE_BUILD_FAILS
    }
    expect(readdirSync(s.r('versions'))).toEqual([BASE])
    expect(readdirSync(s.r()).filter((n) => n.startsWith('.'))).toEqual([])
  })
})

describe('the command’s lookups (#1036)', () => {
  it('finds a linked machine in the hub’s store by id, name or ssh target, read only, and names the others when it does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-remotedev-'))
    try {
      const store = new Store(join(dir, 'store.db'))
      storeRegistry(store).add({ id: 'win', name: 'Win PC', sshTarget: 'me@win', remote: { shell: 'powershell' }, addedAt: 1, acceptedVersions: null })
      store.close()
      for (const name of ['win', 'Win PC', 'me@win']) expect(findMachine(dir, name)).toMatchObject({ id: 'win', sshTarget: 'me@win', remote: { shell: 'powershell' } })
      expect(() => findMachine(dir, 'mac')).toThrow('No linked machine is called mac; linked: win (Win PC, me@win)')
      expect(() => findMachine(join(dir, 'nowhere'), 'win')).toThrow(/No Centralu store at/)
      const { repo, commit } = fakeRepo(dir)
      expect(await resolveCommit('HEAD', repo)).toBe(commit)
      await expect(resolveCommit('no-such-branch', repo)).rejects.toThrow('no-such-branch is no commit this working copy knows; fetch it first')
      await expect(resolveCommit('--all', repo)).rejects.toThrow('Not a commit')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a dev build’s source from the connection line, and nothing from one that is not well formed', () => {
    const line = (current: unknown) => parseConnectionLine(JSON.stringify({ v: 1, port: 1, token: 't', version: '1', protocolVersion: 1, dataDir: '/d', hostRunning: true, install: { managed: true, current, previous: null, node: '24' } })).install?.current
    const commit = '0123456789abcdef0123456789abcdef01234567'
    expect(line({ version: '1.local.1', node: '24', source: { kind: 'dev', commit, dirty: true } })).toEqual({ version: '1.local.1', node: '24', source: { kind: 'dev', commit, dirty: true } })
    expect(line({ version: '1', node: '24', source: { kind: 'dev', commit: '$(rm -rf ~)' } })).toEqual({ version: '1', node: '24' })
    expect(line({ version: '1', node: '24', source: { kind: 'release' } })).toEqual({ version: '1', node: '24' })
  })

  it('reads a version no release produced as a dev build, so the release before it stays the way back', () => {
    expect(isDevVersion({ version: '0.3.0-beta.7.local.1', node: '24' })).toBe(true)
    expect(isDevVersion({ version: '0.3.0-beta.7', node: '24', source: { kind: 'dev', commit: 'abc1234', dirty: false } })).toBe(true)
    expect(isDevVersion({ version: '0.3.0-beta.7', node: '24' })).toBe(false)
  })
})

/**
 * The whole command, this machine playing the remote. `remote` gives what differs per shell: the ssh, its environment,
 * the platform's packages and the pinned Node archive.
 */
function wholeCommand(o: {
  shell: RemoteSpec['shell']
  prepare: (root: string, home: string) => Promise<{ ssh: string; env: (over?: Record<string, string>) => Record<string, string>; runtime: RemoteRuntime; archive: { version: string; file: string; bytes: Buffer }; packages: (version: string) => FakePackage[] }>
}) {
  let root: string
  let home: string
  let reg: FakeRegistry
  let ctx: Awaited<ReturnType<typeof o.prepare>>
  const spec: RemoteSpec = { shell: o.shell }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-remotedev-'))
    home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    ctx = await o.prepare(root, home)
    reg = await fakeRegistry(ctx.packages(BASE))
    reg.addNodeArchive(ctx.archive.version, ctx.archive.file, ctx.archive.bytes)
    mkdirSync(join(root, 'hub'), { recursive: true })
    const store = new Store(join(root, 'hub', 'store.db'))
    storeRegistry(store).add({ id: 'box', name: 'Box', sshTarget: 'box', remote: spec, addedAt: 1, acceptedVersions: null })
    store.close()
  }, 120_000 * SLOW)
  afterAll(async () => {
    await reg?.close()
    rmFakeDir(root)
  })
  afterEach(() => {
    rmFakeDir(join(home, '.centralu'))
    rmFakeDir(join(root, 'repo'))
  })

  const data = (...p: string[]) => join(home, '.centralu', ...p)
  const remote = (...p: string[]) => data('remote', ...p)
  const events = () => (existsSync(data('events')) ? readFileSync(data('events'), 'utf8').trim().split('\n') : [])
  const running = () => (existsSync(data('running')) ? readFileSync(data('running'), 'utf8') : null)
  const tunnel = (env?: Record<string, string>) => new SshTunnel({ target: 'box', remote: spec, ssh: ctx.ssh, env: ctx.env(env) })
  const node = () => ctx.runtime.node.version

  /** The release installed by the hub and running, as after `machines.install` and a link that started it */
  const releaseRunning = async () => {
    const t = tunnel()
    await installRemote({ exec: (c) => t.exec(c), spec, target: 'box', version: BASE, runtime: ctx.runtime, script: installScript(), registry: { registry: reg.url }, nodeDist: `${reg.url}/dist` })
    await t.startHost()
    expect(running()).toBe(BASE)
    rmSync(data('events'))
  }
  const dev = (repo: string, over: { allowDirty?: boolean; env?: Record<string, string> } = {}) => {
    const said: string[] = []
    return { said, done: remoteDev({ machine: 'Box', ref: 'HEAD', repo, cwd: repo, dataDir: join(root, 'hub'), allowDirty: over.allowDirty, log: (l) => said.push(l), ssh: { ssh: ctx.ssh, env: ctx.env(over.env) }, checkMs: 30_000 * SLOW }) }
  }
  const lineNow = async () => {
    const t = tunnel()
    return parseConnectionLine((await t.exec(connectionCommand(spec))).stdout)
  }

  it('builds the commit there, swaps to it through the update’s steps, says it is a dev build, and rolls back to the release', async () => {
    await releaseRunning()
    const { repo, commit } = fakeRepo(root)
    const { said, done } = dev(repo)
    const r = await done
    const version = `${BASE}.local.1`
    expect(r).toMatchObject({ machine: 'Box', current: { version, node: node(), source: { kind: 'dev', commit, dirty: false } }, previous: { version: BASE, node: node() } })
    // The release stopped itself through its own launcher, then the dev build started and answered as itself
    expect(events()).toEqual([`stop ${BASE}`, `start ${version}`])
    expect(running()).toBe(version)
    expect(said.filter((l) => /^Box: [a-z_]+$/.test(l))).toEqual(['Box: build', 'Box: stop', 'Box: switch', 'Box: start', 'Box: check', 'Box: prune'])
    expect(readFileSync(remote('current'), 'utf8')).toBe(`${version} ${node()}\n`)
    expect(readFileSync(remote('previous'), 'utf8')).toBe(`${BASE} ${node()}\n`)
    // The machine's own connection line says so, as the hub's row will show it
    expect((await lineNow()).install).toMatchObject({ managed: true, current: { version, source: { kind: 'dev', commit, dirty: false } }, previous: { version: BASE } })
    expect((await lineNow()).install?.previous).not.toHaveProperty('source')

    // A second dev build keeps the release as the way back, and the first dev build goes
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'another host change')
    const again = await dev(repo).done
    expect(again).toMatchObject({ current: { version: `${BASE}.local.2` }, previous: { version: BASE }, removed: [version] })

    // Back to the release, as `machines.rollback` does it
    const t = tunnel()
    const c: HostControl = {
      exec: (cmd) => t.exec(cmd),
      spec,
      target: 'box',
      script: installScript(),
      hold: () => {},
      start: async () => void (await t.startHost()),
      answers: async (v) => running() === v,
      step: () => {},
    }
    await rollbackRemote(c, { current: again.current, previous: again.previous! })
    expect(running()).toBe(BASE)
    expect(readFileSync(remote('current'), 'utf8')).toBe(`${BASE} ${node()}\n`)
  }, 240_000 * SLOW)

  it('stops nothing when the checkout there is at another commit, or the build fails, and leaves the release running', async () => {
    await releaseRunning()
    const { repo } = fakeRepo(root)
    const hub = join(root, 'hub-copy')
    rmFakeDir(hub)
    execFileSync('git', ['clone', '-q', repo, hub])
    git(hub, 'commit', '-q', '--allow-empty', '-m', 'a commit the machine does not have checked out')
    const elsewhere = remoteDev({ machine: 'box', ref: 'HEAD', repo, cwd: hub, dataDir: join(root, 'hub'), ssh: { ssh: ctx.ssh, env: ctx.env() } })
    await expect(elsewhere).rejects.toThrow(/The working copy on box is at [0-9a-f]{12}, not [0-9a-f]{12}; check out that commit there/)
    await expect(dev(repo, { env: { FAKE_BUILD_FAILS: '1' } }).done).rejects.toThrow('Building the host on box failed: ✘ [ERROR] Could not resolve "./nowhere.js"')
    expect(events()).toEqual([])
    expect(running()).toBe(BASE)
    expect(readFileSync(remote('current'), 'utf8')).toBe(`${BASE} ${node()}\n`)
    expect(readdirSync(remote('versions'))).toEqual([BASE])
    rmFakeDir(hub)
  }, 180_000 * SLOW)

  it('puts the release back when the dev build does not start, with the end of its log', async () => {
    await releaseRunning()
    const { repo } = fakeRepo(root)
    const version = `${BASE}.local.1`
    await expect(dev(repo, { env: { FAKE_BROKEN: version } }).done).rejects.toThrow(
      new RegExp(`Centralu ${version.replaceAll('.', '\\.')} did not start on box .*; it runs Centralu ${BASE.replaceAll('.', '\\.')} again`),
    )
    expect(running()).toBe(BASE)
    expect(readFileSync(remote('current'), 'utf8')).toBe(`${BASE} ${node()}\n`)
  }, 180_000 * SLOW)
}

// The install scripts ask the machine for its architecture, and only x64 Windows has a build
describe.runIf(process.platform === 'win32' && process.arch === 'x64')('pnpm remote-dev against a Windows machine over a fake ssh into a real PowerShell (#1036)', () => {
  wholeCommand({
    shell: 'powershell',
    prepare: async (root, home) => {
      windowsRemoteSsh(root)
      const zip = windowsNodeZip()
      return {
        ssh: join(root, 'ssh.exe'),
        env: (over = {}) => windowsRemoteEnv(home, over),
        runtime: windowsRuntime(zip),
        archive: { version: WIN_NODE_V, file: WIN_NODE_FILE, bytes: zip },
        packages: (v) => windowsPackages(v, { mjs: fakeServe(v, { installInfo: INSTALL_INFO }), serve: SERVE_SHIM }, true),
      }
    },
  })
})

// A Linux remote played by this machine's sh (see update.test.ts)
describe.skipIf(process.platform === 'win32')('pnpm remote-dev against a Linux machine over a fake ssh into a real sh (#1036)', () => {
  const NODE_V = '24.21.0'
  const NODE_FILE = `node-v${NODE_V}-linux-x64.tar.gz`
  wholeCommand({
    shell: 'posix',
    prepare: async (root, home) => {
      const bin = join(root, 'bin')
      mkdirSync(bin, { recursive: true })
      const tool = (name: string, body: string) => {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
        chmodSync(join(bin, name), 0o755)
      }
      tool('uname', 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) /usr/bin/uname "$@" ;; esac')
      tool('getconf', 'echo "glibc 2.39"')
      writeFileSync(
        join(root, 'ssh'),
        `#!${process.execPath}\nconst r = require('node:child_process').spawnSync('/bin/sh', ['-c', process.argv.at(-1)], { stdio: 'inherit' })\nprocess.exit(r.status ?? 1)\n`,
      )
      chmodSync(join(root, 'ssh'), 0o755)
      const archive = tarGz(`node-v${NODE_V}-linux-x64`, { 'bin/node': { text: `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, mode: 0o755 }, LICENSE: 'MIT' })
      // git is found where this machine has it; the fake tools come first
      const gitDir = dirname(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim())
      return {
        ssh: join(root, 'ssh'),
        env: (over = {}) => ({ HOME: home, PATH: `${bin}:${gitDir}:/usr/bin:/bin:/usr/sbin:/sbin`, ...over }),
        runtime: { node: { version: NODE_V, archives: { 'linux-x64': { file: NODE_FILE, sha256: sha256(archive) } } } },
        archive: { version: NODE_V, file: NODE_FILE, bytes: archive },
        packages: (v): FakePackage[] => [
          { name: 'centralu', version: v, files: { 'package.json': JSON.stringify({ name: 'centralu', version: v }), 'bin/centralu.mjs': fakeServe(v, { installInfo: INSTALL_INFO }), 'bin/serve.mjs': SERVE_SHIM } },
          { name: '@centralu/host-linux-x64', version: v, files: { 'package.json': '{}', 'host/main.mjs': 'export {}\n' } },
        ],
      }
    },
  })
})
