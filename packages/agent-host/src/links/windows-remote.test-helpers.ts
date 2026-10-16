import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeExe, fakeNodeExe } from '../fake-exe.test-helpers.js'
import { sha256, type FakePackage } from './fake-registry.test-helpers.js'
import type { RemoteRuntime } from './install.js'

/**
 * This Windows machine playing the Windows machine a hub links to (docs/plans/remote-hub.md §10), for
 * the install and update tests: a fake `ssh.exe` hands the command to `cmd.exe` as Windows OpenSSH does
 * (its default shell), the command is the hub's real `powershell -EncodedCommand`, and everything it
 * runs is real: PowerShell 5.1, System32's `curl.exe` and `tar.exe`, `remote-install.mjs`, and the
 * managed `centralu.cmd` launcher. Only the registry (loopback) and the pinned Node are stand-ins: the
 * archive carries a `node.exe` that is the fake-exe launcher, which runs this machine's Node.
 */

export const WIN_NODE_V = '24.21.0'
export const WIN_NODE_FILE = `node-v${WIN_NODE_V}-win-x64.zip`

/** Windows OpenSSH runs the command line it is given through cmd.exe; so does `shell: true` */
const SSH = `const r = require('node:child_process').spawnSync(process.argv.at(-1), { shell: true, stdio: 'inherit' })
process.exit(r.status ?? 1)
`

/** The `ssh.exe` to give `SshTunnel` as `ssh` */
export function windowsRemoteSsh(dir: string): string {
  return fakeExe(dir, 'ssh', SSH)
}

/**
 * The "pinned Node" zip as nodejs.org ships it: one top folder, `node.exe` and a licence in it. Packed by
 * System32's own `tar.exe`, which writes a zip for `-a` and reads it back in the install script
 */
export function windowsNodeZip(): Buffer {
  const top = `node-v${WIN_NODE_V}-win-x64`
  const dir = mkdtempSync(join(tmpdir(), 'cc-node-zip-'))
  try {
    mkdirSync(join(dir, top))
    writeFileSync(join(dir, top, 'node.exe'), fakeNodeExe())
    writeFileSync(join(dir, top, 'LICENSE'), 'MIT')
    writeFileSync(join(dir, top, 'npm.cmd'), 'a Node install carries npm, which the remote does not keep')
    execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', 'node.zip', top], { cwd: dir })
    return readFileSync(join(dir, 'node.zip'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function windowsRuntime(zip: Buffer): RemoteRuntime {
  return { node: { version: WIN_NODE_V, archives: { 'win32-x64': { file: WIN_NODE_FILE, sha256: sha256(zip) } } } }
}

/**
 * What the remote's shell sees: this machine's environment with the profile and data folder moved into
 * `home`, so nothing is written to the person's own. `CC_FAKE_NODE` is the Node its `node.exe` runs.
 */
export function windowsRemoteEnv(home: string, over: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { ...env, USERPROFILE: home, HOME: home, CC_DATA_DIR: join(home, '.centralu'), CC_FAKE_NODE: process.execPath, ...over }
}

/**
 * The packages of one version for a Windows remote: the shim (`centralu`, with `centralu.mjs` and
 * `serve.mjs`), the platform package with the window in it, and optionally the host-only package
 */
export function windowsPackages(version: string, centralu: { mjs: string; serve: string }, hostOnly: boolean): FakePackage[] {
  return [
    { name: 'centralu', version, files: { 'package.json': JSON.stringify({ name: 'centralu', version }), 'bin/centralu.mjs': centralu.mjs, 'bin/serve.mjs': centralu.serve } },
    {
      name: '@centralu/win32-x64',
      version,
      files: { 'package.json': JSON.stringify({ name: '@centralu/win32-x64', version }), 'Centralu/resources/host/main.mjs': 'export {}\n', 'Centralu/centralu.exe': 'the window, which a remote never runs' },
    },
    ...(hostOnly ? [{ name: '@centralu/host-win32-x64', version, files: { 'package.json': JSON.stringify({ name: '@centralu/host-win32-x64', version }), 'host/main.mjs': 'export {}\n' } }] : []),
  ]
}
