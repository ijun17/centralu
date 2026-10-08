#!/usr/bin/env node
/* global process, console, Buffer */
/**
 * Runs install-probe.ps1 or install-probe.sh on a remote over the person's own ssh, the way
 * links/tunnel.ts crosses each shell: PowerShell gets `-EncodedCommand` (UTF-16LE base64), WSL gets a
 * base64 script fed to bash inside the distro, a POSIX remote gets it on stdin. Throwaway, for
 * docs/plans/remote-hub.md §10.
 *
 *   node run-probe.mjs <ssh target> <powershell|wsl:<distro>|posix> <mode> [key=value ...]
 *
 * Keys: root (the probe folder on the remote; required), node (Node version), centralu (Centralu
 * version), launch (for `serve`), cmd (for `wmi`), ssh (extra ssh options, space separated).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [target, shell, mode, ...rest] = process.argv.slice(2)
if (!target || !shell || !mode) {
  console.error('usage: node run-probe.mjs <ssh target> <powershell|wsl:<distro>|posix> <mode> [key=value ...]')
  process.exit(2)
}
const kv = Object.fromEntries(rest.map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]))
const nodeV = kv.node ?? '24.21.0'
const centraluV = kv.centralu ?? '0.1.0-beta.12'
if (!kv.root || !/^[A-Za-z0-9._\\/:-]+$/.test(kv.root)) throw new Error('root= is required and must be a plain path')
const sshOpts = (kv.ssh ?? '').split(' ').filter(Boolean)

let remoteCommand
let input
if (shell === 'powershell') {
  const vars =
    `$Root = '${kv.root}'; $NodeV = '${nodeV}'; $CentraluV = '${centraluV}'; $Mode = '${mode}'; $Launch = '${kv.launch ?? ''}'; $Cmd = '${(kv.cmd ?? '').replaceAll("'", "''")}'\n`
  const body = readFileSync(join(here, 'install-probe.ps1'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
  const encoded = Buffer.from(vars + body, 'utf16le').toString('base64')
  remoteCommand = `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`
} else {
  const vars = `ROOT='${kv.root}'; NODE_V='${nodeV}'; CENTRALU_V='${centraluV}'; MODE='${mode}'; LAUNCH='${kv.launch ?? ''}'\n`
  const body = readFileSync(join(here, 'install-probe.sh'), 'utf8')
  const b64 = Buffer.from(vars + body, 'utf8').toString('base64')
  if (shell.startsWith('wsl:')) {
    const distro = shell.slice(4)
    if (!/^[A-Za-z0-9._-]+$/.test(distro)) throw new Error('bad distro')
    // Through Windows' PowerShell, as tunnel.ts does: only base64 crosses the quoting layers
    const ps = `wsl.exe -d '${distro}' -- bash -c 'echo ${b64} | base64 -d | bash'`
    remoteCommand = `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`
  } else {
    remoteCommand = 'bash -s'
    input = vars + body
  }
}
const r = spawnSync('ssh', [...sshOpts, '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '--', target, remoteCommand], {
  input,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: 20 * 60 * 1000,
})
process.stdout.write((r.stdout ?? '').replaceAll('\0', ''))
if (r.stderr) process.stderr.write(r.stderr.replace(/#< CLIXML[\s\S]*$/, '').replaceAll('\0', ''))
console.error(`[run-probe] ssh exit ${r.status ?? r.signal} (command ${remoteCommand.length} chars)`)
process.exit(r.status ?? 1)
