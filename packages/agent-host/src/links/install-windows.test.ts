import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeRegistry, fakeServe, tarGz, type FakeRegistry } from './fake-registry.test-helpers.js'
import { installRemote, installScript, type RemoteRuntime } from './install.js'
import { connectionCommand, SshTunnel } from './tunnel.js'
import { rollbackRemote, uninstallRemote, updateRemote, type HostControl, type UpdateStep } from './update.js'
import { rmFakeDir } from '../fake-exe.test-helpers.js'
import { WIN_NODE_FILE, WIN_NODE_V, windowsNodeZip, windowsPackages, windowsRemoteEnv, windowsRemoteSsh, windowsRuntime } from './windows-remote.test-helpers.js'

/**
 * This computer as the Windows machine a hub installs on and updates (plan §10.2, §10.5): the
 * counterpart of the `sh` suites in install.test.ts and update.test.ts. The hub's command is its real
 * `powershell -EncodedCommand`, run through cmd.exe as Windows OpenSSH runs it, so the PowerShell
 * install scripts, System32's `curl.exe` and `tar.exe`, `remote-install.mjs` on Windows, and the
 * managed `centralu.cmd` launcher all run for real (windows-remote.test-helpers.ts says what is a stand-in).
 */

const SERVE_MJS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packaging/npm/centralu/bin/serve.mjs')
const SERVE_SHIM = `export { managedLauncherScript } from ${JSON.stringify(pathToFileURL(SERVE_MJS).href)}\n`
const RUN_IT = (version: string) => `console.log(JSON.stringify({ ran: '${version}', argv: process.argv.slice(2), managed: process.env.CENTRALU_MANAGED ?? null }))\n`

