import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeServe, tarGz } from './fake-registry.test-helpers.js'
import { connectionCommand } from './tunnel.js'
import { WIN_NODE_FILE, WIN_NODE_V, windowsPackages, windowsRemoteEnv, pwsh7ModulePath } from './windows-remote.test-helpers.js'
import { SLOW } from '../../../../tooling/test-timing.js'
import { windowsRemote, SERVE_SHIM } from './install-windows.test-helpers.js'

/**
 * Installing on a Windows machine: Node, the packages, the launcher and what it refuses.
 * (the setup is install-windows.test-helpers.ts; the suite was one file, install-windows.test.ts)
 */

// The install scripts ask the machine for its architecture, and only x64 Windows has a build
describe.runIf(process.platform === 'win32' && process.arch === 'x64')('installing on and updating a Windows machine over a fake ssh into a real PowerShell', () => {
  const w = windowsRemote()
  const { remote, install } = w

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
      const out = execFileSync(connectionCommand({ shell: 'powershell' }), { shell: true, env: windowsRemoteEnv(w.home), encoding: 'utf8' })
      expect(JSON.parse(out.trim().split(/\r?\n/).at(-1)!)).toEqual({ ran: '9.8.0', argv: ['serve', '--connection'], managed: '1' })
    }, 120_000 * SLOW)

    it('installs when Windows PowerShell was started from PowerShell 7 and inherited its module path (GitHub runners, an OpenSSH DefaultShell of pwsh)', async () => {
      // Without the reset the install script's Get-FileHash was "found in the module … but the module could not be loaded"
      const r = await install('9.9.4', { env: { PSModulePath: pwsh7ModulePath(w.root) } })
      expect(r.current).toEqual({ version: '9.9.4', node: WIN_NODE_V })
      expect(existsSync(remote('node', `v${WIN_NODE_V}`, 'node.exe'))).toBe(true)
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.4 ${WIN_NODE_V}\n`)
    }, 120_000 * SLOW)

    it('a version with a host-only package installs that one and never downloads the platform package (owner decision 2)', async () => {
      const hits = w.reg.hits.length
      const r = await install('9.9.4')
      expect(r.current).toEqual({ version: '9.9.4', node: WIN_NODE_V })
      const asked = w.reg.hits.slice(hits)
      expect(asked).toContain('/@centralu/host-win32-x64/-/host-win32-x64-9.9.4.tgz')
      expect(asked.filter((h) => h.startsWith('/@centralu/win32-x64/'))).toEqual([])
      expect(existsSync(remote('versions', '9.9.4', 'node_modules', '@centralu', 'host-win32-x64', 'host', 'main.mjs'))).toBe(true)
      expect(existsSync(remote('versions', '9.9.4', 'node_modules', '@centralu', 'win32-x64'))).toBe(false)
    }, 120_000 * SLOW)

    it('refuses a Node archive whose SHA-256 is not the pinned one, and leaves nothing', async () => {
      const wrong = { node: { version: WIN_NODE_V, archives: { 'win32-x64': { file: WIN_NODE_FILE, sha256: 'f'.repeat(64) } } } }
      await expect(install('9.9.4', { runtime: wrong })).rejects.toThrow(/does not match the SHA-256 this Centralu release pinned/)
      expect(existsSync(remote('node'))).toBe(false)
      expect(existsSync(remote('current'))).toBe(false)
      expect(readdirSync(remote()).filter((n) => n.startsWith('.'))).toEqual([])
    }, 120_000 * SLOW)

    it('refuses a package whose bytes are not what the signed metadata names, and keeps what runs', async () => {
      await install('9.9.1')
      w.reg.swapTarball('@centralu/win32-x64@9.9.6', tarGz('package', { 'Centralu/resources/host/main.mjs': 'someone else’s host' }))
      try {
        await expect(install('9.9.6')).rejects.toThrow(/@centralu\/win32-x64 downloaded on box does not match the integrity the npm registry signed/)
      } finally {
        w.reg.swapTarball('@centralu/win32-x64@9.9.6', tarGz('package', windowsPackages('9.9.6', { mjs: fakeServe('9.9.6'), serve: SERVE_SHIM }, false)[1]!.files))
      }
      expect(existsSync(remote('versions', '9.9.6'))).toBe(false)
      expect(readFileSync(remote('current'), 'utf8')).toBe(`9.9.1 ${WIN_NODE_V}\n`)
      expect(readdirSync(remote()).filter((n) => n.startsWith('.'))).toEqual([])
    }, 120_000 * SLOW)

    it('refuses before downloading anything when registry metadata fails its signature', async () => {
      const hits = w.reg.hits.length
      w.reg.forgeSignature('centralu@9.9.7')
      await expect(install('9.9.7')).rejects.toThrow(/signature on centralu@9\.9\.7 does not check out/)
      expect(w.reg.hits.slice(hits).filter((h) => h.startsWith('/dist/') || h.endsWith('.tgz'))).toEqual([])
      expect(existsSync(remote('node'))).toBe(false)
    }, 120_000 * SLOW)
  })
})
