import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeExe, fakeNodeExe } from '../fake-exe.test-helpers.js'
import { sha256, type FakePackage } from './fake-registry.test-helpers.js'
import type { RemoteRuntime } from './install.js'
import { PS_PREAMBLE, type RemoteCommand, type RemoteRun } from './tunnel.js'

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

/** What the fake ssh prints when it could not run the command or the command was ended: no status, and not a bare exit 1 (#1244) */
export const FAKE_SSH_MARK = 'fake ssh: '

/** Windows OpenSSH runs the command line it is given through cmd.exe; so does `shell: true` */
const SSH = `const r = require('node:child_process').spawnSync(process.argv.at(-1), { shell: true, stdio: 'inherit' })
if (r.error || r.status === null) console.error(${JSON.stringify(FAKE_SSH_MARK)} + (r.error ? r.error.message : 'the command was ended by ' + r.signal))
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
  const set = { USERPROFILE: home, HOME: home, CC_DATA_DIR: join(home, '.centralu'), CC_FAKE_NODE: process.execPath, ...over }
  // Windows names are not case-sensitive: `Path` and `PATH` are one variable, and two spellings in one block are a coin toss
  for (const k of Object.keys(env)) if (Object.keys(set).some((s) => s.toLowerCase() === k.toLowerCase())) delete env[k]
  return { ...env, ...set }
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

/**
 * The script a command for the remote runs, as text, for a failing test's report: the `-EncodedCommand` decoded (or the
 * script it sends on stdin), without the preamble every script starts with, on one line.
 */
export function remoteScriptText(c: RemoteCommand): string {
  const encoded = /-EncodedCommand (\S+)/.exec(typeof c === 'string' ? c : c.command)?.[1]
  let script = encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : typeof c === 'string' ? c : c.command
  if (typeof c !== 'string') script = Buffer.from(c.stdin.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8')
  if (script.startsWith(PS_PREAMBLE)) script = script.slice(PS_PREAMBLE.length)
  const line = script.replace(/\s+/g, ' ').trim()
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

/**
 * Windows PowerShell's stderr with its CLIXML made readable: the error records' text (`<S S="Error">`, with `_x000D__x000A_`
 * for a line break), and none of the progress records ("Preparing modules for first use"). What a command PowerShell ran
 * wrote to stderr itself lands between the `#< CLIXML` header and the records, and is kept.
 */
export function clixmlErrors(stderr: string): string {
  const errors = [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) =>
    m[1]!.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
  )
  const plain = stderr.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/^#< CLIXML\r?$/gm, '').trim()
  return [plain, errors.join('')].filter(Boolean).join('\n')
}

/**
 * The module path a Windows PowerShell inherits when it is started from PowerShell 7 (pwsh), as on
 * GitHub's runners and on a Windows machine whose OpenSSH `DefaultShell` is pwsh: PowerShell 7's own
 * module folder comes first, with the 7.x copies of the built-in modules. Windows PowerShell 5.1 finds
 * `Microsoft.PowerShell.Utility` 7.x there, cannot load it, and `Get-FileHash`, `ConvertTo-Json`,
 * `Invoke-WebRequest` and `Expand-Archive` are gone ("found in the module … but the module could not
 * be loaded"). The modules here are stand-ins of that shape (a Core-only manifest, a version above
 * 5.1's, a binary that is not there), so no PowerShell 7 has to be installed to see it.
 */
export function pwsh7ModulePath(dir: string): string {
  const mod = join(dir, 'pwsh7', 'Modules')
  for (const [name, guid, cmdlets] of [
    ['Microsoft.PowerShell.Utility', '1da87e53-152b-403e-98dc-74d7b4d63d59', ['Get-FileHash', 'ConvertTo-Json', 'ConvertFrom-Json', 'Invoke-WebRequest', 'Invoke-RestMethod']],
    ['Microsoft.PowerShell.Archive', 'eb74e8da-9ae2-482a-a648-e96550fb8733', ['Expand-Archive', 'Compress-Archive']],
    ['CimCmdlets', 'fb6cc51d-c096-4b38-b78d-0fed6277e8d0', ['Invoke-CimMethod', 'Get-CimInstance']],
  ] as const) {
    mkdirSync(join(mod, name), { recursive: true })
    writeFileSync(
      join(mod, name, `${name}.psd1`),
      `@{ ModuleVersion = '7.0.0.0'; GUID = '${guid}'; CompatiblePSEditions = @('Core'); PowerShellVersion = '7.0'; RootModule = '${name}.dll'; CmdletsToExport = @(${cmdlets.map((c) => `'${c}'`).join(', ')}) }\r\n`,
    )
  }
  // Then the rest of what pwsh puts in the variable
  return [mod, join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', 'Modules'), process.env.PSModulePath ?? ''].join(';')
}

/**
 * Whether a command on the stand-in remote ended without a word: a non-zero exit, nothing on stdout, and on stderr
 * nothing but PowerShell's progress records and what the fake ssh says of a command it could not run (`FAKE_SSH_MARK`).
 * Every script Centralu runs there says something when it fails (a `CENTRALU-INSTALL fail …` line, a JSON line with
 * `ok: false`, `Centralu: no version is installed` on stderr, PowerShell's errors in CLIXML), so what is left is a
 * process that was ended, crashed (Windows PowerShell started with `-EncodedCommand` exits 1 when its last command
 * failed, whatever the exit code of that command) or never ran, and not an answer.
 *
 * It happened on GitHub's windows-2022 runners in install-windows.test.ts (#1244): three times in one afternoon, exit 1
 * and nothing printed, after 3 to 8 seconds, from a different command each time (the stop of the old host, the install
 * step of the next version). No wall-clock bound is involved: production's stop has none beyond `SSH_EXEC_TIMEOUT_MS`
 * (30 minutes). It has not been seen on a development machine (22 runs of the file under load, 3,900 runs of the stop
 * alone on two cores), so the cause is not known. Both commands run the `node.exe` of the remote's Node folder, and
 * a scanner holding a freshly unpacked file was seen on those runners before (#1133): a guess, not a finding.
 *
 * Production does not rerun anything: there the person reads "gave no answer (exit 1)" and tries again. Whether a real
 * machine ends a command like this is not known either.
 */
export function diedSilently(r: RemoteRun): boolean {
  const said = clixmlErrors(r.stderr)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.startsWith(FAKE_SSH_MARK))
  return r.code !== 0 && r.stdout.trim() === '' && said.length === 0
}

/**
 * `exec`, run again (up to `attempts` runs in all) when the command died silently (`diedSilently`). For a stand-in
 * remote only. The commands of install, update, rollback and uninstall look at the machine's state and leave it right,
 * so a second run is an ordinary run; one that died after it had changed something shows in the test's own checks
 * (the fake's `events`), as a failure with its own message, not as a pass. The run that finally answers is returned
 * as it is, so a command that fails says why and one that dies every time still fails. `onDied` hears of each death.
 */
export async function execThroughSilentDeath(
  exec: (c: RemoteCommand) => Promise<RemoteRun>,
  command: RemoteCommand,
  o: { attempts?: number; onDied?: (r: RemoteRun, attempt: number) => void } = {},
): Promise<RemoteRun> {
  const attempts = o.attempts ?? 3
  for (let attempt = 1; ; attempt++) {
    const r = await exec(command)
    if (attempt >= attempts || !diedSilently(r)) return r
    o.onDied?.(r, attempt)
  }
}