// The install scripts ask the machine for its architecture, and only x64 Windows has a build
describe.runIf(process.platform === 'win32' && process.arch === 'x64')('installing on and updating a Windows machine over a fake ssh into a real PowerShell', () => {
  let root: string
  let home: string
  let reg: FakeRegistry
  let runtime: RemoteRuntime

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-winremote-'))
    home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    windowsRemoteSsh(root)
    const zip = windowsNodeZip()
    // 9.9.1 to 9.9.3 as published before the host-only packages; 9.9.4 and 9.9.5 with one
    const serve = (v: string) => ({ mjs: fakeServe(v), serve: SERVE_SHIM })
    reg = await fakeRegistry([
      ...windowsPackages('9.9.1', serve('9.9.1'), false),
      ...windowsPackages('9.9.2', serve('9.9.2'), false),
      ...windowsPackages('9.9.3', serve('9.9.3'), false),
      // The one whose tarball a test swaps: its bytes are not the ones the signed metadata names afterwards
      ...windowsPackages('9.9.6', serve('9.9.6'), false),
      // The one whose metadata a test forges, for good
      ...windowsPackages('9.9.7', serve('9.9.7'), false),
      ...windowsPackages('9.9.4', { mjs: RUN_IT('9.9.4'), serve: SERVE_SHIM }, true),
      ...windowsPackages('9.9.5', { mjs: RUN_IT('9.9.5'), serve: SERVE_SHIM }, true),
      // The lookup test runs this one: a version whose centralu.mjs only says it ran
      ...windowsPackages('9.8.0', { mjs: RUN_IT('9.8.0'), serve: SERVE_SHIM }, false),
    ])
    reg.addNodeArchive(WIN_NODE_V, WIN_NODE_FILE, zip)
    runtime = windowsRuntime(zip)
  }, 120_000)
  afterAll(async () => {
    await reg.close()
    rmFakeDir(root)
  })
  afterEach(() => rmFakeDir(join(home, '.centralu')))

  const data = (...p: string[]) => join(home, '.centralu', ...p)
  const remote = (...p: string[]) => data('remote', ...p)
  const events = () => (existsSync(data('events')) ? readFileSync(data('events'), 'utf8').trim().split('\n') : [])
  const running = () => (existsSync(data('running')) ? readFileSync(data('running'), 'utf8') : null)
  const tunnel = (env: Record<string, string> = {}) => new SshTunnel({ target: 'box', remote: { shell: 'powershell' }, ssh: join(root, 'ssh.exe'), env: windowsRemoteEnv(home, env) })
  const install = (version: string, o: { runtime?: RemoteRuntime } = {}) => {
    const t = tunnel()
    return installRemote({ exec: (c) => t.exec(c), spec: { shell: 'powershell' }, target: 'box', version, runtime: o.runtime ?? runtime, script: installScript(), registry: { registry: reg.url }, nodeDist: `${reg.url}/dist` })
  }

  describe('installing', () => {
    it('installs Node pruned and the packages beside it, writes the .cmd launcher and current, and the lookup runs it', async () => {
      const r = await install('9.8.0')
      expect(r).toEqual({ current: { version: '9.8.0', node: WIN_NODE_V }, previous: null, removed: [], left: [] })
      // Node: the binary and its licence, nothing of npm (plan S6)
      expect(readdirSync(remote('node', `v${WIN_NODE_V}`)).sort()).toEqual(['LICENSE', 'node.exe'])
      // A version published before the host-only packages: the platform package, its window thrown away
      const pkg = remote('versions', '9.8.0', 'node_modules', '@centralu', 'win32-x64', 'Centralu')
      expect(existsSync(join(pkg, 'resources', 'host', 'main.mjs'))).toBe(true)
      expect(existsSync(join(pkg, 'centralu.exe'))).toBe(false)
      expect(JSON.parse(readFileSync(remote('versions', '9.8.0', 'install.json'), 'utf8'))).toMatchObject({ version: '9.8.0', node: WIN_NODE_V, platform: 'win32-x64' })
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.8.0 ${WIN_NODE_V}\n`)
      expect(existsSync(remote('bin', 'centralu.cmd'))).toBe(true)
      // Nothing half-done is left behind
      expect(readdirSync(remote()).filter((n) => n.startsWith('.'))).toEqual([])
      // The hub's lookup, in PowerShell as ssh would start it, now finds the managed launcher, which
      // runs current's centralu.mjs on the Node current names
      const out = execFileSync(connectionCommand({ shell: 'powershell' }), { shell: true, env: windowsRemoteEnv(home), encoding: 'utf8' })
      expect(JSON.parse(out.trim().split(/\r?\n/).at(-1)!)).toEqual({ ran: '9.8.0', argv: ['serve', '--connection'], managed: '1' })
    }, 120_000)

    it('a version with a host-only package installs that one and never downloads the platform package (owner decision 2)', async () => {
      const hits = reg.hits.length
      const r = await install('9.9.4')
      expect(r.current).toEqual({ version: '9.9.4', node: WIN_NODE_V })
      const asked = reg.hits.slice(hits)
      expect(asked).toContain('/@centralu/host-win32-x64/-/host-win32-x64-9.9.4.tgz')
      expect(asked.filter((h) => h.startsWith('/@centralu/win32-x64/'))).toEqual([])
      expect(existsSync(remote('versions', '9.9.4', 'node_modules', '@centralu', 'host-win32-x64', 'host', 'main.mjs'))).toBe(true)
      expect(existsSync(remote('versions', '9.9.4', 'node_modules', '@centralu', 'win32-x64'))).toBe(false)
    }, 120_000)

    it('refuses a Node archive whose SHA-256 is not the pinned one, and leaves nothing', async () => {
      const wrong = { node: { version: WIN_NODE_V, archives: { 'win32-x64': { file: WIN_NODE_FILE, sha256: 'f'.repeat(64) } } } }
      await expect(install('9.9.4', { runtime: wrong })).rejects.toThrow(/does not match the SHA-256 this Centralu release pinned/)
      expect(existsSync(remote('node'))).toBe(false)
      expect(existsSync(remote('current'))).toBe(false)
      expect(readdirSync(remote()).filter((n) => n.startsWith('.'))).toEqual([])
    }, 120_000)

    it('refuses a package whose bytes are not what the signed metadata names, and keeps what runs', async () => {
      await install('9.9.1')
      reg.swapTarball('@centralu/win32-x64@9.9.6', tarGz('package', { 'Centralu/resources/host/main.mjs': 'someone else’s host' }))
      try {
        await expect(install('9.9.6')).rejects.toThrow(/@centralu\/win32-x64 downloaded on box does not match the integrity the npm registry signed/)
      } finally {
        reg.swapTarball('@centralu/win32-x64@9.9.6', tarGz('package', windowsPackages('9.9.6', { mjs: fakeServe('9.9.6'), serve: SERVE_SHIM }, false)[1]!.files))
      }
      expect(existsSync(remote('versions', '9.9.6'))).toBe(false)
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      expect(readdirSync(remote()).filter((n) => n.startsWith('.'))).toEqual([])
    }, 120_000)

    it('refuses before downloading anything when registry metadata fails its signature', async () => {
      const hits = reg.hits.length
      reg.forgeSignature('centralu@9.9.7')
      await expect(install('9.9.7')).rejects.toThrow(/signature on centralu@9\.9\.7 does not check out/)
      expect(reg.hits.slice(hits).filter((h) => h.startsWith('/dist/') || h.endsWith('.tgz'))).toEqual([])
      expect(existsSync(remote('node'))).toBe(false)
    }, 120_000)
  })

  describe('updating, rolling back and uninstalling', () => {
    /** A HostControl as LinkedMachine gives one, with this machine as the remote; what it saw is kept */
    const control = (env: Record<string, string> = {}) => {
      const t = tunnel(env)
      const seen: string[] = []
      const c: HostControl = {
        exec: (cmd) => t.exec(cmd),
        spec: { shell: 'powershell' },
        target: 'box',
        script: installScript(),
        hold: () => void seen.push('hold'),
        start: async () => {
          const how = await t.startHost()
          if (how.how !== 'detached') throw new Error('not detached')
        },
        answers: async (version) => {
          seen.push(`answers ${version}`)
          return running() === version
        },
        step: (s: UpdateStep) => void seen.push(s),
      }
      return { c, seen }
    }
    const update = (version: string, env?: Record<string, string>) => {
      const { c, seen } = control(env)
      return { seen, done: updateRemote(c, { version, runtime, registry: { registry: reg.url }, nodeDist: `${reg.url}/dist` }) }
    }
    /** 9.9.1 installed by the hub and running, as after an earlier install and a link that started it */
    const installedAndRunning = async () => {
      const { c } = control()
      await install('9.9.1')
      await c.start()
      expect(running()).toBe('9.9.1')
      rmSync(data('events'))
    }

    it('installs beside, stops the old host before switching, starts the new one, checks it, then prunes', async () => {
      await installedAndRunning()
      const { seen, done } = update('9.9.2')
      expect(await done).toMatchObject({ current: { version: '9.9.2', node: WIN_NODE_V }, previous: { version: '9.9.1', node: WIN_NODE_V } })
      // The old version stopped itself, through its own launcher, then the new one started
      expect(events()).toEqual(['stop 9.9.1', 'start 9.9.2'])
      expect(running()).toBe('9.9.2')
      expect(seen).toEqual(['preflight', 'registry', 'node', 'centralu', 'hold', 'stop', 'switch', 'start', 'check', 'answers 9.9.2', 'prune'])
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.2 ${WIN_NODE_V}\n`)
      expect(readFileSync(remote('previous'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      // A third version removes the first only once it answered
      expect(await update('9.9.3').done).toMatchObject({ current: { version: '9.9.3' }, previous: { version: '9.9.2' }, removed: ['9.9.1'] })
      expect(readdirSync(remote('versions')).sort()).toEqual(['9.9.2', '9.9.3'])
    }, 180_000)

    it('names a version folder a running program holds, instead of failing, and removes it once the program is gone', async () => {
      await installedAndRunning()
      await update('9.9.2').done
      // A program running from 9.9.1's folder, as a host that has not yet stopped is: Windows will not remove a folder that is some program's working directory
      const holder = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: remote('versions', '9.9.1'), stdio: 'ignore' })
      try {
        const r = await update('9.9.3').done
        expect(r).toMatchObject({ current: { version: '9.9.3' }, previous: { version: '9.9.2' } })
        expect(r.removed).not.toContain('9.9.1')
        expect(r.left).toContain('9.9.1')
        expect(existsSync(remote('versions', '9.9.3', 'install.json'))).toBe(true)
      } finally {
        holder.kill()
        await new Promise((r) => (holder.exitCode !== null ? r(null) : holder.once('exit', r)))
      }
      // The next update's prune takes it
      expect(await update('9.9.1').done).toMatchObject({ current: { version: '9.9.1' } })
    }, 240_000)

    it('puts the old version back and starts it when the new one does not answer, with the end of its log', async () => {
      await installedAndRunning()
      const { seen, done } = update('9.9.2', { FAKE_BROKEN: '9.9.2' })
      await expect(done).rejects.toThrow(
        /Centralu 9\.9\.2 did not start on box \(the host exited before it answered\); it runs Centralu 9\.9\.1 again\. The end of its host\.log: host 9\.9\.2: the store was written by a newer Centralu/,
      )
      expect(seen.slice(-5)).toEqual(['hold', 'stop', 'switch', 'start', 'roll_back'])
      expect(events()).toEqual(['stop 9.9.1', 'start 9.9.2', 'stop -', 'start 9.9.1'])
      expect(running()).toBe('9.9.1')
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      expect(existsSync(remote('previous'))).toBe(false)
      expect(readdirSync(remote('versions')).sort()).toEqual(['9.9.1', '9.9.2'])
    }, 180_000)

    it('rolls back one step: previous becomes current, and there is no previous left to go back to', async () => {
      await installedAndRunning()
      await update('9.9.2').done
      rmSync(data('events'))
      const { c, seen } = control()
      const r = await rollbackRemote(c, { current: { version: '9.9.2', node: WIN_NODE_V }, previous: { version: '9.9.1', node: WIN_NODE_V } })
      expect(r).toEqual({ current: { version: '9.9.1', node: WIN_NODE_V }, previous: null, removed: [], left: [] })
      expect(seen).toEqual(['hold', 'stop', 'switch', 'start', 'check', 'answers 9.9.1'])
      expect(events()).toEqual(['stop 9.9.2', 'start 9.9.1'])
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      expect(existsSync(remote('previous'))).toBe(false)
    }, 180_000)

    it('uninstalls: stops the host, removes <data>\\remote, keeps the rest of the data', async () => {
      await installedAndRunning()
      writeFileSync(data('serve.json'), '{"token":"t"}')
      writeFileSync(data('autostart'), 'on')
      const { c, seen } = control()
      expect(await uninstallRemote(c)).toEqual({ stopped: true })
      expect(seen).toEqual(['hold', 'stop', 'autostart', 'remove'])
      // The boot entry goes, through the Centralu it would start, after the host stopped and before its files go
      expect(events()).toEqual(['stop 9.9.1', 'autostart off'])
      expect(existsSync(data('autostart'))).toBe(false)
      expect(existsSync(remote())).toBe(false)
      expect(existsSync(data('serve.json'))).toBe(true)
      expect(running()).toBeNull()
    }, 120_000)
  })
})
